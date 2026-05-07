async function click(page, selector) {
  await page.click(selector);
}

async function fill(page, selector, value) {
  await page.fill(selector, value);
}

async function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { click, fill, wait };