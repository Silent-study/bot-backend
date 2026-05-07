async function hasVideo(frame) {
  return await frame.locator('video').count() > 0;
}

async function hasQuestion(frame) {
  const inputs = await frame.locator('input, select, textarea').count();
  return inputs > 0;
}

module.exports = { hasVideo, hasQuestion };