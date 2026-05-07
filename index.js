const { chromium } = require('playwright');
const OpenAI = require('openai');
require('dotenv').config();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // 🔹 Change this to your login page

  // 1. Open Google
  await page.goto('https://auth.edgenuity.com/Login/Login/Student');

 // 2. Fill username
  await page.fill('#username', process.env.USER_NAME);

  // 3. Fill password
  await page.fill('#password', process.env.PASSWORD);

  // 4. Click login button
  await page.click('button[type="submit"]');

  // 5. Wait for navigation or dashboard
  await page.waitForTimeout(5000);

  console.log('Login attempted');
  
  const card = page.locator('.sle-card').filter({
  hasText: 'Chemistry'
});

await card.locator('.enrollment-card-btn-next').click();

await page.waitForTimeout(10000);
await page.waitForSelector('#iFramePreview');

const frame = page.frameLocator('#iFramePreview');

// Example interaction inside iframe
await frame.locator('text=Next').click(); // adjust based on real content

// Then click Done button
await page.click('#btnCheck');
  // 🔁 Agent loop (3 steps only for safety)
  for (let step = 0; step < 3; step++) {

    console.log(`\n--- STEP ${step + 1} ---`);

    // 1. Extract useful elements
    const elements = await page.$$eval('input, button', els =>
      els.map(el => ({
        tag: el.tagName,
        id: el.id,
        text: el.innerText,
        placeholder: el.placeholder,
        type: el.type
      }))
    );

    // 2. Ask AI what to do
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a web automation agent.

Return ONLY JSON like:
{
  "action": "fill" or "click",
  "selector": "css selector",
  "value": "text if fill"
}`
        },
        {
          role: 'user',
          content: `
Goal: login to the website

Elements:
${JSON.stringify(elements, null, 2)}
`
        }
      ]
    });

    const aiText = response.choices[0].message.content;

    console.log("AI says:", aiText);

    let action;
    try {
      action = JSON.parse(aiText);
    } catch (e) {
      console.log("❌ Invalid AI response");
      break;
    }

    // 3. Execute action
    try {
      if (action.action === 'fill') {
        await page.fill(action.selector, action.value || '');
      } else if (action.action === 'click') {
        await page.click(action.selector);
      }
    } catch (e) {
      console.log("❌ Action failed:", e.message);
      break;
    }

    // wait between steps
    await page.waitForTimeout(2000);
  }

  console.log("Agent finished");

})();