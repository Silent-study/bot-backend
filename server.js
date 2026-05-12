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
const nodemailer = require('nodemailer');
const { runAutomation } = require('./automation');

const sendEmail = async (to, subject, html) => {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST?.trim(),
    port: Number(process.env.SMTP_PORT?.trim()),
    secure: Number(process.env.SMTP_PORT?.trim()) === 465,
    auth: {
      user: process.env.SMTP_USER?.trim(),
      pass: process.env.SMTP_PASS?.trim(),
    },
  });

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      html,
    });
    console.log('Email sent successfully to:', to);
  } catch (err) {
    console.error('Email sending failed:', err);
  }
};

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
  otp: String,
  otpExpiry: Date,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

const app = express();
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

// OTP Generation
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// 1. Send OTP for Registration
app.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body;
    const otp = generateOTP();
    const expiry = new Date(Date.now() + 10 * 60 * 1000); // 10 mins

    // Store temporary OTP in DB (or a separate OTP collection)
    // For simplicity, we'll use the User model but might need to handle partial users
    await User.findOneAndUpdate(
      { email },
      { otp, otpExpiry: expiry },
      { upsert: true }
    );

    const emailHtml = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0a0a0a; color: #ffffff; border: 1px solid #1a1a1a; border-radius: 12px; overflow: hidden;">
        <div style="background-color: #111111; padding: 30px; text-align: center; border-bottom: 1px solid #1a1a1a;">
          <h1 style="margin: 0; color: #3b82f6; font-size: 24px; letter-spacing: 1px;">SILENT STUDY</h1>
        </div>
        <div style="padding: 40px 30px;">
          <h2 style="margin-top: 0; color: #ffffff; font-size: 20px;">Verify Your Identity</h2>
          <p style="color: #a3a3a3; line-height: 1.6;">Please use the following verification code to finalize your request. This code is valid for 10 minutes.</p>
          <div style="background-color: #1a1a1a; padding: 20px; border-radius: 8px; text-align: center; margin: 30px 0; border: 1px solid #333;">
            <span style="font-size: 32px; font-weight: 800; letter-spacing: 5px; color: #3b82f6;">${otp}</span>
          </div>
          <p style="color: #525252; font-size: 13px; text-align: center;">If you didn't request this, you can safely ignore this email.</p>
        </div>
        <div style="background-color: #050505; padding: 20px; text-align: center; border-top: 1px solid #1a1a1a; font-size: 12px; color: #404040;">
          &copy; 2026 Silent Study LMS Automation. All rights reserved.
        </div>
      </div>
    `;

    await sendEmail(
      email,
      'Your Silent Study Verification Code',
      emailHtml
    );

    res.json({ success: true, message: 'OTP sent' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// 2. Forgot Password - Send OTP
app.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const otp = generateOTP();
    user.otp = otp;
    user.otpExpiry = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();

    const emailHtml = `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #0a0a0a; color: #ffffff; border: 1px solid #1a1a1a; border-radius: 12px; overflow: hidden;">
        <div style="background-color: #111111; padding: 30px; text-align: center; border-bottom: 1px solid #1a1a1a;">
          <h1 style="margin: 0; color: #3b82f6; font-size: 24px; letter-spacing: 1px;">SILENT STUDY</h1>
        </div>
        <div style="padding: 40px 30px;">
          <h2 style="margin-top: 0; color: #ffffff; font-size: 20px;">Reset Your Password</h2>
          <p style="color: #a3a3a3; line-height: 1.6;">We received a request to reset your password. Use the code below to set a new password.</p>
          <div style="background-color: #1a1a1a; padding: 20px; border-radius: 8px; text-align: center; margin: 30px 0; border: 1px solid #333;">
            <span style="font-size: 32px; font-weight: 800; letter-spacing: 5px; color: #ef4444;">${otp}</span>
          </div>
          <p style="color: #525252; font-size: 13px; text-align: center;">If you didn't request a password reset, please secure your account.</p>
        </div>
        <div style="background-color: #050505; padding: 20px; text-align: center; border-top: 1px solid #1a1a1a; font-size: 12px; color: #404040;">
          &copy; 2026 Silent Study LMS Automation. All rights reserved.
        </div>
      </div>
    `;

    await sendEmail(
      email,
      'Silent Study - Password Reset OTP',
      emailHtml
    );

    res.json({ success: true, message: 'Reset OTP sent' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// 3. Reset Password
app.post('/reset-password', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    const user = await User.findOne({ email, otp, otpExpiry: { $gt: Date.now() } });
    if (!user) return res.status(400).json({ error: 'Invalid or expired OTP' });

    user.password = await bcrypt.hash(newPassword, 10);
    user.otp = undefined;
    user.otpExpiry = undefined;
    await user.save();

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Reset failed' });
  }
});

// Registration Endpoint
app.post('/register', async (req, res) => {
  try {
    const { email, password, plan, addons, otp } = req.body;
    console.log('Registration request for:', email);
    
    // Verify OTP
    const userWithOtp = await User.findOne({ email, otp, otpExpiry: { $gt: Date.now() } });
    if (!userWithOtp) {
      return res.status(400).json({ error: 'Invalid or expired OTP. Please request a new one.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Update the temporary OTP record into a full user
    userWithOtp.password = hashedPassword;
    userWithOtp.plan = plan;
    userWithOtp.addons = addons;
    userWithOtp.otp = undefined; // Clear OTP after use
    userWithOtp.otpExpiry = undefined;
    
    await userWithOtp.save();
    console.log('User registered successfully with OTP:', email);

    res.json({ message: 'User registered', userId: userWithOtp._id });
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

    // Send Confirmation Email
    const confirmHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #ffffff; color: #1a1a1a; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.1);">
        <div style="background: linear-gradient(135deg, #2563eb 0%, #1e40af 100%); padding: 40px 20px; text-align: center;">
          <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 800; letter-spacing: 1px;">SILENT STUDY PRO</h1>
          <p style="color: rgba(255,255,255,0.8); margin-top: 10px; font-size: 16px;">Payment Confirmed Successfully</p>
        </div>
        <div style="padding: 40px 30px;">
          <h2 style="margin-top: 0; color: #111827; font-size: 22px;">Welcome Aboard!</h2>
          <p style="color: #4b5563; line-height: 1.6; font-size: 15px;">Your account has been upgraded. You now have full access to all premium automation features, including video skipping and EdgeEX support.</p>
          
          <div style="background-color: #f8fafc; padding: 25px; border-radius: 12px; margin: 30px 0; border: 1px solid #e2e8f0;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 12px; border-bottom: 1px solid #e2e8f0; padding-bottom: 12px;">
              <span style="color: #64748b; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">Current Plan</span>
              <span style="color: #1e293b; font-weight: 700; font-size: 15px;">${user.plan?.toUpperCase()} KEY</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding-top: 12px;">
              <span style="color: #64748b; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">Access Until</span>
              <span style="color: #1e293b; font-weight: 700; font-size: 15px;">${user.expiryDate?.toLocaleDateString()}</span>
            </div>
          </div>

          <a href="${process.env.FRONTEND_URL}/dashboard" style="display: block; width: 100%; padding: 18px; background-color: #2563eb; color: #ffffff; text-decoration: none; border-radius: 10px; font-weight: 700; text-align: center; font-size: 16px; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.2);">Launch Dashboard</a>
          
          <p style="margin-top: 30px; color: #94a3b8; font-size: 13px; text-align: center; line-height: 1.5;">
            Need help getting started? Visit our <a href="${process.env.FRONTEND_URL}/#tutorial" style="color: #2563eb; text-decoration: none;">tutorial guide</a> or join our Discord community.
          </p>
        </div>
        <div style="background-color: #f1f5f9; padding: 25px; text-align: center; font-size: 12px; color: #94a3b8;">
          &copy; 2026 Silent Study LMS Automation. Built for students, by students.
        </div>
      </div>
    `;

    await sendEmail(
      user.email,
      'Silent Study - Payment Successful!',
      confirmHtml
    );

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
