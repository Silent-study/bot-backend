const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const selectors = require('./mapper');
const lms = require('./lms');

const STATE = {
  LOGIN: 'LOGIN',
  DASHBOARD: 'DASHBOARD',
  COURSE_LOADING: 'COURSE_LOADING',
  FRAME: 'FRAME'
};

async function runAutomation(username, password, url, courseName, onLog, onState, getIsStopped) {
  function log(msg) {
    const timestamp = new Date().toLocaleTimeString();
    onLog(`[${timestamp}] ${msg}`);
    console.log(`[${timestamp}] ${msg}`);
  }

  function humanDelay(min = 4000, max = 9000) {
    return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
  }

  async function humanMouse(page) {
    try {
      const x = Math.floor(Math.random() * 800);
      const y = Math.floor(Math.random() * 600);
      await page.mouse.move(x, y, { steps: 10 });
    } catch { }
  }

  async function detectState(page) {
    const loginVisible = await page.locator('#username').isVisible().catch(() => false);
    if (loginVisible) return 'LOGIN';

    const hasDashboard = await page.locator('.enrollment-card-btn-next').count().catch(() => 0);
    if (hasDashboard > 0) return 'DASHBOARD';

    const hasFrame = await page.locator('#stageFrame').count().catch(() => 0);
    if (hasFrame > 0) return 'FRAME';

    return 'COURSE_LOADING';
  }

  async function doLogin(page, user, pass) {
    log("🔐 Logging in (Stealth Mode)...");
    await page.waitForSelector('#username');
    await humanMouse(page);
    await page.click('#username');
    await page.type('#username', user, { delay: Math.random() * 100 + 100 });

    await humanDelay(1000, 2000);
    await page.click('#password');
    await page.type('#password', pass, { delay: Math.random() * 100 + 120 });

    await humanDelay(2000, 4000);
    await humanMouse(page);
    await page.click('button[type="submit"]');
    await page.waitForLoadState('networkidle');
    log("✅ Login success");
  }

  async function openCourse(page, targetCourse) {
    if (targetCourse) {
      log(`🔍 Searching for course: "${targetCourse}"...`);
      // Try to find the enrollment card that contains the target course text
      const enrollmentCards = page.locator('.enrollment-card');
      const count = await enrollmentCards.count();

      let found = false;
      for (let i = 0; i < count; i++) {
        const card = enrollmentCards.nth(i);
        const text = await card.innerText();
        if (text.toLowerCase().includes(targetCourse.toLowerCase())) {
          log(`🎯 Found matching course: ${targetCourse}`);
          const nextBtn = card.locator(selectors.NEXT_ACTIVITY);
          if (await nextBtn.isVisible()) {
            await nextBtn.scrollIntoViewIfNeeded();
            await humanDelay(2000, 4000);
            await nextBtn.click();
            found = true;
            break;
          }
        }
      }

      if (!found) {
        log(`⚠️ Course "${targetCourse}" not found on dashboard.`);
        log("📢 Please click 'Next Activity' manually in the browser window.");
        // Wait for state change to COURSE_LOADING or FRAME
        while (await detectState(page) === STATE.DASHBOARD) {
          await humanDelay(5000, 8000);
        }
        return;
      }
    } else {
      log("📢 No course name provided. Please select your course manually in the browser.");
      while (await detectState(page) === STATE.DASHBOARD) {
        log("👉 Waiting for you to click 'Next Activity'...");
        await humanDelay(10000, 15000);
      }
      return;
    }

    log("⏳ Stabilizing course player...");
    await page.waitForSelector('#stageFrame', { timeout: 60000 });
    await humanDelay(15000, 20000);
    log("✅ Course ready");
  }

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    let step = 0;

    while (true) {
      if (getIsStopped()) {
        log("🛑 STOP SIGNAL RECEIVED. Closing browser...");
        break;
      }

      step++;
      await humanDelay(4000, 8000);
      await humanMouse(page);

      const state = await detectState(page);
      onState(state);
      log(`STATE → ${state}`);

      if (state === STATE.LOGIN) {
        await doLogin(page, username, password);
        continue;
      }

      if (state === STATE.DASHBOARD) {
        await openCourse(page, courseName);
        continue;
      }

      if (state === STATE.COURSE_LOADING) {
        log("⏳ Waiting for player...");
        await humanDelay(8000, 12000);
        continue;
      }

      if (state === STATE.FRAME) {
        await lms.handleVideo(page);
        const isVocab = await lms.detectVocab(page);
        if (isVocab) {
          await lms.handleVocab(page);
        }
        const hasQ = await lms.detectQuestion(page);
        if (hasQ) {
          log("🧠 Solving question...");
          await lms.handleQuestion(page);
          await humanDelay(2000, 4000);
          await lms.clickSaveAndExit(page);
        }

        // 👣 Handle internal steps (like "1 of 8")
        const movedStep = await lms.handleInternalSteps(page);
        if (movedStep) {
          log("👣 Moved to next internal step");
          await humanDelay(4000, 7000);
          continue;
        }

        log("➡️ Moving to next activity...");
        const moved = await lms.clickNextActivity(page);
        if (!moved) {
          if (getIsStopped()) break;
          await page.keyboard.press('Enter');
          await humanDelay(5000, 8000);
        } else {
          log("✅ Moved to next activity");
          await humanDelay(10000, 15000);
        }
      }

      if (step > 300) break;
    }
  } catch (err) {
    if (!getIsStopped()) {
      log(`❌ ERROR: ${err.message}`);
    }
  } finally {
    await browser.close().catch(() => { });
    log("🏁 Silent Study Bot Finished.");
  }
}

module.exports = { runAutomation };
