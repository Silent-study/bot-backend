'use strict';

require('dotenv').config();

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
const path = require('path');

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
  },
});
const User = mongoose.model('User', userSchema);

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

// ─── Rate Limiters ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({ windowMs: 60_000, max: 10, message: { error: 'Too many requests, slow down.' } });
const solveLimiter = rateLimit({ windowMs: 60_000, max: 120, message: { error: 'Rate limit exceeded.' } });

// ─── JWT Middleware ───────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-env';

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided.' });
  }
  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
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
app.post('/api/auth/login', authLimiter, async (req, res) => {
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
app.post('/api/auth/bind-hwid', authMiddleware, async (req, res) => {
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

app.get('/api/user', authMiddleware, async (req, res) => {
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
    });
  } catch (err) {
    console.error('user profile error:', err);
    res.status(500).json({ error: 'Failed to load user data.' });
  }
});

// ─── Download Extension ───────────────────────────────────────────────────────

app.get('/api/download-extension', authMiddleware, (req, res) => {
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

const PLANS = {
  day: { name: 'Day Key', price: 250 },
  week: { name: 'Week Key', price: 1000 },
  month: { name: 'Month Key', price: 2000 },
  six_month: { name: '6 Months Key', price: 4000 },
};

const ADDONS = {
  service: { name: 'Service Key (5 users)', price: 500 },
  proctor: { name: 'Proctorio Bypass', price: 1000 },
};

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { planId, addons = [], userId } = req.body;
    const plan = PLANS[planId];
    if (!plan) return res.status(400).json({ error: 'Invalid plan.' });

    const line_items = [{
      price_data: {
        currency: 'usd',
        product_data: { name: 'Silent Study \u2014 ' + plan.name },
        unit_amount: plan.price,
      },
      quantity: 1,
    }];

    for (const addonId of addons) {
      const addon = ADDONS[addonId];
      if (addon) {
        line_items.push({
          price_data: {
            currency: 'usd',
            product_data: { name: 'Add-on: ' + addon.name },
            unit_amount: addon.price,
          },
          quantity: 1,
        });
      }
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      metadata: { userId, planId },
      success_url: frontendUrl + '/?payment=success',
      cancel_url: frontendUrl + '/#pricing',
    });

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
    if (!userId) return res.json({ received: true });

    try {
      const user = await User.findById(userId);
      if (!user) return res.json({ received: true });

      const now = new Date();
      user.isPaid = true;
      user.plan = planId || user.plan || 'month';
      user.expiryDate = new Date(now.getTime() + planDays(user.plan) * 24 * 60 * 60 * 1000);
      user.licenseKey = 'SS-' + uuidv4().toUpperCase().replace(/-/g, '').slice(0, 12);
      await user.save();

      await sendEmail(user.email, 'Silent Study \u2014 Payment Confirmed!', buildConfirmEmail(user));
      console.log('Payment confirmed for:', user.email, 'plan:', user.plan);
    } catch (err) {
      console.error('Webhook user update error:', err);
    }
  }

  res.json({ received: true });
}

// ─── Core API: Answer Solver ──────────────────────────────────────────────────

app.post('/api/solve', authMiddleware, solveLimiter, async (req, res) => {
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

app.post('/api/log', authMiddleware, async (req, res) => {
  try {
    const { event, detail } = req.body;
    const userId = req.user.userId;
    await Log.create({ userId, event, detail: detail || '' });
    io.to(userId).emit('activity-log', { event, detail: detail || '', timestamp: new Date() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Log failed.' });
  }
});

app.get('/api/stats', authMiddleware, async (req, res) => {
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

// ─── Bot Status ──────────────────────────────────────────────────────────────
// Called by the Chrome Extension whenever the bot is toggled on/off
app.post('/api/bot-status', authMiddleware, async (req, res) => {
  try {
    const { active } = req.body;
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) required.' });
    await User.findByIdAndUpdate(req.user.userId, { botActive: active });
    res.json({ ok: true, botActive: active });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update bot status.' });
  }
});

// ─── Bot Config ───────────────────────────────────────────────────────────────

app.get('/api/config', authMiddleware, async (req, res) => {
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

app.post('/api/config', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('botActive');
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.botActive) return res.status(403).json({ error: 'Cannot update config while bot is active. Stop the bot first.' });

    const { autoAdvance, autoSubmit, autoAssessment, assessmentAccuracy,
      autoAssignment, autoWrite, autoProject, autoVocab } = req.body;

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

    await User.findByIdAndUpdate(req.user.userId, { $set: update });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save config.' });
  }
});

// ─── eNotes ───────────────────────────────────────────────────────────────────

app.get('/api/notes', authMiddleware, async (req, res) => {
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
server.listen(PORT, () => {
  console.log('[SilentStudy] Server running at http://localhost:' + PORT);
  console.log('[SilentStudy] JWT secret: ' + (JWT_SECRET !== 'change-this-secret-in-env' ? 'custom set' : 'DEFAULT — set JWT_SECRET in .env!'));
});
