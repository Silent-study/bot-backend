const cron = require('node-cron');
const mongoose = require('mongoose');
const User = mongoose.model('User');
const { notifyDiscordBot } = require('../utils/discordClient');

// Run daily at 9:00 AM UTC
cron.schedule('0 9 * * *', async () => {
  console.log('[Cron] Running renewal reminders check...');
  try {
    const today = new Date();
    
    // Calculate the date exactly 3 days from now
    const threeDaysFromNow = new Date();
    threeDaysFromNow.setDate(today.getDate() + 3);
    
    // We want to match users whose expiryDate falls on that exact day (ignoring exact time if possible, or within a 24h window)
    const startOfDay = new Date(threeDaysFromNow);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(threeDaysFromNow);
    endOfDay.setHours(23, 59, 59, 999);

    const expiringUsers = await User.find({
      isPaid: true,
      discordId: { $ne: null },
      expiryDate: {
        $gte: startOfDay,
        $lte: endOfDay
      }
    });

    console.log(`[Cron] Found ${expiringUsers.length} users expiring in 3 days.`);

    for (const user of expiringUsers) {
      try {
        await notifyDiscordBot({
          action: 'SEND_DM',
          discordId: user.discordId,
          data: {
            message: `⚠️ **Subscription Renewal Notice**\nHi ${user.discordUsername || 'there'}, your Silent Study **${user.plan}** subscription will renew in exactly 3 days on ${user.expiryDate.toDateString()}.\n\nIf you wish to manage your plan, please use the \`/manage-plan\` command with the OrderBot in the Discord server.`
          }
        });
        console.log(`[Cron] Sent renewal reminder to ${user.email} (${user.discordId})`);
      } catch (err) {
        console.error(`[Cron] Failed to notify ${user.email} (${user.discordId}):`, err.message);
      }
    }
  } catch (err) {
    console.error('[Cron] Error running renewal reminders:', err);
  }
});

console.log('[Cron] Renewal reminders job initialized (Runs daily at 09:00 UTC).');
