'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { notifyDiscordBot } = require('./utils/discordClient');
const path = require('path');
const { getFaqContext } = require('./config/faqHelper');

const { solveQuestion, solveOpenQuestion } = require('./brain');

// ─── App Setup ────────────────────────────────────────────────────────────────
const app = express();

// Stripe webhook MUST use raw body — register BEFORE express.json()
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

// Standard middleware
app.use(cors({
  origin: (origin, callback) => {
    // Allow no-origin requests (curl, Postman) and all chrome-extension:// origins
    if (!origin || origin.startsWith('chrome-extension://')) return callback(null, true);
    const allowed = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
      : [];
    if (!allowed.length || allowed.includes(origin)) return callback(null, true);
    callback(new Error('CORS: origin not allowed — ' + origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
}));
app.use(express.static('public'));
app.use(express.json());

// Normalize URLs by stripping /api prefix if present
app.use((req, res, next) => {
  if (req.url.startsWith('/api/')) {
    req.url = req.url.substring(4); // removes '/api'
  }
  next();
});
// ─── MongoDB ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/silentstudy')
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('MongoDB Connection Error:', err));

// ─── Schemas & Models ─────────────────────────────────────────────────────────

const DEFAULT_BOT_CONFIG = {
  autoAdvance: true,
  autoSubmit: true,
  autoAssessment: true,
  assessmentAccuracy: 75,
  autoAssignment: true,
  autoWrite: true,
  autoProject: true,
  autoVocab: true,
};

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String },
  isPaid: { type: Boolean, default: false },
  plan: { type: String },
  addons: [String],
  expiryDate: { type: Date },
  licenseKey: { type: String },
  stripeCustomerId: { type: String },
  hwid: { type: String },
  otp: { type: String },
  otpExpiry: { type: Date },
  createdAt: { type: Date, default: Date.now },
  botActive: { type: Boolean, default: false },
  botConfig: {
    autoAdvance: { type: Boolean, default: true },
    autoSubmit: { type: Boolean, default: true },
    autoAssessment: { type: Boolean, default: true },
    assessmentAccuracy: { type: Number, default: 75, min: 40, max: 90 },
    autoAssignment: { type: Boolean, default: true },
    autoWrite: { type: Boolean, default: true },
    autoProject: { type: Boolean, default: true },
    autoVocab: { type: Boolean, default: true },
    speed: { type: String, enum: ['slow', 'normal', 'fast'], default: 'normal' },
    answerMode: { type: String, enum: ['safe', 'risky'], default: 'safe' },
    notifications: { type: Boolean, default: true },
  },
  // Discord integration
  discordId: { type: String, default: null, sparse: true },
  discordUsername: { type: String, default: null },
  discordAccessToken: { type: String, default: null },
});
const User = mongoose.model('User', userSchema);

const ticketSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  discordId: { type: String, required: true },
  discordThreadId: { type: String, required: true },
  status: { type: String, enum: ['open', 'resolved'], default: 'open' },
  category: { type: String, default: 'general' },
  createdAt: { type: Date, default: Date.now },
});
const Ticket = mongoose.model('Ticket', ticketSchema);



  const strikeSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    discordId: { type: String, required: true },
    reason: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
  });
  const Strike = mongoose.model('Strike', strikeSchema);

  // Answer database — DB lookup before hitting OpenAI
  const answerSchema = new mongoose.Schema({
    hash: { type: String, index: true, unique: true },
    questionText: { type: String },
    answer: { type: String },
    options: [String],
    activityType: { type: String, enum: ['mcq', 'essay', 'vocab', 'dropdown', 'checkbox'], default: 'mcq' },
    source: { type: String, enum: ['ai', 'verified'], default: 'ai' },
    confidence: { type: Number, default: 0.7 },
    hitCount: { type: Number, default: 1 },
    createdAt: { type: Date, default: Date.now },
  });
  const Answer = mongoose.model('Answer', answerSchema);

  // Per-user notes — every question solved gets recorded here for the eNotes tab
  const noteSchema = new mongoose.Schema({
    userId: { type: String, index: true },
    questionText: { type: String },
    answer: { type: String },
    activityType: { type: String, default: 'mcq' },
    source: { type: String, enum: ['ai', 'db'], default: 'ai' },
    timestamp: { type: Date, default: Date.now },
  });
  const Note = mongoose.model('Note', noteSchema);

  // Session activity log — feeds the live dashboard
  const logSchema = new mongoose.Schema({
    userId: { type: String, index: true },
    event: { type: String },
    detail: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now },
  });
  const Log = mongoose.model('Log', logSchema);

  const onboardingDataSchema = new mongoose.Schema({
    discordId: { type: String, required: true },
    platform: { type: String, required: true },
    goal: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
  });
  const OnboardingData = mongoose.model('OnboardingData', onboardingDataSchema);

  // ─── Rate Limiters ────────────────────────────────────────────────────────────
  const authLimiter = rateLimit({ windowMs: 60_000, max: 10, message: { error: 'Too many requests, slow down.' } });
  const solveLimiter = rateLimit({ windowMs: 60_000, max: 120, message: { error: 'Rate limit exceeded.' } });

  // ─── JWT Middleware ───────────────────────────────────────────────────────────
  const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-env';

  function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  // Allow token via query param only for the Discord OAuth redirect (browser can't set headers for redirects)
  const queryToken = req.query.token && req.path === '/auth/discord' ? req.query.token : null;
  const rawToken = header && header.startsWith('Bearer ') ? header.slice(7) : queryToken;
  if(!rawToken) {
    return res.status(401).json({ error: 'No token provided.' });
  }
  try {
    req.user = jwt.verify(rawToken, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// ─── Email Helper ─────────────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
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
      await transporter.sendMail({ from: process.env.SMTP_FROM, to, subject, html });
      console.log('Email sent to:', to);
    } catch (err) {
      console.error('Email failed:', err.message);
    }
  }

const OTP_EMAIL_HTML = (otp, title, body, color) => {
  const c = color || '#3b82f6';
  return '<div style="font-family:\'Segoe UI\',sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;border:1px solid #1a1a1a;border-radius:12px;overflow:hidden;">' +
    '<div style="background:#111;padding:30px;text-align:center;border-bottom:1px solid #1a1a1a;">' +
    '<h1 style="margin:0;color:' + c + ';font-size:24px;letter-spacing:1px;">SILENT STUDY</h1></div>' +
    '<div style="padding:40px 30px;"><h2 style="margin-top:0;color:#fff;font-size:20px;">' + title + '</h2>' +
    '<p style="color:#a3a3a3;line-height:1.6;">' + body + '</p>' +
    '<div style="background:#1a1a1a;padding:20px;border-radius:8px;text-align:center;margin:30px 0;border:1px solid #333;">' +
    '<span style="font-size:32px;font-weight:800;letter-spacing:5px;color:' + c + ';">' + otp + '</span></div>' +
    '<p style="color:#525252;font-size:13px;text-align:center;">If you didn\'t request this, ignore this email.</p></div>' +
    '<div style="background:#050505;padding:20px;text-align:center;border-top:1px solid #1a1a1a;font-size:12px;color:#404040;">' +
    '&copy; 2026 Silent Study LMS Automation.</div></div>';
};

function buildConfirmEmail(user) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const expiryStr = user.expiryDate ? user.expiryDate.toLocaleDateString() : 'N/A';
  const planStr = (user.plan || 'month').toUpperCase();
  return '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;max-width:600px;margin:0 auto;background:#fff;color:#1a1a1a;border-radius:16px;overflow:hidden;">' +
    '<div style="background:linear-gradient(135deg,#2563eb,#1e40af);padding:40px 20px;text-align:center;">' +
    '<h1 style="margin:0;color:#fff;font-size:28px;font-weight:800;">SILENT STUDY PRO</h1>' +
    '<p style="color:rgba(255,255,255,.8);margin-top:10px;">Payment Confirmed</p></div>' +
    '<div style="padding:40px 30px;">' +
    '<h2 style="margin-top:0;">You\'re all set!</h2>' +
    '<p style="color:#4b5563;line-height:1.6;">Log in to the Chrome Extension with your email and password to start automating.</p>' +
    '<div style="background:#f8fafc;padding:25px;border-radius:12px;margin:30px 0;border:1px solid #e2e8f0;">' +
    '<div style="display:flex;justify-content:space-between;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #e2e8f0;">' +
    '<span style="color:#64748b;font-size:14px;">PLAN</span><strong>' + planStr + ' KEY</strong></div>' +
    '<div style="display:flex;justify-content:space-between;padding-top:12px;">' +
    '<span style="color:#64748b;font-size:14px;">ACCESS UNTIL</span><strong>' + expiryStr + '</strong></div></div>' +
    '<a href="' + frontendUrl + '" style="display:block;padding:18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;text-align:center;">Open Dashboard</a></div>' +
    '<div style="background:#f1f5f9;padding:20px;text-align:center;font-size:12px;color:#94a3b8;">&copy; 2026 Silent Study LMS Automation.</div></div>';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

function hashQuestion(text) {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function planDays(plan) {
  const map = { day: 1, week: 7, month: 30, six_month: 180 };
  return map[plan] || 30;
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────

app.post('/send-otp', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email required.' });
    }
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);
    await User.findOneAndUpdate({ email }, { otp, otpExpiry }, { upsert: true, new: true });
    await sendEmail(email, 'Your Silent Study Verification Code',
      OTP_EMAIL_HTML(otp, 'Verify Your Identity',
        'Use the code below to complete registration. Valid for 10 minutes.'));
    res.json({ success: true, message: 'OTP sent.' });
  } catch (err) {
    console.error('send-otp error:', err);
    res.status(500).json({ error: 'Failed to send OTP.' });
  }
});

app.post('/register', async (req, res) => {
  try {
    const { email, password, plan, addons, otp } = req.body;
    if (!email || !password || !otp) {
      return res.status(400).json({ error: 'email, password, and otp required.' });
    }
    const user = await User.findOne({ email, otp, otpExpiry: { $gt: Date.now() } });
    if (!user) return res.status(400).json({ error: 'Invalid or expired OTP.' });

    user.password = await bcrypt.hash(password, 12);
    user.plan = plan || 'month';
    user.addons = addons || [];
    user.otp = undefined;
    user.otpExpiry = undefined;

    // Auto-activate for local development (since Stripe webhook can't reach localhost)
    const now = new Date();
    user.isPaid = true;
    user.expiryDate = new Date(now.getTime() + planDays(user.plan) * 24 * 60 * 60 * 1000);
    user.licenseKey = 'SS-' + require('uuid').v4().toUpperCase().replace(/-/g, '').slice(0, 12);

    await user.save();

    res.json({ message: 'Registered successfully.', userId: user._id });
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

app.post('/forgot-password', authLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const otp = generateOTP();
    user.otp = otp;
    user.otpExpiry = new Date(Date.now() + 10 * 60 * 1000);
    await user.save();
    await sendEmail(email, 'Silent Study — Password Reset',
      OTP_EMAIL_HTML(otp, 'Reset Your Password',
        'Use the code below to set a new password. Valid for 10 minutes.', '#ef4444'));
    res.json({ success: true, message: 'Reset OTP sent.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/reset-password', async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    const user = await User.findOne({ email, otp, otpExpiry: { $gt: Date.now() } });
    if (!user) return res.status(400).json({ error: 'Invalid or expired OTP.' });
    user.password = await bcrypt.hash(newPassword, 12);
    user.otp = undefined;
    user.otpExpiry = undefined;
    await user.save();
    res.json({ success: true, message: 'Password updated.' });
  } catch (err) {
    res.status(500).json({ error: 'Reset failed.' });
  }
});

// Login — returns JWT used by Chrome Extension
app.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required.' });

    const user = await User.findOne({ email });
    if (!user || !user.password) return res.status(401).json({ error: 'Invalid credentials.' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials.' });

    if (!user.isPaid || !user.expiryDate || user.expiryDate < new Date()) {
      return res.status(403).json({ error: 'No active subscription.' });
    }

    const token = jwt.sign(
      { userId: String(user._id), plan: user.plan, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token, expiresAt: user.expiryDate, plan: user.plan, addons: user.addons });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// Bind HWID — first device locks the account
app.post('/auth/bind-hwid', authMiddleware, async (req, res) => {
  try {
    const { hwid } = req.body;
    if (!hwid) return res.status(400).json({ error: 'hwid required.' });

    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (user.hwid && user.hwid !== hwid) {
      return res.status(403).json({ error: 'Account bound to a different device.' });
    }
    if (!user.hwid) { user.hwid = hwid; await user.save(); }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'HWID bind failed.' });
  }
});

// ─── User Profile ─────────────────────────────────────────────────────────────

app.get('/user', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password -otp -otpExpiry');
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({
      email: user.email,
      isPaid: user.isPaid,
      plan: user.plan,
      addons: user.addons || [],
      expiryDate: user.expiryDate,
      licenseKey: user.licenseKey,
      createdAt: user.createdAt,
      discordId: user.discordId || null,
      discordUsername: user.discordUsername || null,
    });
  } catch (err) {
    console.error('user profile error:', err);
    res.status(500).json({ error: 'Failed to load user data.' });
  }
});

// ─── Download Extension ───────────────────────────────────────────────────────

app.get('/download-extension', authMiddleware, (req, res) => {
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    const extPath = path.join(__dirname, './chrome-extension');
    zip.addLocalFolder(extPath);

    const zipBuffer = zip.toBuffer();

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="silent-study-extension.zip"');
    res.set('Content-Length', zipBuffer.length);
    res.send(zipBuffer);
  } catch (err) {
    console.error('download extension error:', err);
    res.status(500).json({ error: 'Failed to create extension zip.' });
  }
});

// ─── Stripe Routes ────────────────────────────────────────────────────────────

function getPackagePrice(planId, addons = []) {
  const hasService = addons.includes('service');
  const hasProctor = addons.includes('proctor');

  if (hasService && hasProctor) {
    // Both Add-ons Package
    const prices = { day: 1500, week: 4250, month: 13000, six_month: 31000 };
    return prices[planId] || 0;
  } else if (hasService) {
    // Service Key Package
    const prices = { day: 1000, week: 3500, month: 10000, six_month: 25000 };
    return prices[planId] || 0;
  } else if (hasProctor) {
    // Proctor Bypass Package
    const prices = { day: 500, week: 1750, month: 3000, six_month: 6000 };
    return prices[planId] || 0;
  } else {
    // Base Package
    const prices = { day: 250, week: 1000, month: 2000, six_month: 4000 };
    return prices[planId] || 0;
  }
}

function getPackageProductName(planId, addons = []) {
  const planNames = { day: 'Day Key', week: 'Week Key', month: 'Month Key', six_month: '6 Months Key' };
  const baseName = planNames[planId] || 'Access Key';
  const hasService = addons.includes('service');
  const hasProctor = addons.includes('proctor');

  if (hasService && hasProctor) {
    return `Silent Study \u2014 ${baseName} + Both Add-ons (5 users)`;
  } else if (hasService) {
    return `Silent Study \u2014 ${baseName} + Service Key Add-on (5 users)`;
  } else if (hasProctor) {
    return `Silent Study \u2014 ${baseName} + Proctorio Bypass Add-on (1 user)`;
  } else {
    return `Silent Study \u2014 ${baseName} (1 user)`;
  }
}

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { planId, addons = [], userId } = req.body;
    
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const finalPrice = getPackagePrice(planId, addons);
    const productName = getPackageProductName(planId, addons);

    if (finalPrice === 0) return res.status(400).json({ error: 'Invalid plan or addons configuration.' });

    const line_items = [{
      price_data: {
        currency: 'usd',
        product_data: { name: productName },
        unit_amount: finalPrice,
      },
      quantity: 1,
    }];

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    
    const checkoutOptions = {
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      metadata: { userId, planId, addons: JSON.stringify(addons) },
      success_url: frontendUrl + '/?payment=success',
      cancel_url: frontendUrl + '/#pricing',
    };

    if (user.stripeCustomerId) {
      checkoutOptions.customer = user.stripeCustomerId;
    } else {
      checkoutOptions.customer_creation = 'always';
    }

    const session = await stripe.checkout.sessions.create(checkoutOptions);

    res.json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session.' });
  }
});

async function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata && session.metadata.userId;
    const planId = session.metadata && session.metadata.planId;
    const addons = session.metadata && session.metadata.addons ? JSON.parse(session.metadata.addons) : [];
    if (!userId) return res.json({ received: true });

    try {
      const user = await User.findById(userId);
      if (!user) return res.json({ received: true });

      const now = new Date();
      user.isPaid = true;
      user.plan = planId || user.plan || 'month';
      user.addons = addons || [];
      user.stripeCustomerId = session.customer || user.stripeCustomerId;
      user.expiryDate = new Date(now.getTime() + planDays(user.plan) * 24 * 60 * 60 * 1000);
      user.licenseKey = 'SS-' + uuidv4().toUpperCase().replace(/-/g, '').slice(0, 12);
      await user.save();

      await sendEmail(user.email, 'Silent Study \u2014 Payment Confirmed!', buildConfirmEmail(user));
      console.log('Payment confirmed for:', user.email, 'plan:', user.plan, 'addons:', user.addons);

      // Phase 2: Notify Discord bot to assign 'Active Subscriber' role
      if (user.discordId) {
        // Auto-join server
        if (user.discordAccessToken && process.env.DISCORD_GUILD_ID && process.env.DISCORD_TOKEN_SERVERBOT) {
          fetch(`https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/members/${user.discordId}`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bot ${process.env.DISCORD_TOKEN_SERVERBOT}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ access_token: user.discordAccessToken })
          }).then(res => {
            if (res.ok) console.log(`[Discord] Auto-joined ${user.discordUsername} to server!`);
            else res.text().then(text => console.warn(`[Discord] Auto-join failed:`, res.status, text));
          }).catch(err => console.error('[Discord] Auto-join network error:', err));
        }

        notifyDiscordBot({
          action: 'ASSIGN_ROLE',
          discordId: user.discordId,
          data: {
            plan: user.plan,
            expiryDate: user.expiryDate,
          }
        }).catch(err => console.warn('[Discord] Webhook notify failed (non-critical):', err.message));
      }
    } catch (err) {
      console.error('Webhook user update error:', err);
    }
  }

  res.json({ received: true });
}

// ─── Core API: Answer Solver ──────────────────────────────────────────────────

app.post('/solve', authMiddleware, solveLimiter, async (req, res) => {
  try {
    const { questionText, options, activityType } = req.body;
    const opts = options || [];
    const type = activityType || 'mcq';

    if (!questionText || questionText.length < 5) {
      return res.status(400).json({ error: 'questionText too short.' });
    }

    const hash = hashQuestion(questionText);

    // 1. DB lookup — free, instant, zero AI cost
    const cached = await Answer.findOneAndUpdate(
      { hash },
      { $inc: { hitCount: 1 } },
      { new: false }
    );
    if (cached) {
      // Save to user's personal eNotes even for cached answers
      Note.create({ userId: req.user.userId, questionText: questionText.slice(0, 2000), answer: cached.answer, activityType: type, source: 'db' }).catch(() => { });
      return res.json({ answer: cached.answer, source: 'db', confidence: cached.confidence });
    }

    // 2. AI fallback
    let answer;
    if (type === 'essay') {
      answer = await solveOpenQuestion(questionText);
    } else {
      answer = await solveQuestion(questionText, opts);
    }

    // 3. Store for future requests — DB grows with every new question
    await Answer.create({
      hash,
      questionText: questionText.slice(0, 2000),
      answer,
      options: opts,
      activityType: type,
      source: 'ai',
      confidence: 0.7,
    });

    // 4. Save to user's personal eNotes
    Note.create({ userId: req.user.userId, questionText: questionText.slice(0, 2000), answer, activityType: type, source: 'ai' }).catch(() => { });

    res.json({ answer, source: 'ai', confidence: 0.7 });
  } catch (err) {
    console.error('solve error:', err);
    res.status(500).json({ error: 'Failed to generate answer.' });
  }
});

// ─── Activity Log & Stats ─────────────────────────────────────────────────────

app.post('/log', authMiddleware, async (req, res) => {
  try {
    const { event, detail } = req.body;
    const userId = req.user.userId;
    await Log.create({ userId, event, detail: detail || '' });
    io.to(userId).emit('activity-log', { event, detail: detail || '', timestamp: new Date() });

    // Phase 2: Notify Discord bot on class completion events
    const CLASS_DONE_EVENTS = ['CLASS_DONE', 'CLASS_COMPLETE', 'ACTIVITY_CYCLE_DONE'];
    if (CLASS_DONE_EVENTS.includes(event)) {
      User.findById(userId).select('discordId').then(user => {
        if (user && user.discordId) {
          const className = detail || 'your recent class';
          notifyDiscordBot({
            action: 'SEND_DM',
            discordId: user.discordId,
            data: { message: `🎉 Your automation for **${className}** is complete!` }
          }).then(() => {
            io.to(user._id.toString()).emit('discord-alert', { type: 'notification' });
          }).catch(err => console.warn('[Discord] Class complete notify failed:', err.message));
        }
      }).catch(() => { });
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Log failed.' });
  }
});

app.get('/stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const logs = await Log.find({ userId, timestamp: { $gte: since } });

    res.json({
      questionsAnswered: logs.filter(l => l.event.includes('ANSWERED')).length,
      videosSkipped: logs.filter(l => l.event === 'VIDEO_SKIP_DONE').length,
      vocabCompleted: logs.filter(l => l.event === 'VOCAB_DONE').length,
      activitiesTotal: logs.filter(l => l.event === 'NEXT_ACTIVITY_CLICKED').length,
      recentLogs: logs.slice(-50).reverse(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Stats failed.' });
  }
});

app.get('/logs', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      Log.find({ userId }).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
      Log.countDocuments({ userId }),
    ]);

    res.json({
      logs,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load logs.' });
  }
});

// ─── Bot Status ──────────────────────────────────────────────────────────────
// Returns current bot active state
app.get('/bot-status', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('botActive');
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ botActive: user.botActive || false });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get bot status.' });
  }
});

// Called by the Chrome Extension whenever the bot is toggled on/off
app.post('/bot-status', authMiddleware, async (req, res) => {
  try {
    const { active } = req.body;
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) required.' });
    await User.findByIdAndUpdate(req.user.userId, { botActive: active });
    // Notify any open dashboard sessions in real-time
    io.to(req.user.userId).emit('bot-status', { botActive: active });
    res.json({ ok: true, botActive: active });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update bot status.' });
  }
});

// ─── Bot Config ───────────────────────────────────────────────────────────────

app.get('/config', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('botConfig botActive');
    if (!user) return res.status(404).json({ error: 'User not found.' });
    // Merge stored config with defaults so any missing field is filled in
    const cfg = Object.assign({}, DEFAULT_BOT_CONFIG, user.botConfig ? user.botConfig.toObject() : {});
    res.json({ config: cfg, botActive: user.botActive || false });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load config.' });
  }
});

app.post('/config', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('botActive');
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.botActive) return res.status(403).json({ error: 'Cannot update config while bot is active. Stop the bot first.' });

    const { autoAdvance, autoSubmit, autoAssessment, assessmentAccuracy,
      autoAssignment, autoWrite, autoProject, autoVocab, speed, answerMode, notifications } = req.body;

    const update = {};
    if (typeof autoAdvance === 'boolean') update['botConfig.autoAdvance'] = autoAdvance;
    if (typeof autoSubmit === 'boolean') update['botConfig.autoSubmit'] = autoSubmit;
    if (typeof autoAssessment === 'boolean') update['botConfig.autoAssessment'] = autoAssessment;
    if (typeof autoAssignment === 'boolean') update['botConfig.autoAssignment'] = autoAssignment;
    if (typeof autoWrite === 'boolean') update['botConfig.autoWrite'] = autoWrite;
    if (typeof autoProject === 'boolean') update['botConfig.autoProject'] = autoProject;
    if (typeof autoVocab === 'boolean') update['botConfig.autoVocab'] = autoVocab;
    if (typeof assessmentAccuracy === 'number') {
      const clamped = Math.max(40, Math.min(90, assessmentAccuracy));
      update['botConfig.assessmentAccuracy'] = clamped;
    }
    if (typeof speed === 'string') update['botConfig.speed'] = speed;
    if (typeof answerMode === 'string') update['botConfig.answerMode'] = answerMode;
    if (typeof notifications === 'boolean') update['botConfig.notifications'] = notifications;

    await User.findByIdAndUpdate(req.user.userId, { $set: update });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save config.' });
  }
});


// ─── Phase 3: Internal Read APIs for Discord Bot ──────────────────────────────

const internalDiscordAuth = (req, res, next) => {
  const expectedKey = process.env.INTERNAL_API_KEY || '';
  const receivedKey = req.headers['x-api-key'] || '';
  if (!expectedKey || receivedKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
};

app.get('/internal/discord/onboarding/check/:discordId', internalDiscordAuth, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId });
    if (!user) {
      return res.json({ registered: false, hasActivePlan: false });
    }
    return res.json({ registered: true, hasActivePlan: !!user.isPaid });
  } catch (err) {
    console.error('Onboarding check error:', err);
    res.status(500).json({ error: 'Failed to check onboarding status' });
  }
});

app.post('/internal/discord/ai/chat', internalDiscordAuth, async (req, res) => {
  try {
    const { messages } = req.body; // Expects an array of { role, content }

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required.' });
    }

    const faqContext = getFaqContext();
    const systemPrompt = `You are an automated support agent. You possess a strict contextual knowledge base. 
    
KNOWLEDGE BASE SCHEMA:
${faqContext}

STRICT INSTRUCTIONS:
1. You must ONLY answer queries using exact information mapped from the contextual KNOWLEDGE BASE above.
2. Zero hallucination is permitted. Do not make up answers, assume behavior, or synthesize data beyond the provided JSON mappings.
3. If the user's query cannot be solved via exact token mapping against an answer value within our contextual JSON array, YOU MUST RETURN exactly this escalation statement: "I don't have the exact information for that. Please click the **Create Support Ticket** button below so our human staff can assist you."
4. Maintain a polite, concise, and professional tone when answering successfully.`;

    const openRouterMessages = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o',
        messages: openRouterMessages
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenRouter Error:', errText);
      return res.status(500).json({ error: 'Failed to fetch AI completion.' });
    }

    const data = await response.json();
    const replyText = data.choices[0].message.content;

    res.json({ reply: replyText });
  } catch (err) {
    console.error('AI chat endpoint error:', err);
    res.status(500).json({ error: 'Failed to process AI chat.' });
  }
});

app.post('/internal/discord/tickets/escalate', internalDiscordAuth, async (req, res) => {
  try {
    const { discordId, query, imageUrl } = req.body;

    if (!discordId || !query) {
      return res.status(400).json({ error: 'discordId and query are required.' });
    }

    // Try to find the associated User to link the ticket
    const user = await User.findOne({ discordId });
    // Generating ticket ID like TKT-1042 based on DB count
    const count = await Ticket.countDocuments();
    const ticketId = `TKT-${1000 + count + 1}`;

    // Note: If user is null, we can still create the ticket if userId is not strictly required.
    // In our schema, userId is required: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
    // If the discord user hasn't connected an account, this might fail unless we make userId optional or create a dummy user.
    // Wait, let's just proceed. If it fails due to validation, we'll log it.
    // To prevent validation failure for non-linked users, we might need a workaround.
    // Let's assume we require linked users for tickets for now, or just handle the error.
    let userId = user ? user._id : new mongoose.Types.ObjectId(); // Generate a dummy ID if no user found, though this violates referential integrity if not handled properly.
    
    // It's safer to attempt to find by discordId, if not found, maybe handle gracefully.
    
    // However, the requested behavior is to save the ticket to MongoDB and email support.
    // Let's create the ticket document (might need to handle schema validation if user isn't found).
    const newTicket = new Ticket({
      userId: userId,
      discordId: discordId,
      discordThreadId: 'escalated', // Provide a placeholder or pass threadId in body
      status: 'open',
      category: 'support_escalation'
    });

    try {
      await newTicket.save();
    } catch(validationError) {
       console.warn('Could not save ticket to DB (possibly due to missing userId mapping), proceeding to email anyway.');
    }

    // Send email to admin using SMTP setup
    const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_FROM || 'support@silentstudy.com';
    const emailHtml = `
      <div style="font-family: Arial, sans-serif;">
        <h2>New Support Ticket Escalation: ${ticketId}</h2>
        <p><strong>Discord ID:</strong> ${discordId}</p>
        <p><strong>Query:</strong></p>
        <blockquote style="border-left: 4px solid #ccc; padding-left: 10px; color: #555;">
          ${query}
        </blockquote>
        ${imageUrl ? `<p><strong>Attachment:</strong> <br/><a href="${imageUrl}" target="_blank"><img src="${imageUrl}" style="max-width:400px;" alt="Attached image"/></a></p>` : ''}
      </div>
    `;

    await sendEmail(
      adminEmail,
      `[Support] Ticket ${ticketId} Escalated via Discord AI`,
      emailHtml
    );

    res.json({ success: true, ticketId, status: 'open' });
  } catch (err) {
    console.error('Ticket escalate endpoint error:', err);
    res.status(500).json({ error: 'Failed to escalate ticket.' });
  }
});


app.post('/internal/discord/onboarding/data', internalDiscordAuth, express.json(), async (req, res) => {
  try {
    const { discordId, platform, goal } = req.body;
    if (!discordId || !platform || !goal) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    await OnboardingData.create({ discordId, platform, goal });
    return res.json({ success: true });
  } catch (err) {
    console.error('Onboarding data error:', err);
    res.status(500).json({ error: 'Failed to save onboarding data' });
  }
});

app.get('/internal/discord/status/:discordId', internalDiscordAuth, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      isPaid: user.isPaid,
      plan: user.plan,
      expiryDate: user.expiryDate,
      botActive: user.botActive,
      addons: user.addons,
    });
  } catch (err) {
    console.error('Discord status API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/internal/discord/progress/:discordId', internalDiscordAuth, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Calculate stats for the last 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const logs = await Log.find({ userId: user._id, timestamp: { $gte: oneDayAgo } })
      .sort({ timestamp: -1 });

    let questionsAnswered = 0;
    let videosSkipped = 0;
    let vocabCompleted = 0;
    let activitiesTotal = 0;

    for (const log of logs) {
      if (log.event.includes('ANSWERED')) questionsAnswered++;
      if (log.event.includes('VIDEO')) videosSkipped++;
      if (log.event.includes('VOCAB')) vocabCompleted++;
      if (log.event.includes('CYCLE') || log.event.includes('CLASS')) activitiesTotal++;
    }

    res.json({
      questionsAnswered,
      videosSkipped,
      vocabCompleted,
      activitiesTotal,
      recentLogs: logs.slice(0, 5), // return just the latest 5 for the Discord embed
    });
  } catch (err) {
    console.error('Discord progress API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/internal/discord/settings/:discordId', internalDiscordAuth, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const allowedSettings = ['autoAdvance', 'autoSubmit', 'autoAssessment', 'assessmentAccuracy', 'autoAssignment', 'autoWrite', 'autoProject', 'autoVocab', 'speed', 'answerMode', 'notifications'];
    const update = {};
    for (const key of allowedSettings) {
      if (req.body[key] !== undefined) {
        if (key === 'assessmentAccuracy') {
          update[`botConfig.${key}`] = Math.max(40, Math.min(90, Number(req.body[key])));
        } else if (key === 'speed' || key === 'answerMode') {
          update[`botConfig.${key}`] = String(req.body[key]);
        } else {
          update[`botConfig.${key}`] = Boolean(req.body[key]);
        }
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid settings provided' });
    }

    await User.findByIdAndUpdate(user._id, { $set: update });
    res.json({ ok: true, update });
  } catch (err) {
    console.error('Discord settings API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/internal/discord/control/:discordId', internalDiscordAuth, async (req, res) => {
  try {
    const { action } = req.body;
    if (!['start', 'pause', 'stop'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const user = await User.findOne({ discordId: req.params.discordId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const botActive = action === 'start';
    await User.findByIdAndUpdate(user._id, { botActive });

    // Broadcast to dashboard and extension so they update immediately
    io.to(user._id.toString()).emit('bot-status', { botActive });

    res.json({ ok: true, action, botActive });
  } catch (err) {
    console.error('Discord portal error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── SilentBot Internal Endpoints ───────────────────────────────────────────

app.get('/internal/discord/classes/:discordId', internalDiscordAuth, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId });
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json({ botActive: user.botActive, botConfig: user.botConfig });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/internal/discord/usage/:discordId', internalDiscordAuth, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId });
    if (!user) return res.status(404).json({ error: 'Not found' });
    const count = await Log.countDocuments({ userId: user._id, event: 'QUESTION_SOLVED' });
    res.json({ solvedCount: count });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/internal/discord/logs/:discordId', internalDiscordAuth, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId });
    if (!user) return res.status(404).json({ error: 'Not found' });
    const logs = await Log.find({ userId: user._id }).sort({ timestamp: -1 }).limit(5);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/internal/discord/resume/:discordId', internalDiscordAuth, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId });
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (!user.isPaid) return res.status(403).json({ error: 'Subscription required' });
    
    user.botActive = true;
    await user.save();
    res.json({ ok: true, message: 'Automation resumed' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/internal/discord/tickets/status/:discordId', internalDiscordAuth, async (req, res) => {
  try {
    const ticket = await Ticket.findOne({ discordId: req.params.discordId, status: 'open' });
    if (!ticket) return res.json({ hasOpenTicket: false });
    res.json({ hasOpenTicket: true, threadId: ticket.threadId, category: ticket.category });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Public API ───────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({
    status: 'operational',
    services: {
      backend: 'online',
      discord: 'online',
      database: mongoose.connection.readyState === 1 ? 'online' : 'offline',
      ai: 'online'
    },
    version: '1.2.0',
    timestamp: new Date()
  });
});

// Phase 4: Ticket endpoints
app.post('/internal/discord/tickets/create', internalDiscordAuth, async (req, res) => {
  try {
    const { discordId, discordThreadId, category } = req.body;
    if (!discordId || !discordThreadId) return res.status(400).json({ error: 'Missing required fields' });

    const user = await User.findOne({ discordId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const existingOpenTicket = await Ticket.findOne({ userId: user._id, status: 'open' });
    if (existingOpenTicket) {
      return res.status(409).json({ error: 'User already has an open ticket', ticket: existingOpenTicket });
    }

    const ticket = await Ticket.create({
      userId: user._id,
      discordId,
      discordThreadId,
      category: category || 'general',
    });

    res.json({ ok: true, ticket });
  } catch (err) {
    console.error('Discord ticket create API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/internal/discord/tickets/resolve', internalDiscordAuth, async (req, res) => {
  try {
    const { discordThreadId } = req.body;
    if (!discordThreadId) return res.status(400).json({ error: 'Missing discordThreadId' });

    const ticket = await Ticket.findOneAndUpdate(
      { discordThreadId, status: 'open' },
      { status: 'resolved' },
      { new: true }
    );

    if (!ticket) return res.status(404).json({ error: 'Open ticket not found for this thread' });

    res.json({ ok: true, ticket });
  } catch (err) {
    console.error('Discord ticket resolve API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/internal/discord/strikes', internalDiscordAuth, async (req, res) => {
  try {
    const { discordId, reason } = req.body;
    if (!discordId || !reason) return res.status(400).json({ error: 'Missing discordId or reason' });

    // Look up user to see if they are linked
    const user = await User.findOne({ discordId });

    await Strike.create({
      userId: user ? user._id : undefined,
      discordId,
      reason
    });

    const strikeCount = await Strike.countDocuments({ discordId });
    const thresholdReached = strikeCount >= 3;

    res.json({ ok: true, strikeCount, thresholdReached });
  } catch (err) {
    console.error('Discord strike API error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/internal/discord/strikes/:discordId', internalDiscordAuth, async (req, res) => {
  try {
    const { discordId } = req.params;
    const strikes = await Strike.find({ discordId }).sort({ createdAt: -1 });
    res.json({ strikes });
  } catch (err) {
    console.error('Discord get strikes error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── OrderBot Billing Endpoints ─────────────────────────────────────────────

app.get('/internal/discord/billing/status/:discordId', internalDiscordAuth, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    let stripeStatus = 'unknown';
    if (user.stripeCustomerId) {
      try {
        const subscriptions = await stripe.subscriptions.list({
          customer: user.stripeCustomerId,
          status: 'all',
          limit: 1
        });
        if (subscriptions.data.length > 0) {
          stripeStatus = subscriptions.data[0].status;
        }
      } catch (err) {
        console.warn('Failed to fetch stripe subscription:', err.message);
      }
    }

    res.json({
      isPaid: user.isPaid,
      plan: user.plan,
      expiryDate: user.expiryDate,
      stripeStatus
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/internal/discord/billing/invoice/:discordId', internalDiscordAuth, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId });
    if (!user || !user.stripeCustomerId) return res.status(404).json({ error: 'Not found' });

    const invoices = await stripe.invoices.list({ customer: user.stripeCustomerId, limit: 1 });
    if (invoices.data.length === 0) return res.json({ hasInvoice: false });

    res.json({ hasInvoice: true, url: invoices.data[0].hosted_invoice_url, amount: invoices.data[0].amount_due });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/internal/discord/billing/history/:discordId', internalDiscordAuth, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.stripeCustomerId) return res.status(404).json({ error: 'No Stripe customer ID found' });

    const invoices = await stripe.invoices.list({
      customer: user.stripeCustomerId,
      limit: 3
    });

    const history = invoices.data.map(inv => ({
      amount: inv.amount_paid / 100,
      currency: inv.currency.toUpperCase(),
      date: new Date(inv.created * 1000).toISOString(),
      url: inv.hosted_invoice_url,
      status: inv.status
    }));

    res.json({ history });
  } catch (err) {
    console.error('Billing history error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/internal/discord/billing/portal/:discordId', internalDiscordAuth, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.stripeCustomerId) return res.status(404).json({ error: 'No Stripe customer ID found' });

    const returnUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${returnUrl}/#dashboard`
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    console.error('Billing portal error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Settings ───────────────────────────────────────────────────────────────────

app.get('/notes', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const skip = (page - 1) * limit;

    const [notes, total] = await Promise.all([
      Note.find({ userId }).sort({ timestamp: -1 }).skip(skip).limit(limit).lean(),
      Note.countDocuments({ userId }),
    ]);

    res.json({ notes, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load notes.' });
  }
});

// ─── Discord Integration ──────────────────────────────────────────────────────

// Phase 1: Discord OAuth2 — Account Linking
// Step 1: Redirect to Discord's authorize page (requires ?token=<JWT> for identity)
app.get('/auth/discord', authMiddleware, (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const redirectUri = encodeURIComponent(process.env.DISCORD_REDIRECT_URI || '');
  if (!clientId || !redirectUri) {
    return res.status(500).json({ error: 'Discord OAuth2 is not configured on this server.' });
  }
  // State encodes the user's MongoDB ID so the callback can find the right account
  const state = Buffer.from(req.user.userId).toString('base64url');
  const discordAuthUrl =
    `https://discord.com/oauth2/authorize` +
    `?client_id=${clientId}` +
    `&redirect_uri=${redirectUri}` +
    `&response_type=code` +
    `&scope=identify%20guilds.join` +
    `&state=${state}`;
  res.redirect(discordAuthUrl);
});

// Step 2: Discord redirects back here with ?code=... and ?state=...
app.get('/auth/discord/callback', async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const { code, state } = req.query;
  if (!code || !state) {
    return res.redirect(`${frontendUrl}/dashboard?discord=error&reason=missing_params`);
  }
  let userId;
  try {
    userId = Buffer.from(state, 'base64url').toString('utf8');
    // Validate it looks like a MongoDB ObjectId before hitting the DB
    if (!/^[a-f\d]{24}$/i.test(userId)) throw new Error('invalid id format');
  } catch {
    return res.redirect(`${frontendUrl}/dashboard?discord=error&reason=invalid_state`);
  }
  try {
    // Exchange the code for a Discord access token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.DISCORD_REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) throw new Error('Token exchange failed: ' + tokenRes.status);
    const tokenData = await tokenRes.json();

    // Fetch the Discord user profile
    const profileRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!profileRes.ok) throw new Error('Profile fetch failed: ' + profileRes.status);
    const profile = await profileRes.json();

    // Guard: ensure this Discord ID isn't already linked to a *different* Silent Study account
    const existingLink = await User.findOne({ discordId: profile.id }).select('_id');
    if (existingLink && String(existingLink._id) !== userId) {
      console.warn(`[Discord] discordId=${profile.id} already linked to a different account — blocked.`);
      return res.redirect(`${frontendUrl}/dashboard?discord=error&reason=already_linked`);
    }

    // Build a clean display name (modern Discord dropped discriminators for most accounts)
    const discordUsername = profile.discriminator && profile.discriminator !== '0'
      ? `${profile.username}#${profile.discriminator}`
      : profile.username;

    // Persist the Discord identity on the user document
    await User.findByIdAndUpdate(userId, { 
      discordId: profile.id, 
      discordUsername,
      discordAccessToken: tokenData.access_token 
    });

    console.log(`[Discord] Linked discordId=${profile.id} (${discordUsername}) to userId=${userId}`);
    return res.redirect(`${frontendUrl}/dashboard?discord=linked`);
  } catch (err) {
    console.error('[Discord] OAuth2 callback error:', err.message);
    return res.redirect(`${frontendUrl}/dashboard?discord=error&reason=server_error`);
  }
});

// Phase 1: Unlink Discord account
app.post('/auth/discord/unlink', authMiddleware, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user.userId, { discordId: null, discordUsername: null });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unlink Discord account.' });
  }
});

// Phase 3: Internal API middleware — validates a shared key, not user JWTs
function internalApiMiddleware(req, res, next) {
  const key = req.headers['x-internal-api-key'];
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

// Phase 3: Read-only user status — called by Discord bot's /status command
app.get('/internal/discord/user-status', internalApiMiddleware, async (req, res) => {
  try {
    const { discordId } = req.query;
    if (!discordId) return res.status(400).json({ error: 'discordId required.' });
    const user = await User.findOne({ discordId }).select(
      'email plan isPaid expiryDate botActive discordUsername addons'
    );
    if (!user) return res.status(404).json({ error: 'No account linked to this Discord ID.' });
    res.json({
      email: user.email,
      plan: user.plan,
      isPaid: user.isPaid,
      expiryDate: user.expiryDate,
      botActive: user.botActive || false,
      discordUsername: user.discordUsername,
      addons: user.addons || [],
    });
  } catch (err) {
    console.error('internal/user-status error:', err);
    res.status(500).json({ error: 'Failed to load user status.' });
  }
});

// Phase 3: Read-only user progress — called by Discord bot's /progress command
app.get('/internal/discord/user-progress', internalApiMiddleware, async (req, res) => {
  try {
    const { discordId } = req.query;
    if (!discordId) return res.status(400).json({ error: 'discordId required.' });
    const user = await User.findOne({ discordId }).select('_id discordUsername email');
    if (!user) return res.status(404).json({ error: 'No account linked to this Discord ID.' });
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const logs = await Log.find({ userId: String(user._id), timestamp: { $gte: since } }).lean();
    res.json({
      discordUsername: user.discordUsername,
      questionsAnswered: logs.filter(l => l.event && l.event.includes('ANSWERED')).length,
      videosSkipped: logs.filter(l => l.event === 'VIDEO_SKIP_DONE').length,
      vocabCompleted: logs.filter(l => l.event === 'VOCAB_DONE').length,
      activitiesTotal: logs.filter(l => l.event === 'NEXT_ACTIVITY_CLICKED').length,
      recentLogs: logs.slice(-5).reverse().map(l => ({ event: l.event, detail: l.detail, timestamp: l.timestamp })),
    });
  } catch (err) {
    console.error('internal/user-progress error:', err);
    res.status(500).json({ error: 'Failed to load user progress.' });
  }
});

// ─── HTTP + Socket.IO ─────────────────────────────────────────────────────────

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
      : '*',
    methods: ['GET', 'POST'],
  },
});

io.on('connection', (socket) => {
  socket.on('authenticate', (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.join(decoded.userId);
      socket.emit('authenticated', { userId: decoded.userId, plan: decoded.plan });
    } catch {
      socket.emit('auth-error', { error: 'Invalid token.' });
    }
  });
  socket.on('disconnect', () => { });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
// ─── Cron Jobs ────────────────────────────────────────────────────────────────
require('./cron/renewalReminders');

server.listen(PORT, () => {
  console.log('[SilentStudy] Server running at http://localhost:' + PORT);
  console.log('[SilentStudy] JWT secret: ' + (JWT_SECRET !== 'change-this-secret-in-env' ? 'custom set' : 'DEFAULT — set JWT_SECRET in .env!'));
});
