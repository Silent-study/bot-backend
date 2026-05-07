const { solveQuestion, solveOpenQuestion } = require('./brain');

function humanDelay(min = 2000, max = 5000) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

// 📚 VOCABULARY
async function detectVocab(page) {
  const frame = await getWorkingFrame(page);
  if (!frame) return false;
  try {
    return await frame.locator('.word-textbox').count() > 0;
  } catch {
    return false;
  }
}

async function handleVocab(page) {
  const frame = await getWorkingFrame(page);
  if (!frame) return;

  console.log("📚 Handling Vocab Activity (Audio + Logic)");

  const allBtns = frame.locator('.plainbtn.alt');
  const total = await allBtns.count();

  for (let i = 0; i < total; i++) {
    const btn = allBtns.nth(i);
    const word = (await btn.innerText()).trim();

    const status = await btn.evaluate(el => ({
      isComplete: el.classList.contains('complete') || el.classList.contains('visited'),
      isSelected: el.classList.contains('selected')
    }));

    if (status.isComplete) continue;

    console.log(`🔤 Step ${i + 1}/${total}: "${word}"`);
    await btn.click({ force: true }).catch(() => { });
    await humanDelay(1000, 2000);

    const input = frame.locator('.word-textbox');
    await input.fill('');
    await input.type(word, { delay: 100 });
    await humanDelay(500, 1000);
    await page.keyboard.press('Enter');
    await humanDelay(1000, 2000);

    // 🔊 CLICK ALL PLAY BUTTONS (Definition & Usage)
    console.log("🔊 Playing audio buttons...");
    const playBtns = frame.locator('.playbutton.vocab-play');
    const pCount = await playBtns.count();
    for (let j = 0; j < pCount; j++) {
      await playBtns.nth(j).click({ force: true }).catch(() => { });
      await humanDelay(2000, 3000); // Wait for audio to trigger
    }

    // ➡️ Wait for Next button to become enabled and click it
    const nextBtn = frame.locator('.uibtn-arrow-next');
    await humanDelay(3000, 5000); // Final buffer for Next button

    if (await nextBtn.isVisible()) {
      await nextBtn.click({ force: true }).catch(() => { });
      console.log("➡️ Advanced to next word");
      await humanDelay(2000, 3000);
    }
  }
}

// 🎥 VIDEO
async function handleVideo(page) {
  const frame = await getWorkingFrame(page);
  if (!frame) return;

  console.log("🎥 Handling video activity");

  await frame.evaluate(() => {
    const v = document.querySelector('video');
    if (v) {
      v.playbackRate = 2.0; // Boost to 2x if possible
      v.muted = true;
      v.play();
    }
  });

  // Wait for video to finish or Next Activity to enable
  for (let i = 0; i < 30; i++) {
    const isEnded = await frame.evaluate(() => {
      const v = document.querySelector('video');
      return v ? (v.ended || (v.paused && v.currentTime > 0)) : true;
    });

    if (isEnded) break;
    await humanDelay(5000, 10000);
  }
}

async function getWorkingFrame(page) {
  const frames = page.frames();

  // PRIORITY 1 → contentengine (quiz)
  let frame = frames.find(f => f.url().includes('contentengine'));
  if (frame) return frame;

  // PRIORITY 2 → LTILaunch (journal / textarea)
  frame = frames.find(f => f.url().includes('LTILaunch'));
  if (frame) return frame;

  // PRIORITY 3 → Vocab / Activity
  frame = frames.find(f => f.url().includes('ContentViewers'));
  if (frame) return frame;

  // PRIORITY 4 → #stageFrame direct content frame
  try {
    const el = await page.$('#stageFrame');
    if (el) {
      frame = await el.contentFrame();
      if (frame && frame.url() !== 'about:blank') return frame;
    }
  } catch { }

  // PRIORITY 5 → any loaded child frame with content
  frame = frames.find(f => f !== page.mainFrame() && f.url() && f.url() !== 'about:blank');
  return frame || null;
}

// 🧠 MAIN SOLVER
async function handleQuestion(page) {
  console.log("🧠 Solving question...");

  const frame = await getWorkingFrame(page);
  if (!frame) return;

  await humanDelay(2000, 4000);

  const raw = await frame.locator('body').innerText();
  const question = raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.includes('Headphones') && !l.includes('Activity') && !/^\d+$/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  console.log("📖 Question:", question.slice(0, 150));

  // CKEditor
  try {
    const hasCK = await frame.evaluate(() => typeof window.CKEDITOR !== 'undefined');
    if (hasCK) {
      const editorAnswer = await solveOpenQuestion(question);
      await frame.evaluate((text) => {
        const ck = window.CKEDITOR;
        const names = Object.keys(ck.instances);
        const name = names.find(n => ck.instances[n].elementMode !== 3) || names[0];
        if (name) {
          ck.instances[name].setData(text);
          ck.instances[name].fire('change');
        }
      }, editorAnswer);
      return;
    }
  } catch { }

  // Radio MCQ
  const radios = frame.locator('input[type="radio"]');
  const radioCount = await radios.count();
  if (radioCount > 0) {
    const options = [];
    for (let i = 0; i < radioCount; i++) {
      const text = await radios.nth(i).evaluate(el => el.closest('label')?.innerText || el.nextElementSibling?.innerText || '');
      options.push(text.trim());
    }
    const answer = await solveQuestion(question, options.filter(Boolean));
    for (let i = 0; i < radioCount; i++) {
      if (options[i].toLowerCase().includes(answer.toLowerCase()) || answer.toLowerCase().includes(options[i].toLowerCase())) {
        await radios.nth(i).check({ force: true });
        await humanDelay(1000, 2000);
        await clickDone(page);
        return;
      }
    }
  }

  // Dropdown (Select)
  const selects = frame.locator('select');
  const selectCount = await selects.count();
  if (selectCount > 0) {
    for (let i = 0; i < selectCount; i++) {
      const select = selects.nth(i);
      const options = await select.locator('option').allInnerTexts();
      const filteredOptions = options.map(o => o.trim()).filter(o => o && o !== 'Select...');

      const answer = await solveQuestion(question, filteredOptions);

      // Select the option that matches
      for (const opt of options) {
        if (opt.toLowerCase().includes(answer.toLowerCase()) || answer.toLowerCase().includes(opt.toLowerCase())) {
          await select.selectOption({ label: opt });
          break;
        }
      }
    }
    await humanDelay(1000, 2000);
    await clickDone(page);
    return;
  }

  // Fallback: click first radio if stuck
  if (radioCount > 0) {
    await radios.first().check({ force: true });
    await humanDelay(1000, 2000);
    await clickDone(page);
  }
}

async function clickDone(page) {
  const frame = await getWorkingFrame(page);
  if (!frame) return;

  // Specific Edgenuity Done Button Selectors
  const selectors = [
    'span#btnCheck',
    '#btnCheck',
    '.uibtn-icon:has-text("Done")',
    'text=Done'
  ];

  for (const s of selectors) {
    try {
      const btn = frame.locator(s).first();
      if (await btn.isVisible()) {
        await btn.click({ force: true, timeout: 3000 });
        console.log("✅ Clicked Done button");
        return true;
      }
    } catch { }
  }
  return false;
}

// 👣 INTERNAL STEPS (Boxes at bottom)
async function handleInternalSteps(page) {
  // These elements are in the MAIN page, not inside #stageFrame
  try {
    const progressEl = page.locator('em#frameProgress');
    if (await progressEl.isVisible()) {
      const stepText = await progressEl.innerText();
      console.log(`👣 Progress: ${stepText}`); // e.g. "2 of 8"

      const match = stepText.match(/(\d+)\s+of\s+(\d+)/);
      if (match) {
        const current = parseInt(match[1]);
        const total = parseInt(match[2]);

        if (current < total) {
          // Click the next box in the list
          const boxes = page.locator('.FramesList a');
          const nextBox = boxes.nth(current); // index 'current' is the (current+1)-th box

          if (await nextBox.isVisible()) {
            await nextBox.click({ force: true });
            console.log(`➡️ Clicked step box ${current + 1}`);
            return true;
          }
        } else {
          console.log("✅ All internal steps (X of X) finished.");
          return false;
        }
      }
    }
  } catch (err) {
    console.log("⚠️ Error handling internal steps:", err.message);
  }
  return false;
}

// 📤 SUBMIT
async function clickSaveAndExit(page) {
  const frame = await getWorkingFrame(page);
  const selectors = ['#submit', 'text=Submit', 'button:has-text("Submit")', 'input[type="submit"]'];

  if (frame) {
    for (const s of selectors) {
      try {
        await frame.locator(s).first().click({ timeout: 2000 });
        return true;
      } catch { }
    }
  }
  return false;
}

// ➡️ NEXT ACTIVITY
async function clickNextActivity(page) {
  await humanDelay(2000, 4000);
  const selectors = ['a.footnav.goRight', '.footnav.goRight', 'text=Next Activity'];
  for (const s of selectors) {
    try {
      if (await page.locator(s).count() > 0) {
        await page.locator(s).first().click({ timeout: 3000 });
        return true;
      }
    } catch { }
  }
  return false;
}

async function detectQuestion(page) {
  const frame = await getWorkingFrame(page);
  if (!frame) return false;
  const counts = await Promise.all([
    frame.locator('input[type="radio"]').count(),
    frame.locator('textarea').count(),
    frame.locator('[contenteditable="true"]').count()
  ]);
  return counts.some(c => c > 0);
}

module.exports = {
  handleVideo,
  handleQuestion,
  detectVocab,
  detectQuestion,
  clickSaveAndExit,
  clickNextActivity,
  handleInternalSteps,
  clickDone
};