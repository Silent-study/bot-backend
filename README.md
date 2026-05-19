# Silent Study — Developer Guide

## Table of Contents
1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Repository Structure](#3-repository-structure)
4. [Backend — `bot-backend/`](#4-backend)
   - [Setup & Running](#41-setup--running)
   - [Environment Variables](#42-environment-variables)
   - [Database Schemas](#43-database-schemas)
   - [API Reference](#44-api-reference)
   - [Socket.IO Events](#45-socketio-events)
   - [Rate Limiting](#46-rate-limiting)
   - [Answer DB (Cache Layer)](#47-answer-db-cache-layer)
5. [Chrome Extension — `chrome-extension/`](#5-chrome-extension)
   - [File Map](#51-file-map)
   - [background.js — Message API](#52-backgroundjs--message-api)
   - [content_script.js — Automation Engine](#53-content_scriptjs--automation-engine)
   - [popup.js / popup.html](#54-popupjs--popuphtml)
   - [Loading in Chrome (Dev)](#55-loading-in-chrome-dev)
6. [Authentication Flow](#6-authentication-flow)
7. [Payment Flow (Stripe)](#7-payment-flow-stripe)
8. [HWID Locking](#8-hwid-locking)
9. [Live Dashboard](#9-live-dashboard)
10. [Deploying to Production](#10-deploying-to-production)
11. [Common Issues & Fixes](#11-common-issues--fixes)
12. [Adding New Activity Types](#12-adding-new-activity-types)

---

## 1. Project Overview

Silent Study is a **Chrome Extension + Node.js backend** system that automates Edgenuity LMS activity completion for paying users. It replaces the original Playwright server-side approach with an in-browser architecture.

**Key design decisions:**
- The extension runs *inside the user's own Chrome*, piggybacking their existing Edgenuity session — no credentials are ever sent to the server.
- The backend is a REST API + Socket.IO server. It handles auth, payments, AI question solving, and live dashboard streaming.
- An **Answer DB** (MongoDB) caches every AI answer. The second user to see the same question gets an instant free answer — no OpenAI call needed.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Chrome Browser (User's machine)                                 │
│                                                                  │
│  ┌─────────────────┐     messages      ┌──────────────────────┐ │
│  │  popup.html/js  │ ◄────────────────► │   background.js      │ │
│  │  (Extension UI) │                   │   (Service Worker)   │ │
│  └─────────────────┘                   │   Holds JWT token    │ │
│                                        │   Proxies API calls  │ │
│  ┌─────────────────────────────────┐   └──────────┬───────────┘ │
│  │  Edgenuity Page + iframes       │              │ fetch()      │
│  │  ┌──────────────────────────┐   │              │             │
│  │  │  content_script.js       │   │              │             │
│  │  │  (Injected by manifest)  │ ──┼──────────────┘             │
│  │  │  Handles DOM automation  │   │  sendMessage('SOLVE'/'LOG') │
│  │  └──────────────────────────┘   │                            │
│  └─────────────────────────────────┘                            │
└─────────────────────────────────────────────────────────────────┘
                              │ HTTPS/WSS
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Node.js Backend  (Express 5 + Socket.IO)                        │
│                                                                  │
│  POST /api/auth/login      → returns JWT                         │
│  POST /api/solve           → DB lookup → OpenAI fallback         │
│  POST /api/log             → stores log + broadcasts to dashboard│
│  GET  /api/stats           → 24h activity stats                  │
│  POST /webhooks/stripe     → confirms payment, sets isPaid       │
│                                                                  │
│  MongoDB:                                                        │
│   users      — accounts, plan, expiry, HWID                      │
│   answers    — cached AI answers (grows forever)                 │
│   logs       — per-user activity timeline                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Repository Structure

```
bot-backend/
├── server.js                 # Express API + Socket.IO + all route handlers
├── brain.js                  # OpenAI integration (MCQ solver + essay writer)
├── package.json
├── .env                      # Local secrets — never commit this
├── .env.example              # Template for other devs
├── .gitignore
│
├── public/                   # Web dashboard (served statically by Express)
│   ├── index.html            # Dashboard HTML
│   ├── client.js             # Dashboard Socket.IO + login logic
│   └── style.css             # Dashboard styles
│
└── chrome-extension/         # Chrome Extension (Manifest V3)
    ├── manifest.json         # Extension config, permissions, content script rules
    ├── background.js         # Service worker — auth token storage, API proxy
    ├── content_script.js     # DOM automation engine (injected into Edgenuity pages)
    ├── popup.html            # Extension popup UI
    ├── popup.css             # Popup styles
    ├── popup.js              # Popup logic (login, toggle, stats display)
    └── icons/
        ├── icon16.png
        ├── icon48.png
        └── icon128.png
```

---

## 4. Backend

### 4.1 Setup & Running

**Prerequisites:** Node.js 18+, MongoDB

```bash
# 1. Clone & install
cd bot-backend
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your values (see section 4.2)

# 3. Start MongoDB (macOS/Homebrew)
brew services start mongodb/brew/mongodb-community

# 4. Start server
npm start          # production
npm run dev        # development (auto-restarts on file change)
```

Server starts at `http://localhost:3000` (or `PORT` from `.env`).

---

### 4.2 Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | HTTP port (default: `3000`) |
| `MONGO_URI` | Yes | MongoDB connection string |
| `JWT_SECRET` | Yes | Secret for signing JWTs — must be a long random string |
| `OPENAI_API_KEY` | Yes | OpenAI API key for AI fallback |
| `STRIPE_SECRET_KEY` | Yes | Stripe secret key (`sk_test_...` or `sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | Yes | Stripe webhook signing secret (`whsec_...`) |
| `FRONTEND_URL` | No | Shown in payment confirmation emails (default: `http://localhost:3000`) |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS origins. Chrome extensions are always allowed regardless of this. If empty, all origins are allowed. |
| `SMTP_HOST` | Yes | SMTP server hostname |
| `SMTP_PORT` | Yes | SMTP port (`465` for SSL, `587` for TLS) |
| `SMTP_USER` | Yes | SMTP username / email address |
| `SMTP_PASS` | Yes | SMTP password / app password |
| `SMTP_FROM` | Yes | From header, e.g. `"Silent Study <support@silentstudy.net>"` |

**Generating JWT_SECRET:**
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

### 4.3 Database Schemas

#### `User`
```
email        String  unique, required
password     String  bcrypt hashed (cost 12)
isPaid       Boolean default: false
plan         String  'day' | 'week' | 'month' | 'six_month'
addons       [String] e.g. ['service', 'proctor']
expiryDate   Date    subscription end date
licenseKey   String  'SS-XXXXXXXXXXXX' — generated on payment
hwid         String  SHA-256 fingerprint of first device that logged in
otp          String  temp 6-digit code (registration / password reset)
otpExpiry    Date    10 minutes from send time
createdAt    Date    default: now
```

#### `Answer` (the cache)
```
hash         String  SHA-256 of normalized question text, unique index
questionText String  raw question text (truncated to 2000 chars)
answer       String  the resolved answer
options      [String] MCQ options if applicable
activityType String  'mcq' | 'essay' | 'vocab' | 'dropdown' | 'checkbox'
source       String  'ai' (from OpenAI) | 'verified' (manually confirmed)
confidence   Number  0.0–1.0 (AI answers default to 0.7)
hitCount     Number  how many times this answer was served from cache
createdAt    Date    default: now
```

#### `Log`
```
userId       String  ref to User._id (string form)
event        String  event name, e.g. 'MCQ_ANSWERED', 'VIDEO_SKIP_DONE'
detail       String  extra info, e.g. the question text or answer chosen
timestamp    Date    default: now
```

---

### 4.4 API Reference

All protected routes require: `Authorization: Bearer <jwt>`

#### Auth

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| `POST` | `/send-otp` | No | `{ email }` | `{ success, message }` |
| `POST` | `/register` | No | `{ email, password, otp, plan?, addons? }` | `{ message, userId }` |
| `POST` | `/forgot-password` | No | `{ email }` | `{ success, message }` |
| `POST` | `/reset-password` | No | `{ email, otp, newPassword }` | `{ success, message }` |
| `POST` | `/api/auth/login` | No | `{ email, password }` | `{ token, expiresAt, plan, addons }` |
| `POST` | `/api/auth/bind-hwid` | Yes | `{ hwid }` | `{ success }` |

**Registration flow:**
1. `POST /send-otp` with email → OTP sent to email, user stub created in DB
2. `POST /register` with email + OTP + password → account activated

#### Payments

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| `POST` | `/create-checkout-session` | No | `{ planId, addons?, userId }` | `{ id, url }` |
| `POST` | `/webhooks/stripe` | Stripe sig | raw body | `{ received: true }` |

**`planId` values:** `day`, `week`, `month`, `six_month`

**Stripe webhook:** Must be registered in Stripe Dashboard pointing to `/webhooks/stripe`. On `checkout.session.completed`, the user's `isPaid`, `plan`, `expiryDate`, and `licenseKey` are set and a confirmation email is sent.

#### Core Bot API

| Method | Path | Auth | Rate Limit | Body | Response |
|---|---|---|---|---|---|
| `POST` | `/api/solve` | Yes | 120/min | `{ questionText, options?, activityType? }` | `{ answer, source, confidence }` |
| `POST` | `/api/log` | Yes | — | `{ event, detail? }` | `{ ok: true }` |
| `GET` | `/api/stats` | Yes | — | — | `{ questionsAnswered, videosSkipped, vocabCompleted, activitiesTotal, recentLogs }` |

**`/api/solve` flow:**
1. Normalise + SHA-256 hash the question text
2. Query `Answer` collection by hash → return cached result if found (increments `hitCount`)
3. If not found: call OpenAI (`brain.js`) → store result → return

**`source` field in response:**
- `"db"` — served from Answer cache (free, instant)
- `"ai"` — fresh OpenAI call (costs tokens)

---

### 4.5 Socket.IO Events

The dashboard connects via Socket.IO to receive live activity updates.

**Client → Server:**

| Event | Payload | Description |
|---|---|---|
| `authenticate` | `token` (JWT string) | Joins the user's private room. Must be sent immediately after `connect`. |

**Server → Client:**

| Event | Payload | Description |
|---|---|---|
| `authenticated` | `{ userId, plan }` | Confirms room join was successful |
| `auth-error` | `{ error }` | Token was invalid or expired |
| `activity-log` | `{ event, detail, timestamp }` | Emitted every time the bot calls `/api/log` |

---

### 4.6 Rate Limiting

| Limiter | Applied To | Window | Max Requests |
|---|---|---|---|
| `authLimiter` | `/send-otp`, `/api/auth/login`, `/forgot-password` | 1 minute | 10 |
| `solveLimiter` | `/api/solve` | 1 minute | 120 |

---

### 4.7 Answer DB (Cache Layer)

The `Answer` collection is the core cost-saving feature. Every question ever solved is stored by its SHA-256 hash. Hash computation:

```js
function hashQuestion(text) {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
```

Normalization (lowercase + collapse whitespace) ensures the same question phrased identically in different whitespace/casing still hits the cache.

**To manually mark an answer as verified** (boosts confidence to `1.0`):
```js
db.answers.updateOne(
  { hash: "<hash>" },
  { $set: { source: 'verified', confidence: 1.0 } }
)
```

---

## 5. Chrome Extension

### 5.1 File Map

| File | Role |
|---|---|
| `manifest.json` | Declares permissions, content script injection rules, service worker |
| `background.js` | Service worker. Stores JWT. All API calls go through here. |
| `content_script.js` | Injected into Edgenuity pages + iframes. Performs all DOM automation. |
| `popup.html` | Extension popup UI (login panel + dashboard panel) |
| `popup.css` | Dark-theme styles for the popup |
| `popup.js` | Popup logic — login, bot toggle, stats, live log |

### 5.2 background.js — Message API

`content_script.js` and `popup.js` never call the backend directly — they send messages to `background.js` which holds the JWT.

| Message Type | Sent By | Payload | Response |
|---|---|---|---|
| `LOGIN` | popup.js | `{ email, password }` | `{ success, plan, expiresAt }` or `{ success: false, error }` |
| `LOGOUT` | popup.js | — | `{ success: true }` |
| `TOGGLE_BOT` | popup.js | — | `{ botEnabled: true/false }` |
| `GET_STATUS` | popup.js | — | `{ loggedIn, botEnabled, plan, expiresAt }` |
| `SOLVE` | content_script.js | `{ questionText, options, activityType }` | `{ answer, source, confidence }` |
| `LOG` | content_script.js | `{ event, detail }` | (no response, fire-and-forget) |
| `BIND_HWID` | background.js (internal) | `{ hwid }` | (no response) |

**Storage keys** (`chrome.storage.local`):

| Key | Type | Description |
|---|---|---|
| `token` | String | JWT |
| `expiresAt` | String (ISO date) | Subscription expiry |
| `plan` | String | `'month'`, `'week'`, etc. |
| `addons` | Array | e.g. `['proctor']` |
| `botEnabled` | Boolean | Whether the bot is currently active |
| `lastLog` | Object | `{ event, detail }` — written by background to trigger popup update |

### 5.3 content_script.js — Automation Engine

Injected into every matching frame via `all_frames: true`. The script detects which frame it's in and activates the corresponding handler.

**Frame types:**

| Frame | Condition | Handler |
|---|---|---|
| Top frame | `window === window.top` | `initTopFrame()` |
| Activity iframe | URL contains `contentengine`, `LTILaunch`, `ContentViewers`, `edgenuity`, `edgex`, or `k12` | `initActivityFrame()` |
| Other iframes | neither | ignored |

**Top frame responsibilities (`initTopFrame`):**
- Clicks `em#frameProgress` to advance internal steps
- Clicks `a.footnav.goRight` to move to the next activity
- Watches for DOM changes with a 3500ms debounced MutationObserver

**Activity frame responsibilities (`initActivityFrame`):**
- Skips videos (`skipVideo`)
- Handles vocab activities (`handleVocab`)
- Answers questions (`handleQuestion`) in priority order:
  1. CKEditor rich text (essays)
  2. `contenteditable` div (empty — types answer)
  3. `textarea` (empty — types answer)
  4. Checkboxes (multi-select)
  5. Radio buttons (MCQ)
  6. `<select>` dropdown
- Clicks the submit/check button (`clickDone`)

**Human simulation techniques:**
- `humanDelay(min, max)` — randomised `setTimeout`
- `humanClick(el)` — dispatches `mouseover/mousedown/mouseup/click` MouseEvents instead of calling `.click()`
- Character-by-character typing in vocab activities

**MutationObserver anti-loop:**  
The observer is paused (`pauseActivityObserver`) before the bot makes any DOM changes (checking radios, typing) and resumed after a delay. This prevents infinite loops.

**`lastAnsweredHash`:** A module-level variable that stores the hash of the last question answered. The bot checks this before answering to avoid answering the same question twice during a DOM refresh cycle.

### 5.4 popup.js / popup.html

Two panels controlled by `hidden` class:
- `#panel-login` — shown when `GET_STATUS` returns `loggedIn: false`
- `#panel-dashboard` — shown after login

**Live log updates:** `popup.js` listens to `chrome.storage.onChanged`. When `background.js` writes `lastLog` to storage, the popup appends the entry to the log list immediately — no polling needed.

**Stats:** Loaded on dashboard show via `loadStats()`, which calls `GET /api/stats` directly (popup.js has `http://localhost:3000` hardcoded — update for production).

### 5.5 Loading in Chrome (Dev)

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle top-right)
3. Click **Load unpacked**
4. Select the `chrome-extension/` folder

After any code change: click the **refresh icon** on the extension card. For `content_script.js` changes, also reload the Edgenuity tab.

---

## 6. Authentication Flow

```
User                popup.js             background.js          backend
 │                     │                      │                     │
 │  enters email+pass  │                      │                     │
 │ ──────────────────► │                      │                     │
 │                     │  sendMessage(LOGIN)  │                     │
 │                     │ ────────────────────►│                     │
 │                     │                      │ POST /api/auth/login │
 │                     │                      │ ───────────────────► │
 │                     │                      │ ◄─ { token, plan }  │
 │                     │                      │                     │
 │                     │                      │ chrome.storage.set  │
 │                     │                      │  { token, plan, ... }│
 │                     │ ◄──{ success, plan } │                     │
 │ ◄─ dashboard shown  │                      │                     │
```

**Token lifecycle:**
- JWTs are valid for **7 days**
- `expiresAt` from the User's `expiryDate` is stored separately to gate subscription access
- The content script checks `token`, `expiresAt`, and `botEnabled` before doing anything

---

## 7. Payment Flow (Stripe)

```
Frontend/App           backend                    Stripe
     │                    │                          │
     │ POST /create-checkout-session                 │
     │ ─────────────────► │                          │
     │ ◄── { url }        │                          │
     │                    │                          │
     │ redirect to url ───┼──────────────────────── ►│
     │                    │                          │ user pays
     │                    │ ◄─── POST /webhooks/stripe│
     │                    │  (checkout.session.completed)
     │                    │                          │
     │                    │  User.isPaid = true      │
     │                    │  User.expiryDate = now+N │
     │                    │  User.licenseKey = SS-...│
     │                    │  sendEmail(confirmation) │
     │                    │ ──────────────────────── ►│ 200 OK
```

**For local webhook testing:**
```bash
stripe login
stripe listen --forward-to localhost:3000/webhooks/stripe
# Copy the printed whsec_... to your .env STRIPE_WEBHOOK_SECRET
```

**Plan pricing** (in cents):

| Plan ID | Name | Price |
|---|---|---|
| `day` | Day Key | $2.50 |
| `week` | Week Key | $10.00 |
| `month` | Month Key | $20.00 |
| `six_month` | 6 Months Key | $40.00 |

---

## 8. HWID Locking

On first login, `background.js` generates a hardware fingerprint:

```js
[navigator.userAgent, navigator.language, navigator.hardwareConcurrency,
 screen.width, screen.height, screen.colorDepth, timezone].join('|')
→ SHA-256 → first 32 hex chars
```

This is sent to `POST /api/auth/bind-hwid`. The backend:
- If `user.hwid` is null → stores the HWID (device is now locked)
- If `user.hwid` matches → allows login
- If `user.hwid` differs → returns `403 Account bound to a different device`

**To reset HWID** (e.g. user got a new computer):
```js
db.users.updateOne({ email: "user@example.com" }, { $unset: { hwid: "" } })
```

---

## 9. Live Dashboard

Accessible at `http://localhost:3000` (or your deployed domain).

**Login** with the same email/password as the extension.

The dashboard:
1. Calls `POST /api/auth/login` → gets JWT
2. Connects Socket.IO, emits `authenticate` with the token
3. Joins a private room keyed by `userId`
4. Listens for `activity-log` events (emitted by `/api/log` handler)
5. Also loads 24h historical stats via `GET /api/stats` on load

---

## 10. Deploying to Production

### Backend (e.g. Railway, Render, or VPS)

1. Set all environment variables from section 4.2
2. Set `MONGO_URI` to your MongoDB Atlas connection string
3. Set `FRONTEND_URL` to your deployed domain
4. Set `ALLOWED_ORIGINS` to your deployed domain

### Extension

After deploying, update two files before packaging:

**`chrome-extension/background.js` line 3:**
```js
const API_BASE = 'https://your-production-domain.com';
```

**`chrome-extension/popup.js` — inside `loadStats()`:**
```js
const backendBase = 'https://your-production-domain.com';
```

**`chrome-extension/manifest.json` — `host_permissions`:**
```json
"host_permissions": [
  "*://*.edgenuity.com/*",
  "*://*.edgex.com/*",
  "*://*.k12.com/*",
  "https://your-production-domain.com/*"
]
```

**Stripe webhook:** Register `https://your-production-domain.com/webhooks/stripe` in the Stripe Dashboard for event `checkout.session.completed`.

---

## 11. Common Issues & Fixes

### "Network error" in extension popup
- Is the server running? (`npm start`)
- Is `API_BASE` in `background.js` set to the correct URL?
- Is `http://localhost:3000/*` (or your domain) listed in `manifest.json` `host_permissions`?
- Did you reload the extension after changing `manifest.json`?

### "No active subscription"
- The user's `isPaid` is false or `expiryDate` is in the past.
- Fix via MongoDB directly:
  ```js
  db.users.updateOne({ email: "x@x.com" }, {
    $set: { isPaid: true, expiryDate: new Date("2027-12-31") }
  })
  ```

### "Account bound to a different device"
- Reset HWID: `db.users.updateOne({ email: "x@x.com" }, { $unset: { hwid: "" } })`

### Bot not activating on Edgenuity
- Ensure the extension is loaded and enabled in `chrome://extensions`
- Ensure bot toggle is ON in the popup
- Check the Edgenuity URL matches `*.edgenuity.com`, `*.edgex.com`, or `*.k12.com`
- Open DevTools in the Edgenuity tab → Console → look for `[SilentStudy]` logs
- Open `chrome://extensions` → Silent Study → **Service Worker** → Inspect → check for errors in `background.js`

### MutationObserver firing infinitely
- This is handled by `pauseActivityObserver()` / `resumeActivityObserver()` in `content_script.js`
- If you add new DOM manipulation, always wrap it between these calls

### MongoDB connection refused
- Start MongoDB: `brew services start mongodb/brew/mongodb-community`

---

## 12. Adding New Activity Types

**Step 1 — Handle in `content_script.js`**

Add a new handler function alongside `handleVocab()` and `handleQuestion()`:

```js
async function handleMyNewType() {
  // detect the activity elements, solve, interact
  const text = extractQuestionText();
  const result = await solve(text, [], 'mynewtype');
  // … interact with DOM using humanClick() / humanDelay()
  log('MYNEWTYPE_ANSWERED', result.answer);
}
```

Call it inside `runActivityCycle()`:
```js
async function runActivityCycle() {
  pauseActivityObserver();
  await skipVideo();
  await handleVocab();
  await handleMyNewType();   // ← add here
  await handleQuestion();
  // …
}
```

**Step 2 — Add type to backend schema**

In `server.js`, update the `activityType` enum in `answerSchema`:
```js
activityType: { type: String, enum: ['mcq', 'essay', 'vocab', 'dropdown', 'checkbox', 'mynewtype'], default: 'mcq' },
```

**Step 3 — Handle in `brain.js` if needed**

If the new type needs a special AI prompt (like essays), add a branch in `server.js`'s `/api/solve` handler:
```js
if (type === 'mynewtype') {
  answer = await solveMyNewType(questionText);
} else if (type === 'essay') {
  // …
```

**Step 4 — Add event label in `popup.js`**

```js
MYNEWTYPE_ANSWERED: 'My new activity answered',
```
