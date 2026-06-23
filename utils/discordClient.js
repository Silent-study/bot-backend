'use strict';

/**
 * Reusable utility to securely dispatch webhook events to the Discord bot process
 * running on the same machine but on a different port.
 * 
 * @param {Object} payload 
 * @param {string} payload.action - e.g., 'ASSIGN_ROLE' or 'SEND_DM'
 * @param {string} payload.discordId - The target Discord user ID
 * @param {Object} [payload.data] - Additional data for the action
 */
async function notifyDiscordBot(payload) {
  const botPort = process.env.DISCORD_BOT_PORT || 4000;
  const apiKey = process.env.INTERNAL_API_KEY || '';
  const url = `http://localhost:${botPort}/internal/webhook`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`Discord bot returned ${res.status}`);
  }

  return res.json();
}

module.exports = { notifyDiscordBot };
