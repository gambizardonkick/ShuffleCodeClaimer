const { Telegraf, Markup } = require('telegraf');
const firebaseDB = require('./server/firebaseDb.js');
const { initializeFirebase } = require('./server/firebase.js');
const { oxaPayService } = require('./server/oxapay.js');

initializeFirebase();

// Use separate bot token for subscription bot
const bot = new Telegraf(process.env.SUBSCRIPTION_BOT_TOKEN);

// Use the actual Replit dev domain
const DOMAIN = process.env.REPLIT_DEV_DOMAIN
  ? `https://${process.env.REPLIT_DEV_DOMAIN}`
  : (process.env.REPL_SLUG 
    ? `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`
    : 'http://localhost:5000');

// Store user session data
const userSessions = new Map();

// Monthly bulk pricing discounts (per account)
const MONTHLY_BULK_PRICING = [
  { min: 1, max: 1, price: 60 },
  { min: 2, max: 10, price: 55 },
  { min: 11, max: 20, price: 50 },
  { min: 21, max: 30, price: 45 },
  { min: 31, max: 50, price: 40 },
  { min: 51, max: 999, price: 35 },
];

function getMonthlyPrice(accountCount) {
  const tier = MONTHLY_BULK_PRICING.find(t => accountCount >= t.min && accountCount <= t.max);
  return tier ? tier.price : 60;
}

// Command: /start
bot.start(async (ctx) => {
  const telegramUserId = ctx.from.id.toString();
  
  try {
    const welcomeMessage = 
      `👋 Hello ${ctx.from.first_name},\n\n` +
      `Welcome to Code Claimer Subscription and account management Bot.\n\n` +
      `*Our Price List:*\n\n` +
      `1 day: $10 (❗️ Only Saturday Stream and secret codes ❗️)\n` +
      `1 week: $20 💵\n` +
      `1 month: $35 💼\n` +
      `3 months: $70 💎\n` +
      `6 months: $100 💎\n` +
      `1 year $150 💎\n` +
      `Lifetime: $250 💎`;
    
    await ctx.reply(welcomeMessage, { parse_mode: 'Markdown' });
    
    await ctx.reply(
      'Please make a selection:',
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Add New Accounts', 'add_accounts')],
        [Markup.button.callback('📊 My Subscriptions', 'my_subscriptions')],
      ])
    );
    
  } catch (error) {
    console.error('Start command error:', error);
    await ctx.reply('❌ Error initializing your account. Please try again.');
  }
});

// Handle "Add New Accounts" button
bot.action('add_accounts', async (ctx) => {
  await ctx.answerCbQuery();
  const telegramUserId = ctx.from.id.toString();
  
  userSessions.set(telegramUserId, { step: 'waiting_for_usernames' });
  
  await ctx.reply('Please write new usernames you want to subscribe:\n_(Enter one username per line for multiple accounts)_', {
    parse_mode: 'Markdown'
  });
});

// Handle "My Subscriptions" button
bot.action('my_subscriptions', async (ctx) => {
  await ctx.answerCbQuery();
  const telegramUserId = ctx.from.id.toString();
  
  try {
    const user = await firebaseDB.findUserByTelegramId(telegramUserId);
    
    if (!user) {
      await ctx.reply('❌ No account found. Use /start to create one.');
      return;
    }
    
    const accounts = await firebaseDB.findShuffleAccountsByUserId(user.id);
    
    if (accounts.length === 0) {
      await ctx.reply('❌ No active accounts. Click "Add New Accounts" to subscribe.');
      return;
    }
    
    let message = '📊 *Your Active Accounts:*\n\n';
    accounts.forEach((acc, i) => {
      const status = acc.status === 'active' ? '✅' : '⏸';
      let expiryText = 'N/A';
      
      if (acc.expiryAt) {
        const expiryDate = new Date(acc.expiryAt);
        const now = new Date();
        const diffMs = expiryDate - now;
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        
        if (diffMs < 0) {
          expiryText = '❌ Expired';
        } else if (diffMs < 60 * 60 * 1000) {
          // Less than 1 hour - show minutes
          const minutes = Math.ceil(diffMs / (1000 * 60));
          expiryText = `${minutes} min${minutes !== 1 ? 's' : ''}`;
        } else if (diffMs < 24 * 60 * 60 * 1000) {
          // Less than 1 day - show hours
          const hours = Math.ceil(diffMs / (1000 * 60 * 60));
          expiryText = `${hours} hour${hours !== 1 ? 's' : ''}`;
        } else if (diffDays <= 7) {
          // Less than 7 days - show days
          expiryText = `${diffDays} day${diffDays !== 1 ? 's' : ''}`;
        } else {
          // Show date in user's local time (formatted as UTC with explicit label)
          const dateStr = expiryDate.toISOString().split('T')[0]; // YYYY-MM-DD
          const timeStr = expiryDate.toISOString().split('T')[1].split('.')[0]; // HH:MM:SS
          expiryText = `${dateStr} ${timeStr} UTC`;
        }
      }
      
      message += `${i + 1}. ${status} ${acc.username} - ${expiryText}\n`;
    });
    
    await ctx.reply(message, { parse_mode: 'Markdown' });
    
  } catch (error) {
    console.error('My subscriptions error:', error);
    await ctx.reply('❌ Error fetching subscriptions.');
  }
});

// Handle plan selection callbacks
bot.action(/^plan_(.+)_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const telegramUserId = ctx.from.id.toString();
  const session = userSessions.get(telegramUserId);
  
  if (!session || !session.usernames) {
    await ctx.reply('❌ Session expired. Please use /start again.');
    return;
  }
  
  const planId = parseInt(ctx.match[1]);
  const accountCount = parseInt(ctx.match[2]);
  
  try {
    const plan = await firebaseDB.findPlanById(planId);
    
    if (!plan) {
      await ctx.reply('❌ Invalid plan.');
      return;
    }
    
    // Get or create user
    let user = await firebaseDB.findUserByTelegramId(telegramUserId);
    
    if (!user) {
      user = await firebaseDB.createUser({
        telegramUserId,
        status: 'pending',
      });
    }
    
    // Calculate price (special handling for monthly with bulk discounts)
    let totalPrice;
    if (plan.name.includes('Month') && !plan.name.includes('3') && !plan.name.includes('6')) {
      const pricePerAccount = getMonthlyPrice(accountCount);
      totalPrice = pricePerAccount * accountCount;
    } else {
      totalPrice = (plan.priceCents / 100) * accountCount;
    }
    
    // Create pending subscription
    const orderId = `SUB-${user.id}-${Date.now()}`;
    const subscription = await firebaseDB.createSubscription({
      userId: user.id,
      planId: plan.id,
      status: 'pending',
      oxapayOrderId: orderId,
    });
    
    // Store session data
    session.subscriptionId = subscription.id;
    session.planId = plan.id;
    session.planName = plan.name;
    session.totalPrice = totalPrice;
    userSessions.set(telegramUserId, session);
    
    // Create OxaPay invoice
    const invoice = await oxaPayService.createInvoice({
      amount: totalPrice,
      currency: 'USD',
      orderId,
      description: `${plan.name} - ${accountCount} account(s): ${session.usernames.join(', ')}`,
      callbackUrl: `${DOMAIN}/api/oxapay/webhook`,
    });
    
    // Send payment message
    const paymentMsg = await ctx.reply(
      `You chose *${plan.name}* plan for *${accountCount}* new usernames.\n` +
      `Total cost: *$${totalPrice}*\n\n` +
      `Please pay using the link below.\n\n` +
      `❗️ As soon as payment status changes, this message will update automatically. ❗️`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: `💰 Pay $${totalPrice} Now`, url: invoice.payLink }
          ]]
        }
      }
    );
    
    // Update subscription with trackId and Telegram metadata
    await firebaseDB.updateSubscription(subscription.id, { 
      oxapayTrackId: invoice.trackId,
      telegramChatId: ctx.chat.id.toString(),
      paymentMessageId: paymentMsg.message_id,
      pendingUsernames: session.usernames,
    });
    
    console.log(`💾 Saved subscription metadata for ${accountCount} accounts:`, session.usernames);
    
    // Store message ID for later update
    session.paymentMessageId = paymentMsg.message_id;
    userSessions.set(telegramUserId, session);
    
  } catch (error) {
    console.error('Plan selection error:', error);
    await ctx.reply('❌ Error creating payment. Please try again.');
  }
});

// Handle text messages
bot.on('text', async (ctx) => {
  const telegramUserId = ctx.from.id.toString();
  const session = userSessions.get(telegramUserId);
  
  if (!session || session.step !== 'waiting_for_usernames') {
    return;
  }
  
  try {
    const usernames = ctx.message.text.split('\n').map(u => u.trim().toLowerCase()).filter(u => u.length > 0);
    
    if (usernames.length === 0) {
      await ctx.reply('❌ Please enter at least one username.');
      return;
    }
    
    // Validate usernames
    const invalidUsernames = usernames.filter(u => u.length < 3 || u.length > 20);
    if (invalidUsernames.length > 0) {
      await ctx.reply('❌ Invalid username(s). Usernames must be 3-20 characters long.');
      return;
    }
    
    // Store usernames in session (DON'T create user yet)
    session.usernames = usernames;
    session.accountCount = usernames.length;
    session.step = 'eligibility_check';
    userSessions.set(telegramUserId, session);
    
    // ===== ELIGIBILITY CHECK =====
    // Check 1: Does this Telegram ID exist?
    const existingUser = await firebaseDB.findUserByTelegramId(telegramUserId);
    
    // Check 2: Do ANY of these usernames exist?
    let existingAccounts = [];
    for (const username of usernames) {
      const accounts = await firebaseDB.findShuffleAccountsByUsername(username);
      existingAccounts.push(...accounts);
    }
    
    // If EITHER exists -> NOT eligible for free trial
    if (existingUser || existingAccounts.length > 0) {
      // Show pricing plans directly
      const availablePlans = await firebaseDB.getAllPlans();
      const keyboard = availablePlans.map(plan => {
        let displayPrice;
        if (plan.name.includes('Month') && !plan.name.includes('3') && !plan.name.includes('6')) {
          const pricePerAccount = getMonthlyPrice(usernames.length);
          displayPrice = `$${pricePerAccount * usernames.length}`;
        } else {
          displayPrice = `$${(plan.priceCents / 100) * usernames.length}`;
        }
        return [Markup.button.callback(`${plan.name} - ${displayPrice}`, `plan_${plan.id}_${usernames.length}`)];
      });
      
      await ctx.reply('Select your plan:', Markup.inlineKeyboard(keyboard));
      return;
    }
    
    // If BOTH are new -> Eligible for free trial!
    await ctx.reply(
      `✅ You have given ${usernames.length} username(s):\n${usernames.join(', ')}\n\n` +
      `🎁 *You're eligible for a 30-MINUTE FREE TRIAL!*\n\n` +
      `Choose an option:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎁 Claim 30-Min Free Trial', callback_data: 'claim_free_trial' }],
            [{ text: '💎 Buy Subscription Plan', callback_data: 'show_buy_plans' }]
          ]
        }
      }
    );
    
  } catch (error) {
    console.error('Text handler error:', error);
    await ctx.reply('❌ An error occurred. Please try /start again.');
  }
});

// Handle "Claim Free Trial" button
bot.action('claim_free_trial', async (ctx) => {
  await ctx.answerCbQuery();
  const telegramUserId = ctx.from.id.toString();
  const session = userSessions.get(telegramUserId);
  
  if (!session || !session.usernames) {
    await ctx.reply('❌ Session expired. Please use /start again.');
    return;
  }
  
  try {
    const usernames = session.usernames;
    
    // DOUBLE CHECK - Prevent duplicate trial grants
    const existingUser = await firebaseDB.findUserByTelegramId(telegramUserId);
    
    if (existingUser) {
      await ctx.reply('❌ You already have an account. Free trial can only be claimed once.');
      return;
    }
    
    // Create user with trial marked as claimed
    const user = await firebaseDB.createUser({
      telegramUserId,
      status: 'active',
      trialClaimedAt: new Date().toISOString()
    });
    
    // Grant free trial
    await grantFreeTrial(ctx, user, usernames);
    
    // Clear session
    userSessions.delete(telegramUserId);
    
  } catch (error) {
    console.error('Claim free trial error:', error);
    await ctx.reply('❌ Error claiming trial. Please try again.');
  }
});

// Handle "Buy Subscription Plan" button
bot.action('show_buy_plans', async (ctx) => {
  await ctx.answerCbQuery();
  const telegramUserId = ctx.from.id.toString();
  const session = userSessions.get(telegramUserId);
  
  if (!session || !session.usernames) {
    await ctx.reply('❌ Session expired. Please use /start again.');
    return;
  }
  
  try {
    const usernames = session.usernames;
    
    // Get or create user
    let user = await firebaseDB.findUserByTelegramId(telegramUserId);
    
    if (!user) {
      user = await firebaseDB.createUser({
        telegramUserId,
        status: 'pending',
      });
    }
    
    // Show confirmation
    await ctx.reply(
      `You have selected ${usernames.length} username(s): ${usernames.join(', ')}\n\n` +
      `Please choose a subscription period:`,
      { parse_mode: 'Markdown' }
    );
    
    // Get available plans
    const availablePlans = await firebaseDB.getAllPlans();
    
    // Create inline keyboard with plan buttons
    const keyboard = availablePlans.map(plan => {
      let displayPrice;
      if (plan.name.includes('Month') && !plan.name.includes('3') && !plan.name.includes('6')) {
        const pricePerAccount = getMonthlyPrice(usernames.length);
        displayPrice = `$${pricePerAccount * usernames.length}`;
      } else {
        displayPrice = `$${(plan.priceCents / 100) * usernames.length}`;
      }
      
      return [Markup.button.callback(`${plan.name} - ${displayPrice}`, `plan_${plan.id}_${usernames.length}`)];
    });
    
    await ctx.reply(
      'Select your plan:',
      Markup.inlineKeyboard(keyboard)
    );
    
  } catch (error) {
    console.error('Show buy plans error:', error);
    await ctx.reply('❌ Error loading plans. Please try again.');
  }
});

// Grant 30-minute free trial
async function grantFreeTrial(ctx, user, usernames) {
  try {
    const telegramUserId = ctx.from.id.toString();
    
    // Mark trial as claimed
    await firebaseDB.updateUser(user.id, { 
      trialClaimedAt: new Date().toISOString(),
      status: 'active'
    });
    
    // Calculate 30-minute expiry (stored in UTC)
    const expiryAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes from now
    
    // Create shuffle accounts with 30-minute expiry
    for (const username of usernames) {
      await firebaseDB.createShuffleAccount({
        userId: user.id,
        username,
        status: 'active',
        expiryAt: expiryAt.toISOString()
      });
    }
    
    // Format expiry time in UTC with clear label
    const expiryTimeStr = expiryAt.toISOString().split('T')[1].split('.')[0]; // HH:MM:SS
    const expiryDateStr = expiryAt.toISOString().split('T')[0]; // YYYY-MM-DD
    
    await ctx.reply(
      `🎉 *CONGRATULATIONS!*\n\n` +
      `You've been granted a *30-MINUTE FREE TRIAL!*\n\n` +
      `✅ Your accounts are now *ACTIVE* and will auto-claim codes:\n` +
      usernames.map((u, i) => `  ${i + 1}. ${u}`).join('\n') + '\n\n' +
      `⏰ Trial expires in *30 minutes*\n` +
      `   (${expiryDateStr} ${expiryTimeStr} UTC)\n\n` +
      `After your trial ends, choose a subscription plan to continue enjoying auto-claiming!\n\n` +
      `🎰 *Start using it now - codes will auto-claim automatically!*`,
      { parse_mode: 'Markdown' }
    );
    
    // Show subscription button for later
    await ctx.reply(
      'When ready to subscribe:',
      Markup.inlineKeyboard([
        [Markup.button.callback('💎 View Subscription Plans', 'show_plans_' + usernames.length)]
      ])
    );
    
    console.log(`✅ Free trial granted to user ${telegramUserId} for ${usernames.length} accounts`);
    
  } catch (error) {
    console.error('Error granting free trial:', error);
    await ctx.reply('❌ Error activating free trial. Please try again.');
  }
}

// Handle "show plans" button after trial
bot.action(/^show_plans_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  
  const accountCount = parseInt(ctx.match[1]);
  
  try {
    // Get available plans
    const availablePlans = await firebaseDB.getAllPlans();
    
    // Create inline keyboard with plan buttons
    const keyboard = availablePlans.map(plan => {
      let displayPrice;
      if (plan.name.includes('Month') && !plan.name.includes('3') && !plan.name.includes('6')) {
        const pricePerAccount = getMonthlyPrice(accountCount);
        displayPrice = `$${pricePerAccount * accountCount}`;
      } else {
        displayPrice = `$${(plan.priceCents / 100) * accountCount}`;
      }
      
      return [Markup.button.callback(`${plan.name} - ${displayPrice}`, `plan_${plan.id}_${accountCount}`)];
    });
    
    await ctx.reply(
      'Select your plan:',
      Markup.inlineKeyboard(keyboard)
    );
  } catch (error) {
    console.error('Show plans error:', error);
    await ctx.reply('❌ Error loading plans.');
  }
});

// Function to notify user about payment confirmation
async function notifyPaymentConfirmed(telegramUserId, messageId, subscriptionDetails) {
  try {
    // Update the payment message
    await bot.telegram.editMessageText(
      telegramUserId,
      messageId,
      null,
      `✅ *Payment Confirmed!*\n\n` +
      `Your subscription is now *active*!\n\n` +
      `📋 *Details:*\n` +
      `Plan: ${subscriptionDetails.planName}\n` +
      `Accounts: ${subscriptionDetails.accountCount}\n` +
      `Expires: ${subscriptionDetails.expiryDate.toLocaleDateString()}\n\n` +
      `🎰 *Your accounts are now connected and will auto-claim codes!*\n\n` +
      `Active accounts:\n` +
      subscriptionDetails.usernames.map((u, i) => `  ${i + 1}. ${u}`).join('\n'),
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    console.error('Error updating payment message:', error);
    // Fallback to new message if edit fails
    try {
      await bot.telegram.sendMessage(
        telegramUserId,
        `✅ *Payment Confirmed!*\n\nYour subscription is now active!`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      console.error('Error sending notification:', e);
    }
  }
}

// Export for webhook handler
module.exports = { bot, userSessions, notifyPaymentConfirmed };

// Launch bot only if SUBSCRIPTION_BOT_TOKEN is set
if (process.env.SUBSCRIPTION_BOT_TOKEN) {
  bot.launch().then(() => {
    console.log('🤖 Subscription bot started!');
  }).catch((error) => {
    console.error('Failed to start bot:', error);
    process.exit(1);
  });

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
} else {
  console.warn('⚠️  SUBSCRIPTION_BOT_TOKEN not set - subscription bot not started');
  console.log('Please create a second bot via @BotFather and add the token to secrets');
}
