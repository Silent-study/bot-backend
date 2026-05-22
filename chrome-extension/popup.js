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

// ─── Popup Tab Navigation ─────────────────────────────────────────────────────
document.querySelectorAll('.popup-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.ptab;
        document.querySelectorAll('.popup-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.popup-tab-panel').forEach(p => p.classList.add('hidden'));
        document.getElementById('ptab-' + tab).classList.remove('hidden');
        if (tab === 'config') loadExtConfig();
    });
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
    const placeholder = logList.querySelector('.log-item.muted');
    if (placeholder) placeholder.remove();

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const friendly = eventToLabel(event);

    const div = document.createElement('div');
    div.className = 'log-item ' + eventToClass(event);
    div.innerHTML = '<span class="log-time">' + time + '</span>' +
        '<span class="log-event">' + friendly + '</span>';

    logList.insertBefore(div, logList.firstChild);

    while (logList.children.length > 30) logList.removeChild(logList.lastChild);

    if (event.includes('ANSWERED')) { stats.questions++; statQuestions.textContent = stats.questions; }
    if (event === 'VIDEO_SKIP_DONE') { stats.videos++; statVideos.textContent = stats.videos; }
    if (event === 'VOCAB_DONE') { stats.vocab++; statVocab.textContent = stats.vocab; }
}

function loadStats() {
    chrome.storage.local.get(['token'], ({ token }) => {
        if (!token) return;
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

// ─── Extension Config ─────────────────────────────────────────────────────────
const CONFIG_FIELDS = [
    { key: 'autoAdvance', label: 'Auto Advance' },
    { key: 'autoSubmit', label: 'Auto Submit' },
    { key: 'autoAssessment', label: 'Auto Assessment' },
    { key: 'autoAssignment', label: 'Auto Assignment' },
    { key: 'autoWrite', label: 'Auto Write' },
    { key: 'autoProject', label: 'Auto Project' },
    { key: 'autoVocab', label: 'Auto Vocab / Instructions' },
];

function loadExtConfig() {
    chrome.storage.local.get(['token', 'botEnabled'], ({ token, botEnabled }) => {
        if (!token) return;
        const backendBase = 'http://127.0.0.1:3000';
        fetch(backendBase + '/api/config', {
            headers: { 'Authorization': 'Bearer ' + token },
        })
            .then(r => r.json())
            .then(data => {
                // Cache config locally so content script can read it
                if (data.config) chrome.storage.local.set({ botConfig: data.config });
                // Lock if server says active OR local toggle is on
                renderExtConfig(data.config, data.botActive || botEnabled === true);
            })
            .catch(() => {
                // Network error — lock based on local state only
                renderExtConfig({}, botEnabled === true);
            });
    });
}

function renderExtConfig(cfg, botActive) {
    const list = document.getElementById('ext-config-list');
    const lockedMsg = document.getElementById('ext-config-locked');
    const accuracyRow = document.getElementById('ext-accuracy-row');
    const accuracySlider = document.getElementById('ext-cfg-accuracy');
    const accuracyVal = document.getElementById('ext-accuracy-val');

    list.innerHTML = '';

    CONFIG_FIELDS.forEach(({ key, label }) => {
        const row = document.createElement('div');
        row.className = 'ext-cfg-row';
        row.innerHTML =
            '<span class="ext-cfg-label">' + label + '</span>' +
            '<label class="mini-switch">' +
            '<input type="checkbox" id="ext-cfg-' + key + '"' + (cfg[key] ? ' checked' : '') + (botActive ? ' disabled' : '') + '>' +
            '<span class="mini-slider"></span>' +
            '</label>';
        list.appendChild(row);
    });

    accuracyRow.classList.remove('hidden');
    accuracySlider.value = cfg.assessmentAccuracy || 75;
    accuracyVal.textContent = accuracySlider.value;
    accuracySlider.oninput = () => { accuracyVal.textContent = accuracySlider.value; };
    accuracySlider.disabled = botActive;

    const actionsEl = document.getElementById('ext-config-actions');
    const saveBtn = document.getElementById('ext-save-config');
    if (botActive) {
        lockedMsg.classList.remove('hidden');
        list.classList.add('ext-config-disabled');
        accuracyRow.classList.add('ext-config-disabled');
        actionsEl.classList.add('ext-config-disabled');
        saveBtn.disabled = true;
    } else {
        lockedMsg.classList.add('hidden');
        list.classList.remove('ext-config-disabled');
        accuracyRow.classList.remove('ext-config-disabled');
        actionsEl.classList.remove('ext-config-disabled');
        saveBtn.disabled = false;
    }
}

document.getElementById('ext-save-config').addEventListener('click', () => {
    chrome.storage.local.get(['token', 'botEnabled'], ({ token, botEnabled }) => {
        if (!token) return;
        if (botEnabled) {
            const saveMsg = document.getElementById('ext-save-msg');
            saveMsg.textContent = 'Stop the bot before changing config';
            saveMsg.className = 'ext-save-msg error';
            saveMsg.classList.remove('hidden');
            setTimeout(() => saveMsg.classList.add('hidden'), 2500);
            return;
        }
        const backendBase = 'http://127.0.0.1:3000';
        const saveBtn = document.getElementById('ext-save-config');
        const saveMsg = document.getElementById('ext-save-msg');
        const accuracySlider = document.getElementById('ext-cfg-accuracy');

        const body = { assessmentAccuracy: parseInt(accuracySlider.value, 10) };
        CONFIG_FIELDS.forEach(({ key }) => {
            const el = document.getElementById('ext-cfg-' + key);
            if (el) body[key] = el.checked;
        });

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';

        fetch(backendBase + '/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify(body),
        })
            .then(r => r.json())
            .then(data => {
                saveMsg.classList.remove('hidden');
                if (data.ok) {
                    // Update cached config so content script picks up new settings immediately
                    chrome.storage.local.set({ botConfig: body });
                    saveMsg.textContent = '✓ Saved';
                    saveMsg.className = 'ext-save-msg success';
                } else {
                    saveMsg.textContent = data.error || 'Error';
                    saveMsg.className = 'ext-save-msg error';
                }
                setTimeout(() => saveMsg.classList.add('hidden'), 2500);
            })
            .catch(() => {
                saveMsg.textContent = 'Network error';
                saveMsg.className = 'ext-save-msg error';
                saveMsg.classList.remove('hidden');
            })
            .finally(() => {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save';
            });
    });
});

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
