const { chromium } = require('playwright');
const selectors = require('./mapper');
const lms = require('./lms');
require('dotenv').config();

const STATE = {
  LOGIN: 'LOGIN',
  DASHBOARD: 'DASHBOARD',
  COURSE_LOADING: 'COURSE_LOADING',
  FRAME: 'FRAME'
};

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function humanDelay(min = 3000, max = 7000) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

async function humanMove(page) {
  await page.mouse.move(Math.random() * 600, Math.random() * 400);
}

async function isLoggedOut(page) {
  const url = page.url().toLowerCase();

  // ✅ ONLY trust URL for login
  if (url.includes('login')) return true;

  // ✅ if inside LMS player → definitely logged in
  const isPlayer = await page.locator('#stageFrame')
    .count()
    .catch(() => 0);

  if (isPlayer > 0) return false;

  // ✅ check for user profile (strong signal)
  const hasUser = await page.locator('.nav.dave')
    .count()
    .catch(() => 0);

  if (hasUser > 0) return false;

  return false;
}

async function doLogin(page) {
  log("🔐 Logging in...");

  await page.waitForSelector('#username');

  await page.click('#username');
  await humanDelay(500, 1500);

  await page.type('#username', process.env.USER_NAME, { delay: 100 });

  await page.click('#password');
  await page.type('#password', process.env.PASSWORD, { delay: 120 });

  await humanDelay(1500, 2500);

  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle');

  log("✅ Login success");
}

async function openCourse(page) {
  log("📚 Opening course...");

  await page.waitForSelector(selectors.NEXT_ACTIVITY);

  const cards = page.locator(selectors.NEXT_ACTIVITY);
  const count = await cards.count();

  if (count === 0) throw new Error("No courses found");

  const card = cards.nth(4);

  await card.scrollIntoViewIfNeeded();
  await humanDelay(2000, 4000);
  await humanMove(page);

  await card.click();

  // 🔥 VERY IMPORTANT FIX
  await page.waitForSelector('#stageFrame', { timeout: 30000 });

  // 🔥 LMS TOKEN STABILIZATION
  await humanDelay(10000, 15000);

  log("✅ Course ready");
}

async function detectState(page) {

  // ✅ REAL login detection (only username field)
  const loginVisible = await page.locator('#username')
    .isVisible()
    .catch(() => false);

  if (loginVisible) return 'LOGIN';

  // ✅ dashboard
  const hasDashboard = await page.locator('.enrollment-card-btn-next')
    .count()
    .catch(() => 0);

  if (hasDashboard > 0) return 'DASHBOARD';

  // ✅ LMS player
  const hasFrame = await page.locator('#stageFrame')
    .count()
    .catch(() => 0);

  if (hasFrame > 0) return 'FRAME';

  return 'COURSE_LOADING';
}

(async () => {

  const context = await chromium.launchPersistentContext('./user-data', {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const page = context.pages()[0] || await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false
    });
  });

  await page.goto(process.env.URL);

  let step = 0;

  while (true) {
    step++;

    try {

      await humanDelay(3000, 6000);
      await humanMove(page);

      const state = await detectState(page);

      log(`STATE → ${state}`);

      // 🔐 LOGIN
      if (state === STATE.LOGIN) {
        await doLogin(page);
        continue;
      }

      // 📚 DASHBOARD
      if (state === STATE.DASHBOARD) {
        await openCourse(page);
        continue;
      }

      // ⏳ COURSE LOADING
      if (state === STATE.COURSE_LOADING) {
        log("⏳ Waiting for course player...");

        await humanDelay(8000, 12000);
        continue;
      }

      // 🎯 FRAME INTERACTION
      if (state === STATE.FRAME) {
        // Boost video speed if present
        await lms.handleVideo(page);

        // Handle Vocab if detected
        const isVocab = await lms.detectVocab(page);
        if (isVocab) {
          await lms.handleVocab(page);
        }

        // Handle Questions if detected
        const hasQ = await lms.detectQuestion(page);
        if (hasQ) {
          log("🧠 Solving question...");
          await lms.handleQuestion(page);
          await humanDelay(1000, 2000);
          
          const submitted = await lms.clickSaveAndExit(page);
          if (submitted) log("📤 Assessment submitted");
        }

        // Always try to move to next activity
        log("➡️ Moving to next activity...");
        const moved = await lms.clickNextActivity(page);
        
        if (!moved) {
          log("⚠️ Could not move using standard buttons, trying fallback...");
          await page.keyboard.press('Enter'); // Sometimes enter works
          await humanDelay(5000, 8000);
        } else {
          log("✅ Moved to next activity");
          await humanDelay(8000, 12000);
        }
      }

      // 🛑 stop safe
      if (step > 60) {
        log("🛑 Max steps reached");
        break;
      }

    } catch (err) {
      log("❌ ERROR → " + err.message);
      await humanDelay(5000, 8000);
    }
  }

})();