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

// ─── Tab navigation ──────────────────────────────────────────────────────────
let currentTab = 'activity';

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (tab === currentTab) return;
        currentTab = tab;

        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
        document.getElementById('tab-' + tab).classList.remove('hidden');

        if (tab === 'config') {
            const token = sessionStorage.getItem('dash_token');
            if (token) loadConfig(token);
        }
        if (tab === 'notes') {
            const token = sessionStorage.getItem('dash_token');
            if (token) loadNotes(token, 1);
        }
    });
});

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
    const placeholder = logs.querySelector('.log-entry.system');
    if (placeholder && logs.children.length === 1) placeholder.remove();

    const time = new Date().toLocaleTimeString();
    const el = document.createElement('div');
    el.className = 'log-entry ' + (type || '');
    el.textContent = '[' + time + '] ' + msg;
    logs.appendChild(el);
    logs.scrollTop = logs.scrollHeight;

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

// ─── Bot Config ───────────────────────────────────────────────────────────────
const configBotBadge = document.getElementById('configBotBadge');
const configLockedMsg = document.getElementById('configLockedMsg');
const configForm = document.getElementById('configForm');
const saveConfigBtn = document.getElementById('saveConfigBtn');
const configSaveMsg = document.getElementById('configSaveMsg');
const accuracySlider = document.getElementById('cfg-accuracy');
const accuracyVal = document.getElementById('accuracy-val');

accuracySlider.addEventListener('input', () => {
    accuracyVal.textContent = accuracySlider.value;
});

async function loadConfig(token) {
    try {
        const res = await fetch(API_BASE + '/api/config', {
            headers: { 'Authorization': 'Bearer ' + token },
        });
        const data = await res.json();
        if (!res.ok) return;

        const cfg = data.config;
        const botActive = data.botActive;

        // Populate form fields
        document.getElementById('cfg-autoAdvance').checked = cfg.autoAdvance;
        document.getElementById('cfg-autoSubmit').checked = cfg.autoSubmit;
        document.getElementById('cfg-autoAssessment').checked = cfg.autoAssessment;
        document.getElementById('cfg-autoAssignment').checked = cfg.autoAssignment;
        document.getElementById('cfg-autoWrite').checked = cfg.autoWrite;
        document.getElementById('cfg-autoProject').checked = cfg.autoProject;
        document.getElementById('cfg-autoVocab').checked = cfg.autoVocab;
        accuracySlider.value = cfg.assessmentAccuracy;
        accuracyVal.textContent = cfg.assessmentAccuracy;

        // Lock / unlock form based on bot status
        if (botActive) {
            configBotBadge.textContent = 'Bot Active';
            configBotBadge.className = 'badge active';
            configLockedMsg.classList.remove('hidden');
            configForm.classList.add('config-form-disabled');
        } else {
            configBotBadge.textContent = 'Bot Inactive';
            configBotBadge.className = 'badge';
            configLockedMsg.classList.add('hidden');
            configForm.classList.remove('config-form-disabled');
        }
    } catch (_) { }
}

saveConfigBtn.addEventListener('click', async () => {
    const token = sessionStorage.getItem('dash_token');
    if (!token) return;

    saveConfigBtn.disabled = true;
    saveConfigBtn.textContent = 'Saving…';
    configSaveMsg.classList.add('hidden');

    const body = {
        autoAdvance: document.getElementById('cfg-autoAdvance').checked,
        autoSubmit: document.getElementById('cfg-autoSubmit').checked,
        autoAssessment: document.getElementById('cfg-autoAssessment').checked,
        assessmentAccuracy: parseInt(accuracySlider.value, 10),
        autoAssignment: document.getElementById('cfg-autoAssignment').checked,
        autoWrite: document.getElementById('cfg-autoWrite').checked,
        autoProject: document.getElementById('cfg-autoProject').checked,
        autoVocab: document.getElementById('cfg-autoVocab').checked,
    };

    try {
        const res = await fetch(API_BASE + '/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        configSaveMsg.classList.remove('hidden');
        if (res.ok) {
            configSaveMsg.textContent = '✓ Configuration saved.';
            configSaveMsg.className = 'config-save-msg success';
        } else {
            configSaveMsg.textContent = data.error || 'Save failed.';
            configSaveMsg.className = 'config-save-msg error';
        }
    } catch (_) {
        configSaveMsg.textContent = 'Network error.';
        configSaveMsg.className = 'config-save-msg error';
        configSaveMsg.classList.remove('hidden');
    }

    saveConfigBtn.disabled = false;
    saveConfigBtn.textContent = 'Save Configuration';
    setTimeout(() => configSaveMsg.classList.add('hidden'), 3000);
});

// ─── eNotes ───────────────────────────────────────────────────────────────────
let notesCurrentPage = 1;

document.getElementById('refreshNotesBtn').addEventListener('click', () => {
    const token = sessionStorage.getItem('dash_token');
    if (token) loadNotes(token, notesCurrentPage);
});
document.getElementById('notesPrevBtn').addEventListener('click', () => {
    const token = sessionStorage.getItem('dash_token');
    if (token && notesCurrentPage > 1) loadNotes(token, notesCurrentPage - 1);
});
document.getElementById('notesNextBtn').addEventListener('click', () => {
    const token = sessionStorage.getItem('dash_token');
    if (token) loadNotes(token, notesCurrentPage + 1);
});

async function loadNotes(token, page) {
    page = page || 1;
    const container = document.getElementById('notes-container');
    const pagination = document.getElementById('notes-pagination');
    const notesCount = document.getElementById('notes-count');

    container.innerHTML = '<div class="notes-empty muted">Loading…</div>';

    try {
        const res = await fetch(API_BASE + '/api/notes?page=' + page + '&limit=20', {
            headers: { 'Authorization': 'Bearer ' + token },
        });
        const data = await res.json();
        if (!res.ok) { container.innerHTML = '<div class="notes-empty muted">Failed to load notes.</div>'; return; }

        notesCurrentPage = data.page;
        notesCount.textContent = data.total + ' total';

        if (!data.notes || data.notes.length === 0) {
            container.innerHTML = '<div class="notes-empty muted">No notes yet — answered questions will appear here.</div>';
            pagination.classList.add('hidden');
            return;
        }

        container.innerHTML = '';
        data.notes.forEach(note => {
            const card = document.createElement('div');
            card.className = 'note-card';
            const time = new Date(note.timestamp).toLocaleString();
            card.innerHTML =
                '<div class="note-card-header">' +
                '<span class="note-type-badge">' + (note.activityType || 'mcq') + '</span>' +
                '<span class="note-source-badge ' + (note.source || 'ai') + '">' + (note.source === 'db' ? 'cached' : 'ai') + '</span>' +
                '<span class="note-timestamp">' + time + '</span>' +
                '</div>' +
                '<div class="note-question">' + escHtml(note.questionText || '') + '</div>' +
                '<div class="note-answer">' + escHtml(note.answer || '') + '</div>';
            container.appendChild(card);
        });

        // Pagination controls
        document.getElementById('notesPageInfo').textContent = 'Page ' + data.page + ' of ' + data.pages;
        document.getElementById('notesPrevBtn').disabled = data.page <= 1;
        document.getElementById('notesNextBtn').disabled = data.page >= data.pages;
        pagination.classList.toggle('hidden', data.pages <= 1);
    } catch (_) {
        container.innerHTML = '<div class="notes-empty muted">Network error.</div>';
    }
}

function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
