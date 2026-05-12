require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

console.log('Stripe Key from ENV:', process.env.STRIPE_SECRET_KEY ? process.env.STRIPE_SECRET_KEY.substring(0, 10) + '...' : 'UNDEFINED');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { runAutomation } = require('./automation');

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/silentstudy')
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('MongoDB Connection Error:', err));

// User Schema
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  isPaid: { type: Boolean, default: false },
  plan: String,
  addons: [String],
  expiryDate: Date,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

const app = express();
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

// Registration Endpoint
app.post('/register', async (req, res) => {
  try {
    const { email, password, plan, addons } = req.body;
    console.log('Registration request for:', email);
    
    // Check if user exists
    let user = await User.findOne({ email });
    if (user) {
      console.log('User found in DB, proceeding to payment session.');
      return res.json({ message: 'User already exists, proceeding to payment', userId: user._id });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    user = new User({ email, password: hashedPassword, plan, addons });
    await user.save();
    console.log('New user created:', email);

    res.json({ message: 'User registered', userId: user._id });
  } catch (err) {
    console.error('Registration Error:', err);
    res.status(500).json({ error: 'Server error during registration' });
  }
});
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "http://localhost:3000"],
    methods: ["GET", "POST"]
  }
});

// Verification Endpoint (Simplified for demo)
app.get('/verify-payment', async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'Missing UID' });

    const user = await User.findById(uid);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // In a real app, you would check Stripe API here.
    // For now, we'll just set them as paid if they hit this from the success URL.
    user.isPaid = true;
    
    // Set expiry based on plan
    const now = new Date();
    if (user.plan === 'day') user.expiryDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    else if (user.plan === 'week') user.expiryDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    else if (user.plan === 'month') user.expiryDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    else if (user.plan === 'six_month') user.expiryDate = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);

    await user.save();
    res.json({ success: true, isPaid: true });
  } catch (err) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Stripe Pricing Configuration
const PLANS = {
  day: { name: 'Day Key', price: 250 }, 
  week: { name: 'Week Key', price: 1000 },
  month: { name: 'Month Key', price: 2000 },
  six_month: { name: '6 Months Key', price: 4000 }
};

const ADDONS = {
  service: { name: 'Service Key', price: 500 },
  proctor: { name: 'Proctor Bypass', price: 1000 }
};

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { planId, addons = [], userId } = req.body;
    const plan = PLANS[planId];
    
    if (!plan) return res.status(400).json({ error: 'Invalid plan' });

    const line_items = [{
      price_data: {
        currency: 'usd',
        product_data: { name: `Silent Study - ${plan.name}` },
        unit_amount: plan.price,
      },
      quantity: 1,
    }];

    addons.forEach(addonId => {
      const addon = ADDONS[addonId];
      if (addon) {
        line_items.push({
          price_data: {
            currency: 'usd',
            product_data: { name: `Add-on: ${addon.name}` },
            unit_amount: addon.price,
          },
          quantity: 1,
        });
      }
    });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      metadata: { userId },
      success_url: `${process.env.FRONTEND_URL}/dashboard?status=success&uid=${userId}`,
      cancel_url: `${process.env.FRONTEND_URL}/#pricing`,
    });

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Stripe Error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

const instances = new Map();

io.on('connection', (socket) => {
  console.log('Client connected');

  socket.on('start-bot', async (data) => {
    const { username, password, url, courseName } = data;
    socket.emit('log', '🚀 Bot process started...');

    // Run automation and store the controller/instance if needed
    // For simplicity, we'll pass a 'getIsStopped' check to automation
    let isStopped = false;
    instances.set(socket.id, () => { isStopped = true; });

    await runAutomation(
      username,
      password,
      url || 'https://auth.edgenuity.com/Login/Login/Student',
      courseName,
      (msg) => socket.emit('log', msg),
      (state) => socket.emit('state', state),
      () => isStopped
    );

    socket.emit('bot-finished');
    instances.delete(socket.id);
  });

  socket.on('stop-bot', () => {
    const stopFn = instances.get(socket.id);
    if (stopFn) {
      stopFn();
      console.log(`Stop requested for ${socket.id}`);
    }
  });

  socket.on('disconnect', () => {
    const stopFn = instances.get(socket.id);
    if (stopFn) stopFn();
    instances.delete(socket.id);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
