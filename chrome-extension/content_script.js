'use strict';

// ─── Frame Classification ─────────────────────────────────────────────────────
// content_script.js runs in EVERY frame on matching domains (all_frames: true).
// We detect which frame we're in and activate the matching handler.

const IS_TOP_FRAME = window === window.top;
const HREF = window.location.href;

const IS_ACTIVITY_FRAME = !IS_TOP_FRAME && (
    HREF.includes('contentengine') ||
    HREF.includes('LTILaunch') ||
    HREF.includes('ContentViewers') ||
    HREF.includes('edgenuity.com') ||
    HREF.includes('edgex.com') ||
    HREF.includes('k12.com')
);

// ─── Utilities ────────────────────────────────────────────────────────────────

function humanDelay(min, max) {
    const ms = min + Math.random() * (max - min);
    return new Promise(r => setTimeout(r, ms));
}

// Dispatch real DOM events instead of calling .click() directly
// (avoids basic synthetic-click bot detection)
function humanClick(el) {
    if (!el) return;
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

// Sends a message to background.js (which holds the auth token) to call /api/solve
function solve(questionText, options, activityType) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage(
            {
                type: 'SOLVE',
                questionText: questionText,
                options: options || [],
                activityType: activityType || 'mcq',
            },
            (response) => {
                resolve(response || { error: 'No response from background' });
            }
        );
    });
}

// Fire-and-forget log — goes to backend + live dashboard
function log(event, detail) {
    console.log('[SilentStudy]', event, detail || '');
    chrome.runtime.sendMessage({ type: 'LOG', event: event, detail: String(detail || '') });
}

// Check if the user is authenticated and the bot is enabled
function checkAuth() {
    return new Promise(resolve => {
        chrome.storage.local.get(['token', 'expiresAt', 'botEnabled'], (data) => {
            if (!data.token) { resolve(false); return; }
            if (!data.botEnabled) { resolve(false); return; }
            if (data.expiresAt && Date.now() > new Date(data.expiresAt).getTime()) {
                resolve(false); return;
            }
            resolve(true);
        });
    });
}

// Extract question text from the current frame body, stripping noise
function extractQuestionText() {
    const body = document.body;
    if (!body) return '';
    return body.innerText
        .split('\n')
        .map(l => l.trim())
        .filter(l =>
            l.length > 3 &&
            !l.includes('Headphones') &&
            !l.includes('Activity') &&
            !/^\d+$/.test(l) &&
            !/^[A-Z]$/.test(l)   // single letter labels like "A", "B"
        )
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 2000);
}

// ─── Activity Frame: Video Skip ───────────────────────────────────────────────

async function skipVideo(video) {
    log('VIDEO_SKIP_START');

    return new Promise(resolve => {
        let ticks = 0;

        const interval = setInterval(() => {
            ticks++;

            // Safety: give up after 60 ticks (~12s) even if video won't cooperate
            if (!video || ticks > 60) {
                clearInterval(interval);
                resolve();
                return;
            }

            if (video.ended || video.currentTime >= video.duration - 0.5) {
                video.currentTime = video.duration;
                video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
                video.dispatchEvent(new Event('ended', { bubbles: true }));
                clearInterval(interval);
                log('VIDEO_SKIP_DONE');
                resolve();
                return;
            }

            // Jump forward in chunks — fires timeupdate events Edgenuity listens for
            const jump = Math.min(video.currentTime + 20, video.duration - 0.5);
            video.currentTime = jump;
            video.dispatchEvent(new Event('timeupdate', { bubbles: true }));
        }, 200);
    });
}

// ─── Activity Frame: Vocab Handler ───────────────────────────────────────────

async function handleVocab() {
    log('VOCAB_START');

    const wordBtns = [...document.querySelectorAll('.plainbtn.alt')];
    if (wordBtns.length === 0) return;

    for (let i = 0; i < wordBtns.length; i++) {
        const btn = wordBtns[i];

        // Skip already completed words
        if (btn.classList.contains('complete') || btn.classList.contains('visited')) continue;

        const word = btn.innerText ? btn.innerText.trim() : '';
        if (!word) continue;

        log('VOCAB_WORD', word);

        // Click the word button
        humanClick(btn);
        await humanDelay(700, 1300);

        // Type the word into the input field
        const input = document.querySelector('.word-textbox');
        if (input) {
            input.value = '';
            input.dispatchEvent(new Event('focus', { bubbles: true }));

            for (const char of word) {
                input.value += char;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                await humanDelay(70, 130);
            }

            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
            await humanDelay(500, 900);
        }

        // Play all audio buttons (definition + usage)
        const playBtns = [...document.querySelectorAll('.playbutton.vocab-play')];
        for (const pb of playBtns) {
            humanClick(pb);
            await humanDelay(1200, 2200);
        }

        // Click Next
        await humanDelay(2000, 3500);
        const nextBtn = document.querySelector('.uibtn-arrow-next');
        if (nextBtn && nextBtn.offsetParent !== null) {
            humanClick(nextBtn);
            await humanDelay(1000, 1800);
        }
    }

    log('VOCAB_DONE');
}

// ─── Activity Frame: Question Solver ─────────────────────────────────────────

// Mark answered to prevent re-answering same question after MutationObserver fires
let lastAnsweredHash = '';

async function handleQuestion() {
    const questionText = extractQuestionText();
    if (!questionText || questionText.length < 10) return false;

    // Simple hash to avoid re-answering the same question in the same frame
    const hash = questionText.slice(0, 80);
    if (hash === lastAnsweredHash) return false;

    // ── CKEditor (essays / extended responses) ──────────────────────────────────
    if (window.CKEDITOR) {
        const instances = window.CKEDITOR.instances || {};
        const names = Object.keys(instances);
        if (names.length > 0) {
            const { answer, error } = await solve(questionText, [], 'essay');
            if (!error && answer) {
                const name = names.find(n => instances[n].elementMode !== 3) || names[0];
                instances[name].setData(answer);
                instances[name].fire('change');
                lastAnsweredHash = hash;
                log('ESSAY_ANSWERED');
                await humanDelay(2000, 4000);
                clickDone();
                return true;
            }
        }
    }

    // ── contenteditable (non-CKEditor rich text) ─────────────────────────────────
    const editables = [...document.querySelectorAll('[contenteditable="true"]')]
        .filter(el => el.offsetParent !== null && el.innerText.trim().length === 0);
    if (editables.length > 0) {
        const { answer, error } = await solve(questionText, [], 'essay');
        if (!error && answer) {
            editables[0].focus();
            editables[0].innerText = answer;
            editables[0].dispatchEvent(new Event('input', { bubbles: true }));
            editables[0].dispatchEvent(new Event('change', { bubbles: true }));
            lastAnsweredHash = hash;
            log('CONTENTEDITABLE_ANSWERED');
            await humanDelay(2000, 4000);
            clickDone();
            return true;
        }
    }

    // ── Textarea (open response / short answer) ───────────────────────────────────
    const textareas = [...document.querySelectorAll('textarea')]
        .filter(el => el.offsetParent !== null && el.value.trim().length === 0);
    if (textareas.length > 0) {
        const { answer, error } = await solve(questionText, [], 'essay');
        if (!error && answer) {
            textareas[0].focus();
            textareas[0].value = answer;
            textareas[0].dispatchEvent(new Event('input', { bubbles: true }));
            textareas[0].dispatchEvent(new Event('change', { bubbles: true }));
            lastAnsweredHash = hash;
            log('TEXTAREA_ANSWERED');
            await humanDelay(2000, 4000);
            clickDone();
            return true;
        }
    }

    // ── Checkbox (multi-select MCQ) ───────────────────────────────────────────────
    const checkboxes = [...document.querySelectorAll('input[type="checkbox"]')]
        .filter(el => el.offsetParent !== null);
    if (checkboxes.length > 0) {
        const options = checkboxes
            .map(cb => (cb.closest('label') ? cb.closest('label').innerText : (cb.nextElementSibling ? cb.nextElementSibling.innerText : '')).trim())
            .filter(Boolean);

        if (options.length > 0) {
            const { answer, error } = await solve(questionText, options, 'checkbox');
            if (!error && answer) {
                const answers = answer.split(/[,;]/).map(a => a.trim().toLowerCase());
                let checked = false;

                checkboxes.forEach((cb, i) => {
                    const opt = (options[i] || '').toLowerCase();
                    if (answers.some(a => opt.includes(a) || a.includes(opt))) {
                        cb.checked = true;
                        cb.dispatchEvent(new Event('change', { bubbles: true }));
                        humanClick(cb);
                        checked = true;
                    }
                });

                if (checked) {
                    lastAnsweredHash = hash;
                    log('CHECKBOX_ANSWERED', answer);
                    await humanDelay(1000, 2000);
                    clickDone();
                    return true;
                }
            }
        }
    }

    // ── Radio (standard MCQ) ──────────────────────────────────────────────────────
    const radios = [...document.querySelectorAll('input[type="radio"]')]
        .filter(el => el.offsetParent !== null);
    if (radios.length > 0) {
        // Skip if already answered
        if (radios.some(r => r.checked)) return false;

        const options = radios.map(r => {
            const label = r.closest('label');
            const sibling = r.nextElementSibling;
            return (label ? label.innerText : (sibling ? sibling.innerText : '')).trim();
        });

        const filtered = options.filter(Boolean);
        if (filtered.length > 0) {
            const { answer, error } = await solve(questionText, filtered, 'mcq');
            if (!error && answer) {
                const answerLower = answer.toLowerCase();
                let picked = false;

                for (let i = 0; i < radios.length; i++) {
                    const optLower = (options[i] || '').toLowerCase();
                    if (optLower.includes(answerLower) || answerLower.includes(optLower)) {
                        radios[i].checked = true;
                        radios[i].dispatchEvent(new Event('change', { bubbles: true }));
                        humanClick(radios[i]);
                        picked = true;
                        lastAnsweredHash = hash;
                        log('MCQ_ANSWERED', answer);
                        await humanDelay(900, 1800);
                        clickDone();
                        return true;
                    }
                }

                // Fallback: pick first radio if AI answer doesn't match any option exactly
                if (!picked) {
                    radios[0].checked = true;
                    radios[0].dispatchEvent(new Event('change', { bubbles: true }));
                    humanClick(radios[0]);
                    lastAnsweredHash = hash;
                    log('MCQ_FALLBACK', 'answer: ' + answer + ' | option: ' + (options[0] || '?'));
                    await humanDelay(900, 1800);
                    clickDone();
                    return true;
                }
            }
        }
    }

    // ── Dropdown (select elements) ────────────────────────────────────────────────
    const selects = [...document.querySelectorAll('select')]
        .filter(el => el.offsetParent !== null);
    if (selects.length > 0) {
        let answered = false;

        for (const sel of selects) {
            const options = [...sel.options]
                .map(o => o.text.trim())
                .filter(o => o && o !== 'Select...' && o !== '-' && o !== '');

            if (options.length === 0) continue;

            const { answer, error } = await solve(questionText, options, 'dropdown');
            if (!error && answer) {
                const answerLower = answer.toLowerCase();
                for (const opt of sel.options) {
                    if (opt.text.toLowerCase().includes(answerLower) || answerLower.includes(opt.text.toLowerCase())) {
                        sel.value = opt.value;
                        sel.dispatchEvent(new Event('change', { bubbles: true }));
                        answered = true;
                        break;
                    }
                }
            }
        }

        if (answered) {
            lastAnsweredHash = hash;
            log('DROPDOWN_ANSWERED');
            await humanDelay(1000, 2000);
            clickDone();
            return true;
        }
    }

    return false;
}

// ─── Activity Frame: Submit / Done ────────────────────────────────────────────

function clickDone() {
    const candidates = [
        'span#btnCheck',
        '#btnCheck',
        '#btnSubmit',
        'input[type="button"][value="Submit"]',
        'input[type="submit"]',
        'button[id*="Check"]',
        'button[id*="Submit"]',
        '.uibtn:not(.uibtn-arrow-next)',
    ];

    for (const s of candidates) {
        try {
            const el = document.querySelector(s);
            if (el && el.offsetParent !== null) {
                humanClick(el);
                log('DONE_CLICKED', s);
                return true;
            }
        } catch (_) { }
    }
    return false;
}

// ─── Activity Frame: Main Cycle ───────────────────────────────────────────────

let activityObserver = null;
let activityDebounce = null;
let isRunningCycle = false;

async function runActivityCycle() {
    if (isRunningCycle) return;
    isRunningCycle = true;

    pauseActivityObserver();

    try {
        await humanDelay(1500, 3000);

        // 1. Video
        const video = document.querySelector('video');
        if (video && !video.ended && video.readyState >= 2) {
            await skipVideo(video);
            await humanDelay(1000, 2000);
        }

        // 2. Vocab
        if (document.querySelector('.word-textbox')) {
            await handleVocab();
            await humanDelay(1000, 2000);
        } else {
            // 3. Questions
            await handleQuestion();
        }
    } catch (err) {
        console.error('[SilentStudy] Activity cycle error:', err);
    }

    isRunningCycle = false;

    // Resume observer after work completes (prevents infinite loop from own DOM mutations)
    await humanDelay(2000, 4000);
    resumeActivityObserver();
}

function pauseActivityObserver() {
    if (activityObserver) { activityObserver.disconnect(); }
}

function resumeActivityObserver() {
    if (activityObserver) {
        activityObserver.observe(document.body, { childList: true, subtree: true });
    }
}

async function initActivityFrame() {
    const enabled = await checkAuth();
    if (!enabled) {
        console.log('[SilentStudy] Not authenticated or bot disabled — activity frame inactive.');
        return;
    }

    log('ACTIVITY_FRAME_READY', HREF.slice(0, 60));

    // Initial run after frame settles
    await humanDelay(2000, 4000);
    await runActivityCycle();

    // Watch for new content loading in the same frame (next question, etc.)
    activityObserver = new MutationObserver(() => {
        clearTimeout(activityDebounce);
        activityDebounce = setTimeout(async () => {
            const enabled = await checkAuth();
            if (enabled && !isRunningCycle) runActivityCycle();
        }, 1800);
    });

    resumeActivityObserver();

    // Also respond to BOT_STATE_CHANGED from background
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'BOT_STATE_CHANGED') {
            if (msg.enabled) {
                runActivityCycle();
                resumeActivityObserver();
            } else {
                pauseActivityObserver();
            }
        }
    });
}

// ─── Top Frame: Navigation ────────────────────────────────────────────────────

function handleInternalSteps() {
    const progress = document.querySelector('em#frameProgress');
    if (!progress) return false;

    const text = progress.innerText || '';
    const match = text.match(/(\d+)\s+of\s+(\d+)/);
    if (!match) return false;

    const current = parseInt(match[1], 10);
    const total = parseInt(match[2], 10);
    if (current >= total) return false;

    const boxes = document.querySelectorAll('.FramesList a');
    // boxes[current] is the (current+1)th step — the NEXT one to click
    const next = boxes[current];
    if (next && next.offsetParent !== null) {
        humanClick(next);
        log('INTERNAL_STEP', current + 1 + ' of ' + total);
        return true;
    }
    return false;
}

function clickNextActivity() {
    const candidates = ['a.footnav.goRight', '.footnav.goRight', 'a[class*="goRight"]'];
    for (const s of candidates) {
        const el = document.querySelector(s);
        if (el && el.offsetParent !== null) {
            humanClick(el);
            log('NEXT_ACTIVITY_CLICKED');
            return true;
        }
    }
    return false;
}

let topObserver = null;
let topDebounce = null;
let isRunningTop = false;

async function runTopCycle() {
    if (isRunningTop) return;
    isRunningTop = true;

    await humanDelay(3000, 6000);

    try {
        const movedStep = handleInternalSteps();
        if (!movedStep) {
            await humanDelay(1500, 3000);
            clickNextActivity();
        }
    } catch (err) {
        console.error('[SilentStudy] Top cycle error:', err);
    }

    isRunningTop = false;
}

async function initTopFrame() {
    const enabled = await checkAuth();
    if (!enabled) {
        console.log('[SilentStudy] Not authenticated or bot disabled — top frame inactive.');
        return;
    }

    log('TOP_FRAME_READY');

    // Run once after page settles
    await humanDelay(4000, 7000);
    await runTopCycle();

    // Watch for DOM changes: activity completion typically changes stageFrame src or footnav state
    topObserver = new MutationObserver(() => {
        clearTimeout(topDebounce);
        topDebounce = setTimeout(async () => {
            const enabled = await checkAuth();
            if (enabled && !isRunningTop) runTopCycle();
        }, 3500);
    });

    topObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'class'],
    });

    // Respond to BOT_STATE_CHANGED
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'BOT_STATE_CHANGED') {
            if (msg.enabled) {
                runTopCycle();
                if (topObserver) topObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class'] });
            } else {
                if (topObserver) topObserver.disconnect();
            }
        }
    });
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

if (IS_TOP_FRAME) {
    initTopFrame();
} else if (IS_ACTIVITY_FRAME) {
    initActivityFrame();
}
