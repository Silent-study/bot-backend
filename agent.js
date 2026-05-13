const OpenAI = require('openai');
require('dotenv').config();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Extract structured context from any Playwright page or frame
async function analyzePage(pageOrFrame) {
  return await pageOrFrame.evaluate(() => {
    const clip = (s, n = 200) => (s || '').trim().slice(0, n);

    const inputs = [...document.querySelectorAll('input:not([type=hidden]), textarea, select')]
      .filter(el => el.offsetParent !== null)
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        id: el.id || null,
        name: el.name || null,
        placeholder: clip(el.placeholder, 80),
      }))
      .slice(0, 15);

    const buttons = [...document.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')]
      .filter(el => el.offsetParent !== null)
      .map(el => ({ id: el.id || null, text: clip(el.innerText || el.value, 60) }))
      .filter(b => b.text)
      .slice(0, 10);

    const choices = [...document.querySelectorAll('label')]
      .filter(el => el.offsetParent !== null)
      .map(el => clip(el.innerText, 120))
      .filter(Boolean)
      .slice(0, 12);

    const bodyText = clip(document.body.innerText.replace(/\s+/g, ' '), 1000);

    return {
      url: typeof location !== 'undefined' ? location.href : '',
      bodyText,
      inputs,
      buttons,
      choices,
    };
  });
}

async function decideAction(context, goal, history = []) {
  const systemPrompt = `You are a web automation agent that controls a browser.
Analyze the page context and return the single next action as JSON only.

Available actions:
{ "action": "click",   "selector": "<css>",           "reason": "..." }
{ "action": "fill",    "selector": "<css>", "value": "<text>", "reason": "..." }
{ "action": "check",   "selector": "<css>",           "reason": "..." }
{ "action": "select",  "selector": "<css>", "value": "<option text>", "reason": "..." }
{ "action": "wait",    "ms": 2000,                    "reason": "..." }
{ "action": "done",                                   "reason": "..." }

Selector tips:
- Prefer id selectors: #myId
- Attribute selectors: [name="fieldName"], [type="radio"]
- Text content: text=Button Label
- nth-child: input[type=radio]:nth-of-type(2)

Rules:
- Return ONLY valid JSON - no markdown, no explanation outside JSON
- Return "done" only when the goal is fully achieved`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-6),
    {
      role: 'user',
      content: `Goal: ${goal}\n\nPage:\n${JSON.stringify(context, null, 2)}`,
    },
  ];

  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    temperature: 0.1,
    response_format: { type: 'json_object' },
  });

  return JSON.parse(res.choices[0].message.content);
}

async function executeAction(pageOrFrame, action) {
  const loc = () => pageOrFrame.locator(action.selector).first();

  switch (action.action) {
    case 'click':
      await loc().click({ timeout: 8000 });
      return false;
    case 'fill':
      await loc().fill(action.value ?? '', { timeout: 8000 });
      return false;
    case 'check':
      await loc().check({ timeout: 8000 });
      return false;
    case 'select':
      await loc().selectOption({ label: action.value }, { timeout: 8000 });
      return false;
    case 'wait':
      await new Promise(r => setTimeout(r, action.ms ?? 2000));
      return false;
    case 'done':
      return true;
    default:
      throw new Error(`Unknown action: ${action.action}`);
  }
}

// Run the agent loop on any page or frame until the goal is met or maxSteps is hit.
// Returns { success: boolean, steps: number }
async function run(pageOrFrame, goal, { maxSteps = 20, delayMs = 1200 } = {}) {
  const history = [];

  for (let step = 1; step <= maxSteps; step++) {
    console.log(`[agent] step ${step}/${maxSteps}`);

    let context;
    try {
      context = await analyzePage(pageOrFrame);
      console.log(`[agent] url: ${context.url}`);
    } catch (err) {
      console.log(`[agent] analyze error: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    let action;
    try {
      action = await decideAction(context, goal, history);
      const desc = action.selector ? `${action.action} ${action.selector}` : action.action;
      console.log(`[agent] → ${desc} | ${action.reason}`);
    } catch (err) {
      console.log(`[agent] AI error: ${err.message}`);
      history.push({ role: 'user', content: `AI returned invalid JSON. Try again.` });
      continue;
    }

    history.push({ role: 'assistant', content: JSON.stringify(action) });

    let done = false;
    try {
      done = await executeAction(pageOrFrame, action);
    } catch (err) {
      console.log(`[agent] action failed: ${err.message}`);
      history.push({
        role: 'user',
        content: `Action failed: ${err.message}. Try a different selector or approach.`,
      });
      continue;
    }

    if (done) {
      console.log(`[agent] goal achieved in ${step} steps`);
      return { success: true, steps: step };
    }

    history.push({ role: 'user', content: 'Action executed. Continue toward the goal.' });

    await new Promise(r => setTimeout(r, delayMs));
  }

  console.log('[agent] max steps reached without completing goal');
  return { success: false, steps: maxSteps };
}

module.exports = { run, analyzePage, decideAction, executeAction };
