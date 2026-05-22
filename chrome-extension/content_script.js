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

// Read cached bot config from local storage; defaults mirror server defaults
function getConfig() {
    return new Promise(resolve => {
        chrome.storage.local.get(['botConfig'], (data) => {
            const defaults = {
                autoAdvance: true, autoSubmit: true, autoAssessment: true,
                assessmentAccuracy: 75, autoAssignment: true, autoWrite: true,
                autoProject: true, autoVocab: true,
            };
            resolve(Object.assign({}, defaults, data.botConfig || {}));
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
                // Notify the stage frame (our parent) that this step's video is done.
                // This lets handleDirectInstruction() exit waitForStepComplete() early
                // instead of waiting out the full timeout.
                if (!IS_TOP_FRAME) window.parent.postMessage({ type: 'SILENTSTUDY_VIDEO_DONE' }, '*');
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

async function handleQuestion(cfg) {
    const questionText = extractQuestionText();
    if (!questionText || questionText.length < 10) return false;

    // Simple hash to avoid re-answering the same question in the same frame
    const hash = questionText.slice(0, 80);
    if (hash === lastAnsweredHash) return false;

    // ── CKEditor (essays / extended responses) ──────────────────────────────────
    if (cfg.autoWrite && window.CKEDITOR) {
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
                if (cfg.autoSubmit) clickDone();
                return true;
            }
        }
    }

    // ── contenteditable (non-CKEditor rich text) ─────────────────────────────────
    if (cfg.autoWrite) {
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
                if (cfg.autoSubmit) clickDone();
                return true;
            }
        }
    }

    // ── Textarea (open response / short answer) ───────────────────────────────────
    if (cfg.autoWrite) {
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
                if (cfg.autoSubmit) clickDone();
                return true;
            }
        }
    }

    // ── Checkbox / Radio / Dropdown — gated by autoAssessment ───────────────────
    if (cfg.autoAssessment) {
        // ── Checkbox (multi-select MCQ) ──────────────────────────────────────────
        const checkboxes = [...document.querySelectorAll('input[type="checkbox"]')]
            .filter(el => el.offsetParent !== null);
        if (checkboxes.length > 0) {
            const options = checkboxes
                .map(cb => (cb.closest('label') ? cb.closest('label').innerText : (cb.nextElementSibling ? cb.nextElementSibling.innerText : '')).trim())
                .filter(Boolean);

            if (options.length > 0) {
                const { answer, error } = await solve(questionText, options, 'checkbox');
                if (!error && answer) {
                    const shouldBeCorrect = Math.random() * 100 < cfg.assessmentAccuracy;
                    const answers = answer.split(/[,;]/).map(a => a.trim().toLowerCase());
                    let checked = false;

                    if (shouldBeCorrect) {
                        checkboxes.forEach((cb, i) => {
                            const opt = (options[i] || '').toLowerCase();
                            if (answers.some(a => opt.includes(a) || a.includes(opt))) {
                                cb.checked = true;
                                cb.dispatchEvent(new Event('change', { bubbles: true }));
                                humanClick(cb);
                                checked = true;
                            }
                        });
                    } else {
                        // Intentionally wrong: check non-matching options
                        const wrongBoxes = checkboxes.filter((cb, i) => {
                            const opt = (options[i] || '').toLowerCase();
                            return !answers.some(a => opt.includes(a) || a.includes(opt));
                        });
                        const toCheck = wrongBoxes.length > 0
                            ? wrongBoxes.slice(0, Math.ceil(checkboxes.length / 2))
                            : [checkboxes[0]];
                        toCheck.forEach(cb => {
                            cb.checked = true;
                            cb.dispatchEvent(new Event('change', { bubbles: true }));
                            humanClick(cb);
                            checked = true;
                        });
                    }

                    if (checked) {
                        lastAnsweredHash = hash;
                        log(shouldBeCorrect ? 'CHECKBOX_ANSWERED' : 'CHECKBOX_INTENTIONAL_MISS',
                            shouldBeCorrect ? answer : cfg.assessmentAccuracy + '%');
                        await humanDelay(1000, 2000);
                        if (cfg.autoSubmit) clickDone();
                        return true;
                    }
                }
            }
        }

        // ── Radio (standard MCQ) ─────────────────────────────────────────────────
        const radios = [...document.querySelectorAll('input[type="radio"]')]
            .filter(el => el.offsetParent !== null);
        if (radios.length > 0) {
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
                    const shouldBeCorrect = Math.random() * 100 < cfg.assessmentAccuracy;
                    const answerLower = answer.toLowerCase();

                    if (shouldBeCorrect) {
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
                                if (cfg.autoSubmit) clickDone();
                                return true;
                            }
                        }
                        if (!picked) {
                            radios[0].checked = true;
                            radios[0].dispatchEvent(new Event('change', { bubbles: true }));
                            humanClick(radios[0]);
                            lastAnsweredHash = hash;
                            log('MCQ_FALLBACK', 'answer: ' + answer + ' | option: ' + (options[0] || '?'));
                            await humanDelay(900, 1800);
                            if (cfg.autoSubmit) clickDone();
                            return true;
                        }
                    } else {
                        // Intentionally wrong: pick first option that does NOT match AI answer
                        let wrongPicked = false;
                        for (let i = 0; i < radios.length; i++) {
                            const optLower = (options[i] || '').toLowerCase();
                            if (!optLower.includes(answerLower) && !answerLower.includes(optLower)) {
                                radios[i].checked = true;
                                radios[i].dispatchEvent(new Event('change', { bubbles: true }));
                                humanClick(radios[i]);
                                wrongPicked = true;
                                lastAnsweredHash = hash;
                                log('MCQ_INTENTIONAL_MISS', cfg.assessmentAccuracy + '%');
                                await humanDelay(900, 1800);
                                if (cfg.autoSubmit) clickDone();
                                return true;
                            }
                        }
                        if (!wrongPicked) {
                            const fi = radios.length > 1 ? radios.length - 1 : 0;
                            radios[fi].checked = true;
                            radios[fi].dispatchEvent(new Event('change', { bubbles: true }));
                            humanClick(radios[fi]);
                            lastAnsweredHash = hash;
                            log('MCQ_INTENTIONAL_MISS_FALLBACK', cfg.assessmentAccuracy + '%');
                            await humanDelay(900, 1800);
                            if (cfg.autoSubmit) clickDone();
                            return true;
                        }
                    }
                }
            }
        }

        // ── Dropdown (select elements) ───────────────────────────────────────────
        const selects = [...document.querySelectorAll('select')]
            .filter(el => el.offsetParent !== null);
        if (selects.length > 0) {
            let answered = false;
            const shouldBeCorrect = Math.random() * 100 < cfg.assessmentAccuracy;

            for (const sel of selects) {
                const options = [...sel.options]
                    .map(o => o.text.trim())
                    .filter(o => o && o !== 'Select...' && o !== '-' && o !== '');

                if (options.length === 0) continue;

                const { answer, error } = await solve(questionText, options, 'dropdown');
                if (!error && answer) {
                    const answerLower = answer.toLowerCase();
                    if (shouldBeCorrect) {
                        for (const opt of sel.options) {
                            if (opt.text.toLowerCase().includes(answerLower) || answerLower.includes(opt.text.toLowerCase())) {
                                sel.value = opt.value;
                                sel.dispatchEvent(new Event('change', { bubbles: true }));
                                answered = true;
                                break;
                            }
                        }
                    } else {
                        for (const opt of sel.options) {
                            if (!opt.text.toLowerCase().includes(answerLower) && !answerLower.includes(opt.text.toLowerCase())) {
                                sel.value = opt.value;
                                sel.dispatchEvent(new Event('change', { bubbles: true }));
                                answered = true;
                                break;
                            }
                        }
                    }
                }
            }

            if (answered) {
                lastAnsweredHash = hash;
                log(shouldBeCorrect ? 'DROPDOWN_ANSWERED' : 'DROPDOWN_INTENTIONAL_MISS',
                    shouldBeCorrect ? '' : cfg.assessmentAccuracy + '%');
                await humanDelay(1000, 2000);
                if (cfg.autoSubmit) clickDone();
                return true;
            }
        }
    }

    // No supported question type found (or gated off by config)
    const visibleInputs = [
        document.querySelector('input[type="radio"]:not([style*="display:none"])') ? 'radio' : null,
        document.querySelector('input[type="checkbox"]:not([style*="display:none"])') ? 'checkbox' : null,
        document.querySelector('select') ? 'select' : null,
        document.querySelector('textarea') ? 'textarea' : null,
        document.querySelector('[contenteditable="true"]') ? 'contenteditable' : null,
        window.CKEDITOR ? 'ckeditor' : null,
    ].filter(Boolean).join(', ') || 'none';
    log('QUESTION_UNHANDLED', 'visible inputs on page: ' + visibleInputs);
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

// ─── Activity Frame: Direct Instruction (FrameChain multi-step video) ──────────

// Detects whether the current frame is a FrameChain stage frame
// (has the .FramesList navigation bar with .FrameRight step buttons)
function isDirectInstruction() {
    return !!(document.querySelector('.FramesList') && document.querySelector('.FramesList .FrameRight'));
}

// Parse "N of M" from #frameProgress and return { current, total } or null
function parseFrameProgress() {
    const el = document.querySelector('#frameProgress, em#frameProgress');
    if (!el) return null;
    const m = (el.innerText || '').match(/(\d+)\s*of\s*(\d+)/i);
    if (!m) return null;
    return { current: parseInt(m[1], 10), total: parseInt(m[2], 10) };
}

// Read both current position and total duration (seconds) from the stage frame's
// video controls UI.  The time display typically shows "0:32 / 9:56".
// Returns { current, total } or null if no controls are found.
function readVideoTimes() {
    const toSecs = m => m[3]
        ? parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3])
        : parseInt(m[1]) * 60 + parseInt(m[2]);
    const containers = [
        document.getElementById('frame_video_controls'),
        document.getElementById('frameVideoControls'),
        document.getElementById('frameNav'),
    ];
    for (const container of containers) {
        if (!container) continue;
        // Prefer dedicated time elements
        const timeEls = container.querySelectorAll('.Time, .time, [class*="time"], [class*="Time"]');
        for (const el of timeEls) {
            const matches = [...(el.innerText || '').matchAll(/(\d{1,2}):(\d{2})(?::(\d{2}))?/g)];
            if (matches.length >= 2) {
                const cur = toSecs(matches[0]);
                const tot = toSecs(matches[matches.length - 1]);
                if (tot > 0) return { current: cur, total: tot };
            }
            // Single time value — treat as total only
            if (matches.length === 1) {
                const tot = toSecs(matches[0]);
                if (tot > 0) return { current: 0, total: tot };
            }
        }
        // Fall back to raw container text
        const rawMatches = [...(container.innerText || '').matchAll(/(\d{1,2}):(\d{2})(?::(\d{2}))?/g)];
        if (rawMatches.length >= 2) {
            const cur = toSecs(rawMatches[0]);
            const tot = toSecs(rawMatches[rawMatches.length - 1]);
            if (tot > 0) return { current: cur, total: tot };
        }
        if (rawMatches.length === 1) {
            const tot = toSecs(rawMatches[0]);
            if (tot > 0) return { current: 0, total: tot };
        }
    }
    return null;
}

// Click the play button in the stage frame's video control overlay if the video is paused.
// Returns true if a play button was found and clicked.
function ensureVideoPlaying() {
    const candidates = [
        '#frame_video_controls .Play',
        '#frameVideoControls .Play',
        '.IpadPlay',
        '#frameArea .Play',
        '.Play',
    ];
    for (const s of candidates) {
        try {
            const el = document.querySelector(s);
            if (el && el.offsetParent !== null) {
                humanClick(el);
                return true;
            }
        } catch (_) { }
    }
    return false;
}

// Returns true if the stage frame video controls show a Play button (video is paused/stopped).
function isVideoPaused() {
    const playBtn = document.querySelector(
        '#frame_video_controls .Play, #frameVideoControls .Play, .IpadPlay, #frameArea .Play'
    );
    return !!(playBtn && playBtn.offsetParent !== null);
}

// Poll until step N is confirmed complete or timeout elapses.
// wasAlreadyComplete: true when FrameComplete was pre-set at watch-start
//   (Edgenuity sets it from server state even if video was never watched today).
//   In that case we skip the FrameComplete DOM check and rely on other signals.
// Returns true on confirmed completion, false on timeout.
async function waitForStepComplete(stepNumber, timeoutMs, wasAlreadyComplete) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await humanDelay(4000, 5000);

        // Signal 1: FrameComplete transition — only trust if it wasn't already set
        // when we started (pre-set = from a prior session, not this watch).
        if (!wasAlreadyComplete) {
            const frameEl = document.querySelector(`#frame${stepNumber}`);
            if (frameEl && frameEl.classList.contains('FrameComplete')) return true;
        }

        // Signal 2: .FrameRight got FrameHighlight (Edgenuity flashes it on completion)
        const rightBtn = document.querySelector('.FramesList .FrameRight, .FramesList li.FrameRight');
        if (rightBtn && rightBtn.classList.contains('FrameHighlight')) return true;

        // Signal 3: #frameProgress already advanced (step auto-clicked somehow)
        const prog = parseFrameProgress();
        if (prog && prog.current > stepNumber) return true;

        // Signal 4: video time display shows we're within 3 s of the end
        const times = readVideoTimes();
        if (times && times.total > 0 && (times.total - times.current) <= 3) return true;

        // Signal 5: content frame's skipVideo() posted SILENTSTUDY_VIDEO_DONE
        if (directInstructionVideoDone) {
            directInstructionVideoDone = false;
            return true;
        }
    }
    return false;
}

async function handleDirectInstruction() {
    log('DIRECT_INSTRUCTION_DETECTED');

    const MAX_STEPS = 30;        // safety cap — no lesson has 30+ steps
    const MAX_WAIT_PER_STEP = 25 * 60 * 1000;  // 25 min absolute ceiling per step
    const DEFAULT_DURATION_S = 120;  // fall-back if we can't read video length

    for (let attempt = 0; attempt < MAX_STEPS; attempt++) {
        await humanDelay(1500, 2500);

        const prog = parseFrameProgress();
        if (!prog) {
            log('DIRECT_INSTRUCTION_NO_PROGRESS');
            break;
        }

        const { current, total } = prog;

        // All steps finished — done
        if (current > total) {
            log('DIRECT_INSTRUCTION_COMPLETE', 'all ' + total + ' steps done');
            break;
        }

        // Note whether FrameComplete was pre-set before we started watching.
        // Edgenuity persists completion state server-side and re-applies it to
        // the DOM on load, even if the user never finished the video today.
        // When pre-set we skip the FrameComplete early-exit and rely on time
        // signals instead, so the bot actually watches the video.
        const wasAlreadyComplete = !!(document.querySelector(`#frame${current}.FrameComplete`));

        log('DIRECT_INSTRUCTION_STEP_START', current + ' of ' + total +
            (wasAlreadyComplete ? ' (pre-marked — watching anyway)' : ''));

        // ── Give the content iframe a moment to load ───────────────────────
        await humanDelay(2000, 3000);

        // ── Click play if the video loaded in a paused state ───────────────
        // Edgenuity videos start paused; the user (or bot) must press play.
        if (ensureVideoPlaying()) {
            log('DIRECT_INSTRUCTION_PLAY_CLICKED', 'step ' + current);
        } else {
            log('DIRECT_INSTRUCTION_PLAY_NOT_FOUND', 'step ' + current);
        }

        // ── Read video times (current position + total duration) ───────────
        let videoTimes = readVideoTimes();

        // Controls may not update instantly — retry once
        if (!videoTimes || !videoTimes.total) {
            await humanDelay(3000, 4000);
            if (ensureVideoPlaying()) {
                log('DIRECT_INSTRUCTION_PLAY_RETRY', 'step ' + current);
            }
            videoTimes = readVideoTimes();
        }

        const totalS = (videoTimes && videoTimes.total > 0) ? videoTimes.total : DEFAULT_DURATION_S;
        const currentS = (videoTimes && videoTimes.current >= 0) ? videoTimes.current : 0;
        const remainingS = Math.max(totalS - currentS, 5);

        if (!videoTimes || !videoTimes.total) {
            log('DIRECT_INSTRUCTION_DURATION_FALLBACK', totalS + 's default');
        } else {
            log('DIRECT_INSTRUCTION_VIDEO_TIMES',
                currentS + 's / ' + totalS + 's (~' + remainingS + 's remaining)');
        }

        log('DIRECT_INSTRUCTION_WAITING', 'step ' + current + ' ~' + remainingS + 's');

        // ── Poll while the video plays ─────────────────────────────────────
        // timeout = remaining video time + 30 s buffer (not the full duration).
        const stepDone = await waitForStepComplete(
            current,
            Math.min((remainingS + 30) * 1000, MAX_WAIT_PER_STEP),
            wasAlreadyComplete
        );

        if (stepDone) {
            log('DIRECT_INSTRUCTION_STEP_DONE', current + ' of ' + total);
        } else {
            log('DIRECT_INSTRUCTION_STEP_TIMEOUT', 'step ' + current + ' — trying anyway');
        }

        // ── All steps complete? ───────────────────────────────────────────────
        if (current >= total) {
            log('DIRECT_INSTRUCTION_COMPLETE', 'all ' + total + ' steps done');
            break;
        }

        // ── Click the ► (FrameRight) button to load the next step ────────────
        // Try <a> inside the <li> first, then the <li> itself (onclick on the li)
        const rightA = document.querySelector('.FramesList .FrameRight a, .FramesList li.FrameRight a');
        const rightLi = document.querySelector('.FramesList .FrameRight, .FramesList li.FrameRight');
        const target = rightA || rightLi;

        if (target && target.offsetParent !== null) {
            humanClick(target);
            log('DIRECT_INSTRUCTION_NEXT_CLICK', current + ' → ' + (current + 1));
        } else {
            log('DIRECT_INSTRUCTION_NEXT_MISSING', 'step ' + current);
        }

        // Wait for the next step frame to load before looping
        await humanDelay(4000, 6000);
    }
}

// ─── Activity Frame: Main Cycle ───────────────────────────────────────────────

let activityObserver = null;
let activityDebounce = null;
let isRunningCycle = false;
// Toggled by postMessage from the content frame inside #iFramePreview when
// skipVideo() completes.  Read and reset by waitForStepComplete() (Signal 5).
let directInstructionVideoDone = false;

async function runActivityCycle() {
    if (isRunningCycle) return;
    isRunningCycle = true;

    pauseActivityObserver();

    // Send the lock to the top frame BEFORE humanDelay so it arrives while the
    // top frame is still in its own debounce/humanDelay, preventing a premature
    // Next Activity click on activities that are pre-marked complete server-side.
    const isDI = isDirectInstruction();
    if (isDI) window.top.postMessage({ type: 'SILENTSTUDY_LOCK_NEXT' }, '*');

    try {
        await humanDelay(1500, 3000);

        const cfg = await getConfig();

        // 0. Direct Instruction — FrameChain multi-step video activity
        //    Detected by presence of .FramesList navigation in the stage frame.
        //    Must be checked BEFORE video/vocab/question to avoid mis-handling.
        if (isDI) {
            if (cfg.autoAssignment) {
                await handleDirectInstruction();
            } else {
                log('CONFIG_SKIP', 'autoAssignment off — skipping direct instruction');
            }
        } else {
            // 1. Video
            const video = document.querySelector('video');
            if (video && !video.ended && video.readyState >= 2) {
                if (cfg.autoAssignment) {
                    await skipVideo(video);
                    await humanDelay(1000, 2000);
                } else {
                    log('CONFIG_SKIP', 'autoAssignment off — skipping video');
                }
            }

            // 2. Vocab
            if (document.querySelector('.word-textbox')) {
                if (cfg.autoVocab) {
                    await handleVocab();
                    await humanDelay(1000, 2000);
                } else {
                    log('CONFIG_SKIP', 'autoVocab off — skipping vocab');
                }
            } else {
                // 3. Questions — cfg gates individual types inside handleQuestion
                await handleQuestion(cfg);
            }
        }
    } catch (err) {
        console.error('[SilentStudy] Activity cycle error:', err);
    } finally {
        // Always unlock, even on error, so the top frame isn't stuck.
        if (isDI) window.top.postMessage({ type: 'SILENTSTUDY_UNLOCK_NEXT' }, '*');
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

    // Receive SILENTSTUDY_VIDEO_DONE from the content frame inside #iFramePreview.
    // skipVideo() posts this when it finishes so waitForStepComplete() can exit early.
    window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'SILENTSTUDY_VIDEO_DONE') {
            directInstructionVideoDone = true;
        }
    });

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
    if (nextActivityLocked) {
        log('NEXT_ACTIVITY_LOCKED', 'activity frame busy — skipping');
        return false;
    }
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
// Set by activity frames via postMessage to block premature Next Activity clicks.
let nextActivityLocked = false;

async function runTopCycle() {
    if (isRunningTop) return;
    isRunningTop = true;

    await humanDelay(3000, 6000);

    try {
        const cfg = await getConfig();
        if (!cfg.autoAdvance) {
            log('CONFIG_SKIP', 'autoAdvance off — not moving to next activity');
        } else {
            const movedStep = handleInternalSteps();
            if (!movedStep) {
                await humanDelay(1500, 3000);
                clickNextActivity();
            }
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

    // Receive LOCK/UNLOCK from activity frames (stage frame during DirectInstruction).
    // Must be set up immediately — before any humanDelay — so signals sent by the
    // stage frame before our first runTopCycle() aren't missed.
    window.addEventListener('message', (event) => {
        if (!event.data || typeof event.data.type !== 'string') return;
        if (event.data.type === 'SILENTSTUDY_LOCK_NEXT') {
            nextActivityLocked = true;
            log('NEXT_ACTIVITY_LOCKED', 'activity frame started');
        } else if (event.data.type === 'SILENTSTUDY_UNLOCK_NEXT') {
            nextActivityLocked = false;
            log('NEXT_ACTIVITY_UNLOCKED', 'activity frame done');
            // Activity frame finished — trigger a top cycle now to click Next.
            if (!isRunningTop) runTopCycle();
        }
    });

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
