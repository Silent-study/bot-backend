'use strict';

// Replace with your deployed backend URL
const API_BASE = 'https://silentstudy.net';

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    if (msg.type === 'LOGIN') {
        handleLogin(msg.email, msg.password).then(sendResponse);
        return true; // keep message channel open for async
    }

    if (msg.type === 'LOGOUT') {
        chrome.storage.local.clear(() => sendResponse({ success: true }));
        return true;
    }

    if (msg.type === 'TOGGLE_BOT') {
        chrome.storage.local.get(['botEnabled', 'token'], (data) => {
            const next = !data.botEnabled;
            chrome.storage.local.set({ botEnabled: next }, () => {
                sendResponse({ botEnabled: next });
                // Broadcast new state to all Edgenuity tabs
                broadcastToEdgenuityTabs({ type: 'BOT_STATE_CHANGED', enabled: next });
                // Notify server so the dashboard config tab can lock/unlock
                if (data.token) {
                    fetch(API_BASE + '/api/bot-status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + data.token },
                        body: JSON.stringify({ active: next }),
                    }).catch(() => { });
                    // When toggling ON, refresh cached config so content script has latest settings
                    if (next) {
                        fetch(API_BASE + '/api/config', {
                            headers: { 'Authorization': 'Bearer ' + data.token },
                        })
                            .then(r => r.json())
                            .then(cfg => { if (cfg.config) chrome.storage.local.set({ botConfig: cfg.config }); })
                            .catch(() => { });
                    }
                }
            });
        });
        return true;
    }

    if (msg.type === 'GET_STATUS') {
        chrome.storage.local.get(['token', 'expiresAt', 'plan', 'botEnabled'], (data) => {
            const isActive = data.token && data.expiresAt && Date.now() < new Date(data.expiresAt).getTime();
            sendResponse({
                loggedIn: !!isActive,
                botEnabled: data.botEnabled === true,
                plan: data.plan || null,
                expiresAt: data.expiresAt || null,
            });
        });
        return true;
    }

    // Content script calls this to get an answer from the backend
    if (msg.type === 'SOLVE') {
        chrome.storage.local.get(['token'], async ({ token }) => {
            if (!token) { sendResponse({ error: 'Not authenticated.' }); return; }
            try {
                const res = await fetch(API_BASE + '/api/solve', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token,
                    },
                    body: JSON.stringify({
                        questionText: msg.questionText,
                        options: msg.options || [],
                        activityType: msg.activityType || 'mcq',
                    }),
                });
                const data = await res.json();
                sendResponse(data);
            } catch (err) {
                sendResponse({ error: 'Network error: ' + err.message });
            }
        });
        return true;
    }

    // Content script calls this to log an event (feeds live dashboard)
    if (msg.type === 'LOG') {
        chrome.storage.local.get(['token'], ({ token }) => {
            if (!token) return;
            fetch(API_BASE + '/api/log', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token,
                },
                body: JSON.stringify({ event: msg.event, detail: msg.detail || '' }),
            }).catch(() => { }); // fire-and-forget
        });
        // no sendResponse needed
    }

    // Bind HWID on first launch
    if (msg.type === 'BIND_HWID') {
        chrome.storage.local.get(['token'], async ({ token }) => {
            if (!token) return;
            fetch(API_BASE + '/api/auth/bind-hwid', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token,
                },
                body: JSON.stringify({ hwid: msg.hwid }),
            }).catch(() => { });
        });
    }
});

// ─── Login Logic ──────────────────────────────────────────────────────────────
async function handleLogin(email, password) {
    try {
        const res = await fetch(API_BASE + '/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });
        const data = await res.json();

        if (!res.ok || !data.token) {
            return { success: false, error: data.error || 'Login failed.' };
        }

        await chrome.storage.local.set({
            token: data.token,
            expiresAt: data.expiresAt,
            plan: data.plan,
            addons: data.addons || [],
            botEnabled: true,
        });

        // Cache bot config so content script can read it immediately
        fetch(API_BASE + '/api/config', {
            headers: { 'Authorization': 'Bearer ' + data.token },
        })
            .then(r => r.json())
            .then(cfg => { if (cfg.config) chrome.storage.local.set({ botConfig: cfg.config }); })
            .catch(() => { });

        // Mark bot as inactive on server at login (fresh start)
        fetch(API_BASE + '/api/bot-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + data.token },
            body: JSON.stringify({ active: false }),
        }).catch(() => { });

        // Bind HWID in background after login
        const hwid = await generateHWID();
        fetch(API_BASE + '/api/auth/bind-hwid', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + data.token,
            },
            body: JSON.stringify({ hwid }),
        }).catch(() => { });

        return { success: true, plan: data.plan, expiresAt: data.expiresAt };
    } catch (err) {
        console.error('Login error:', err);
        return { success: false, error: 'Network error: ' + err.message };
    }
}

// ─── HWID Generator ───────────────────────────────────────────────────────────
// Generates a stable browser fingerprint using available stable signals
async function generateHWID() {
    const raw = [
        navigator.userAgent,
        navigator.language,
        navigator.hardwareConcurrency,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
    ].join('|');

    const msgBuffer = new TextEncoder().encode(raw);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// ─── Tab Broadcast Utility ────────────────────────────────────────────────────
function broadcastToEdgenuityTabs(message) {
    chrome.tabs.query({ url: ['*://*.edgenuity.com/*', '*://*.edgex.com/*', '*://*.k12.com/*'] }, (tabs) => {
        for (const tab of tabs) {
            chrome.tabs.sendMessage(tab.id, message).catch(() => { });
        }
    });
}
