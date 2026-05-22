'use strict';

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const panelLogin = document.getElementById('panel-login');
const panelDashboard = document.getElementById('panel-dashboard');
const loginError = document.getElementById('login-error');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const btnLogin = document.getElementById('btn-login');
const btnLogout = document.getElementById('btn-logout');
const btnToggle = document.getElementById('btn-toggle');
const infoPlan = document.getElementById('info-plan');
const infoExpiry = document.getElementById('info-expiry');
const statQuestions = document.getElementById('stat-questions');
const statVideos = document.getElementById('stat-videos');
const statVocab = document.getElementById('stat-vocab');
const logList = document.getElementById('log-list');

// ─── State ────────────────────────────────────────────────────────────────────
const stats = { questions: 0, videos: 0, vocab: 0 };

// ─── Init ─────────────────────────────────────────────────────────────────────
chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (status) => {
    if (status && status.loggedIn) {
        showDashboard(status);
    } else {
        showLogin();
    }
});

// Live log events from content script (relayed through background → storage)
chrome.storage.onChanged.addListener((changes) => {
    if (changes.lastLog) {
        const entry = changes.lastLog.newValue;
        if (entry) appendLog(entry.event, entry.detail);
    }
    if (changes.botEnabled) {
        setBotToggle(changes.botEnabled.newValue === true);
    }
});

// ─── Login ────────────────────────────────────────────────────────────────────
btnLogin.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
        showError('Please enter your email and password.');
        return;
    }

    btnLogin.disabled = true;
    btnLogin.textContent = 'Logging in…';
    hideError();

    chrome.runtime.sendMessage({ type: 'LOGIN', email, password }, (res) => {
        btnLogin.disabled = false;
        btnLogin.textContent = 'Log In';

        if (res && res.success) {
            showDashboard({ loggedIn: true, plan: res.plan, expiresAt: res.expiresAt, botEnabled: true });
        } else {
            showError((res && res.error) || 'Login failed. Check your credentials.');
        }
    });
});

passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnLogin.click();
});

// ─── Logout ───────────────────────────────────────────────────────────────────
btnLogout.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'LOGOUT' }, () => showLogin());
});

// ─── Bot Toggle ───────────────────────────────────────────────────────────────
btnToggle.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'TOGGLE_BOT' }, (res) => {
        if (res) setBotToggle(res.botEnabled);
    });
});

// ─── UI Helpers ───────────────────────────────────────────────────────────────
function showLogin() {
    panelLogin.classList.remove('hidden');
    panelDashboard.classList.add('hidden');
}

function showDashboard(status) {
    panelLogin.classList.add('hidden');
    panelDashboard.classList.remove('hidden');

    infoPlan.textContent = (status.plan || 'active').toUpperCase();
    infoExpiry.textContent = status.expiresAt
        ? new Date(status.expiresAt).toLocaleDateString()
        : '—';

    setBotToggle(status.botEnabled !== false);
    loadStats();
}

function setBotToggle(enabled) {
    if (enabled) {
        btnToggle.classList.add('on');
        btnToggle.classList.remove('off');
    } else {
        btnToggle.classList.add('off');
        btnToggle.classList.remove('on');
    }
}

function showError(msg) {
    loginError.textContent = msg;
    loginError.classList.remove('hidden');
}
function hideError() {
    loginError.classList.add('hidden');
}

function appendLog(event, detail) {
    // Remove "No activity yet" placeholder
    const placeholder = logList.querySelector('.log-item.muted');
    if (placeholder) placeholder.remove();

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const friendly = eventToLabel(event);

    const div = document.createElement('div');
    div.className = 'log-item ' + eventToClass(event);
    div.innerHTML = '<span class="log-time">' + time + '</span>' +
        '<span class="log-event">' + friendly + '</span>';

    logList.insertBefore(div, logList.firstChild);

    // Cap at 30 entries
    while (logList.children.length > 30) logList.removeChild(logList.lastChild);

    // Update stats
    if (event.includes('ANSWERED')) { stats.questions++; statQuestions.textContent = stats.questions; }
    if (event === 'VIDEO_SKIP_DONE') { stats.videos++; statVideos.textContent = stats.videos; }
    if (event === 'VOCAB_DONE') { stats.vocab++; statVocab.textContent = stats.vocab; }
}

function loadStats() {
    chrome.storage.local.get(['token'], ({ token }) => {
        if (!token) return;
        // Load today's stats from backend
        const backendBase = 'http://127.0.0.1:3000';
        fetch(backendBase + '/api/stats', {
            headers: { 'Authorization': 'Bearer ' + token },
        })
            .then(r => r.json())
            .then(data => {
                if (data.questionsAnswered !== undefined) {
                    stats.questions = data.questionsAnswered;
                    stats.videos = data.videosSkipped;
                    stats.vocab = data.vocabCompleted;
                    statQuestions.textContent = stats.questions;
                    statVideos.textContent = stats.videos;
                    statVocab.textContent = stats.vocab;

                    // Populate recent logs
                    if (data.recentLogs && data.recentLogs.length > 0) {
                        logList.innerHTML = '';
                        data.recentLogs.slice(0, 15).forEach(entry => {
                            appendLog(entry.event, entry.detail || '');
                        });
                    }
                }
            })
            .catch(() => { });
    });
}

function eventToLabel(event) {
    const map = {
        MCQ_ANSWERED: 'Question answered (MCQ)',
        CHECKBOX_ANSWERED: 'Question answered (multi-select)',
        ESSAY_ANSWERED: 'Essay written',
        TEXTAREA_ANSWERED: 'Short answer written',
        CONTENTEDITABLE_ANSWERED: 'Response written',
        DROPDOWN_ANSWERED: 'Dropdown answered',
        VIDEO_SKIP_START: 'Skipping video…',
        VIDEO_SKIP_DONE: 'Video skipped',
        VOCAB_START: 'Vocab activity started',
        VOCAB_DONE: 'Vocab activity complete',
        NEXT_ACTIVITY_CLICKED: 'Moved to next activity',
        INTERNAL_STEP: 'Advanced internal step',
        DONE_CLICKED: 'Submitted answer',
        ACTIVITY_FRAME_READY: 'Activity frame loaded',
        TOP_FRAME_READY: 'Page ready',
    };
    return map[event] || event.replace(/_/g, ' ').toLowerCase();
}

function eventToClass(event) {
    if (event.includes('ANSWERED') || event === 'VIDEO_SKIP_DONE' || event === 'VOCAB_DONE') return 'success';
    if (event.includes('ERROR') || event.includes('FAILED')) return 'error';
    return '';
}
