'use strict';

const API_BASE = ''; // same origin

// ─── DOM refs ────────────────────────────────────────────────────────────────
const panelAuth = document.getElementById('panel-auth');
const panelDashboard = document.getElementById('panel-dashboard');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const authError = document.getElementById('authError');
const logs = document.getElementById('logs');
const stateBadge = document.getElementById('stateBadge');
const connectionPulse = document.getElementById('connectionPulse');
const dashPlan = document.getElementById('dash-plan');
const dashExpiry = document.getElementById('dash-expiry');

const statEls = {
    questions: document.getElementById('stat-questions'),
    videos: document.getElementById('stat-videos'),
    vocab: document.getElementById('stat-vocab'),
    activities: document.getElementById('stat-activities'),
};

const stats = { questions: 0, videos: 0, vocab: 0, activities: 0 };

// ─── Socket.IO ───────────────────────────────────────────────────────────────
let socket = null;

function connectSocket(token, planInfo) {
    socket = io();

    socket.on('connect', () => {
        socket.emit('authenticate', token);
        setBadge('Live', 'active');
        connectionPulse.classList.add('active');
    });

    socket.on('authenticated', (data) => {
        dashPlan.textContent = (data.plan || 'active').toUpperCase();
        setBadge('Connected', 'active');
        loadStats(token);
    });

    socket.on('auth-error', () => {
        setBadge('Auth Error', 'error');
        addLog('Authentication error. Token may be expired.', 'error');
    });

    socket.on('activity-log', (entry) => {
        addLog(eventToLabel(entry.event) + (entry.detail ? ' — ' + entry.detail : ''), eventToType(entry.event));
        updateStat(entry.event);
    });

    socket.on('disconnect', () => {
        setBadge('Disconnected', '');
        connectionPulse.classList.remove('active');
    });
}

// ─── Auth ────────────────────────────────────────────────────────────────────
connectBtn.addEventListener('click', async () => {
    const email = document.getElementById('dashEmail').value.trim();
    const password = document.getElementById('dashPassword').value;

    if (!email || !password) {
        showError('Please enter your email and password.');
        return;
    }

    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting…';
    authError.classList.add('hidden');

    try {
        const res = await fetch(API_BASE + '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });
        const data = await res.json();

        if (!res.ok || !data.token) {
            showError(data.error || 'Login failed.');
            connectBtn.disabled = false;
            connectBtn.textContent = 'Connect';
            return;
        }

        // Store token for this session
        sessionStorage.setItem('dash_token', data.token);
        sessionStorage.setItem('dash_plan', data.plan || '');
        sessionStorage.setItem('dash_expiry', data.expiresAt || '');

        showDashboard(data.token, data);
    } catch (err) {
        showError('Network error. Is the server running?');
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect';
    }
});

disconnectBtn.addEventListener('click', () => {
    if (socket) socket.disconnect();
    sessionStorage.clear();
    showAuth();
});

// ─── UI Helpers ───────────────────────────────────────────────────────────────
function showAuth() {
    panelAuth.classList.remove('hidden');
    panelDashboard.classList.add('hidden');
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect';
}

function showDashboard(token, data) {
    panelAuth.classList.add('hidden');
    panelDashboard.classList.remove('hidden');

    dashPlan.textContent = (data.plan || '—').toUpperCase();
    dashExpiry.textContent = data.expiresAt
        ? 'Expires ' + new Date(data.expiresAt).toLocaleDateString()
        : '';

    connectSocket(token, data);
}

function showError(msg) {
    authError.textContent = msg;
    authError.classList.remove('hidden');
}

function setBadge(text, type) {
    stateBadge.textContent = text;
    stateBadge.className = 'badge';
    if (type) stateBadge.classList.add(type);
}

function addLog(msg, type) {
    // Remove placeholder
    const placeholder = logs.querySelector('.log-entry.system');
    if (placeholder && logs.children.length === 1) placeholder.remove();

    const time = new Date().toLocaleTimeString();
    const el = document.createElement('div');
    el.className = 'log-entry ' + (type || '');
    el.textContent = '[' + time + '] ' + msg;
    logs.appendChild(el);
    logs.scrollTop = logs.scrollHeight;

    // Cap at 200 entries
    while (logs.children.length > 200) logs.removeChild(logs.firstChild);
}

function updateStat(event) {
    if (event.includes('ANSWERED')) { stats.questions++; statEls.questions.textContent = stats.questions; }
    if (event === 'VIDEO_SKIP_DONE') { stats.videos++; statEls.videos.textContent = stats.videos; }
    if (event === 'VOCAB_DONE') { stats.vocab++; statEls.vocab.textContent = stats.vocab; }
    if (event === 'NEXT_ACTIVITY_CLICKED') { stats.activities++; statEls.activities.textContent = stats.activities; }
}

async function loadStats(token) {
    try {
        const res = await fetch(API_BASE + '/api/stats', {
            headers: { 'Authorization': 'Bearer ' + token },
        });
        const data = await res.json();
        if (data.questionsAnswered !== undefined) {
            stats.questions = data.questionsAnswered;
            stats.videos = data.videosSkipped;
            stats.vocab = data.vocabCompleted;
            stats.activities = data.activitiesTotal;
            Object.entries(statEls).forEach(([key, el]) => { el.textContent = stats[key] || 0; });

            if (data.recentLogs && data.recentLogs.length > 0) {
                logs.innerHTML = '';
                [...data.recentLogs].reverse().forEach(entry => {
                    addLog(eventToLabel(entry.event) + (entry.detail ? ' — ' + entry.detail : ''), eventToType(entry.event));
                });
            }
        }
    } catch (_) { }
}

// ─── Restore session on reload ────────────────────────────────────────────────
const savedToken = sessionStorage.getItem('dash_token');
const savedPlan = sessionStorage.getItem('dash_plan');
const savedExpiry = sessionStorage.getItem('dash_expiry');

if (savedToken) {
    showDashboard(savedToken, { plan: savedPlan, expiresAt: savedExpiry });
}

// ─── Event label helpers ──────────────────────────────────────────────────────
function eventToLabel(event) {
    const map = {
        MCQ_ANSWERED: 'Question answered (MCQ)',
        CHECKBOX_ANSWERED: 'Question answered (multi-select)',
        ESSAY_ANSWERED: 'Essay written',
        TEXTAREA_ANSWERED: 'Short answer written',
        CONTENTEDITABLE_ANSWERED: 'Rich text response written',
        DROPDOWN_ANSWERED: 'Dropdown answered',
        MCQ_FALLBACK: 'MCQ fallback used',
        VIDEO_SKIP_START: 'Video skip started',
        VIDEO_SKIP_DONE: 'Video skipped',
        VOCAB_START: 'Vocab activity started',
        VOCAB_WORD: 'Vocab word typed',
        VOCAB_DONE: 'Vocab activity complete',
        NEXT_ACTIVITY_CLICKED: 'Moved to next activity',
        INTERNAL_STEP: 'Advanced internal step',
        DONE_CLICKED: 'Answer submitted',
        ACTIVITY_FRAME_READY: 'Activity frame loaded',
        TOP_FRAME_READY: 'Page ready',
    };
    return map[event] || event.replace(/_/g, ' ');
}

function eventToType(event) {
    if (event.includes('ANSWERED') || event === 'VIDEO_SKIP_DONE' || event === 'VOCAB_DONE') return 'success';
    if (event.includes('ERROR') || event.includes('FALLBACK')) return 'warning';
    return '';
}
