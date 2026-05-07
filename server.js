require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { runAutomation } = require('./automation');

const app = express();
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

// Stripe Pricing Configuration
const PLANS = {
  day: { name: 'Day Key', price: 250 }, // in cents
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
    const { planId, addons = [] } = req.body;
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
      success_url: `${process.env.FRONTEND_URL}/dashboard?status=success`,
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
