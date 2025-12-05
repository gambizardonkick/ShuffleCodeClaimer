const { Telegraf, Markup } = require('telegraf');
const { db } = require('./server/db.js');
const { users, plans, subscriptions, shuffleAccounts } = require('./shared/schema.js');
const { oxaPayService } = require('./server/oxapay.js');
const { eq } = require('drizzle-orm');

// Export bot instance for use in webhook handler
let botInstance = null;

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

const DOMAIN = process.env.REPL_SLUG 
  ? `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`
  : 'http://localhost:5000';

// Store user session data
const userSessions = new Map();

// Command: /start
bot.start(async (ctx) => {
  const telegramUserId = ctx.from.id.toString();
  
  try {
    // Check if user exists
    let [user] = await db.select().from(users).where(eq(users.telegramUserId, telegramUserId));
    
    if (!user) {
      // Create new user
      [user] = await db.insert(users).values({
        telegramUserId,
        status: 'pending',
      }).returning();
    }
    
    await ctx.reply(
      `🎰 *Welcome to Shuffle Code Claimer Bot!*\n\n` +
      `This bot automatically claims Shuffle.com promo codes for you.\n\n` +
      `*How it works:*\n` +
      `1️⃣ Enter your Shuffle username(s)\n` +
      `2️⃣ Select a subscription plan\n` +
      `3️⃣ Pay with cryptocurrency\n` +
      `4️⃣ Bot auto-claims codes for you\n` +
      `5️⃣ Get instant Telegram notifications\n\n` +
      `*Support multiple accounts!*\n` +
      `You can add multiple Shuffle usernames and the bot will claim codes for all of them.\n\n` +
      `Ready to start? Send me your Shuffle username(s)!\n` +
      `_(Enter one username per line for multiple accounts)_`,
      { parse_mode: 'Markdown' }
    );
    
    // Set user session to expect usernames
    userSessions.set(telegramUserId, { step: 'waiting_for_usernames' });
    
  } catch (error) {
    console.error('Start command error:', error);
    await ctx.reply('❌ Error initializing your account. Please try again.');
  }
});

// Handle text messages (conversational flow)
bot.on('text', async (ctx) => {
  const telegramUserId = ctx.from.id.toString();
  const session = userSessions.get(telegramUserId);
  
  if (!session) {
    await ctx.reply('❌ Please use /start to begin.');
    return;
  }
  
  try {
    // Step 1: Collecting usernames
    if (session.step === 'waiting_for_usernames') {
      const usernames = ctx.message.text.split('\n').map(u => u.trim()).filter(u => u.length > 0);
      
      if (usernames.length === 0) {
        await ctx.reply('❌ Please enter at least one username.');
        return;
      }
      
      // Validate usernames (basic validation)
      const invalidUsernames = usernames.filter(u => u.length < 3 || u.length > 20);
      if (invalidUsernames.length > 0) {
        await ctx.reply('❌ Invalid username(s). Usernames must be 3-20 characters long.');
        return;
      }
      
      // Store usernames in session
      session.usernames = usernames;
      session.accountCount = usernames.length;
      session.step = 'showing_plans';
      userSessions.set(telegramUserId, session);
      
      // Show plans with multiplied prices
      const availablePlans = await db.select().from(plans).where(eq(plans.isActive, true));
      
      if (availablePlans.length === 0) {
        await ctx.reply('❌ No plans available at the moment. Please try again later.');
        return;
      }
      
      let message = `✅ *Accounts to add:* ${session.accountCount}\n`;
      message += usernames.map((u, i) => `  ${i + 1}. ${u}`).join('\n');
      message += `\n\n💎 *Available Subscription Plans*\n\n`;
      
      availablePlans.forEach((plan, index) => {
        const totalPrice = (plan.priceCents / 100) * session.accountCount;
        message += `*${index + 1}. ${plan.name}*\n`;
        message += `   💰 Price: $${plan.priceCents / 100} × ${session.accountCount} accounts = *$${totalPrice}*\n`;
        message += `   ⏰ Duration: ${plan.durationDays} days\n\n`;
      });
      
      message += '📝 Reply with the plan number to purchase (e.g., send "1" for the first plan)';
      
      await ctx.reply(message, { parse_mode: 'Markdown' });
      
      return;
    }
    
    // Step 2: Plan selection
    if (session.step === 'showing_plans') {
      const planNumber = parseInt(ctx.message.text);
      
      if (!planNumber || isNaN(planNumber)) {
        await ctx.reply('❌ Please send a valid plan number (e.g., 1, 2, 3...)');
        return;
      }
      
      // Get plan
      const availablePlans = await db.select().from(plans).where(eq(plans.isActive, true));
      const plan = availablePlans[planNumber - 1];
      
      if (!plan) {
        await ctx.reply(`❌ Invalid plan number. Please choose between 1 and ${availablePlans.length}`);
        return;
      }
      
      // Get or create user
      let [user] = await db.select().from(users).where(eq(users.telegramUserId, telegramUserId));
      
      if (!user) {
        [user] = await db.insert(users).values({
          telegramUserId,
          status: 'pending',
        }).returning();
      }
      
      // Calculate total price
      const totalPriceCents = plan.priceCents * session.accountCount;
      const totalPrice = totalPriceCents / 100;
      
      // Create pending subscription with usernames stored
      const orderId = `SUB-${user.id}-${Date.now()}`;
      const [subscription] = await db.insert(subscriptions).values({
        userId: user.id,
        planId: plan.id,
        status: 'pending',
        oxapayOrderId: orderId,
      }).returning();
      
      // Store usernames in session for later use
      session.subscriptionId = subscription.id;
      session.planId = plan.id;
      userSessions.set(telegramUserId, session);
      
      // Create OxaPay invoice with total price
      const invoice = await oxaPayService.createInvoice({
        amount: totalPrice,
        currency: plan.currency,
        orderId,
        description: `${plan.name} - ${session.accountCount} account(s): ${session.usernames.join(', ')}`,
        callbackUrl: `${DOMAIN}/api/oxapay/webhook`,
        email: ctx.from.username ? `${ctx.from.username}@telegram.user` : undefined,
      });
      
      // Update subscription with trackId
      await db.update(subscriptions)
        .set({ oxapayTrackId: invoice.trackId })
        .where(eq(subscriptions.id, subscription.id));
      
      await ctx.reply(
        `💳 *Payment Invoice Created!*\n\n` +
        `Plan: ${plan.name}\n` +
        `Accounts: ${session.accountCount} (${session.usernames.join(', ')})\n` +
        `Price per account: $${plan.priceCents / 100}\n` +
        `*Total Amount: $${totalPrice}*\n` +
        `Duration: ${plan.durationDays} days\n\n` +
        `Click the button below to pay with cryptocurrency:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: `💰 Pay $${totalPrice} Now`, url: invoice.payLink }
            ]]
          }
        }
      );
      
      await ctx.reply(
        `⏰ Invoice expires in 30 minutes.\n` +
        `After payment, your accounts will be activated automatically!\n\n` +
        `I'll notify you when the payment is confirmed.`
      );
      
      // Reset session
      session.step = 'waiting_for_payment';
      userSessions.set(telegramUserId, session);
      
      return;
    }
    
  } catch (error) {
    console.error('Message handler error:', error);
    await ctx.reply('❌ An error occurred. Please try /start again.');
  }
});

// Command: /status
bot.command('status', async (ctx) => {
  const telegramUserId = ctx.from.id.toString();
  
  try {
    const [user] = await db.select().from(users).where(eq(users.telegramUserId, telegramUserId));
    
    if (!user) {
      await ctx.reply('❌ No account found. Use /start to create one.');
      return;
    }
    
    const [activeSubscription] = await db.select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, user.id))
      .where(eq(subscriptions.status, 'active'))
      .limit(1);
    
    if (!activeSubscription) {
      await ctx.reply('❌ No active subscription. Use /subscribe to see plans.');
      return;
    }
    
    const [plan] = await db.select().from(plans).where(eq(plans.id, activeSubscription.planId));
    
    const expiryDate = new Date(activeSubscription.expiryAt);
    const daysLeft = Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
    
    await ctx.reply(
      `📊 *Your Subscription Status*\n\n` +
      `Plan: ${plan.name}\n` +
      `Status: ${user.status === 'active' ? '✅ Active' : '⏸ Inactive'}\n` +
      `Shuffle Account: ${user.shuffleUsername || '❌ Not connected'}\n` +
      `Expires: ${expiryDate.toLocaleDateString()}\n` +
      `Days Left: ${daysLeft}\n\n` +
      `${!user.shuffleUsername ? 'Use /connect to link your Shuffle account!' : ''}`,
      { parse_mode: 'Markdown' }
    );
    
  } catch (error) {
    console.error('Status command error:', error);
    await ctx.reply('❌ Error fetching status. Please try again.');
  }
});

// Command: /connect
bot.command('connect', async (ctx) => {
  const telegramUserId = ctx.from.id.toString();
  
  try {
    const [user] = await db.select().from(users).where(eq(users.telegramUserId, telegramUserId));
    
    if (!user) {
      await ctx.reply('❌ No account found. Use /start to create one.');
      return;
    }
    
    const [activeSubscription] = await db.select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, user.id))
      .where(eq(subscriptions.status, 'active'))
      .limit(1);
    
    if (!activeSubscription) {
      await ctx.reply('❌ You need an active subscription first. Use /subscribe to see plans.');
      return;
    }
    
    const connectUrl = `${DOMAIN}/connect?userId=${user.id}&token=${generateConnectToken(user.id)}`;
    
    await ctx.reply(
      `🔗 *Connect Your Shuffle Account*\n\n` +
      `Click the button below to open the connection page.\n` +
      `You'll be redirected to Shuffle.com to extract your username.\n\n` +
      `⚠️ Make sure you're logged in to Shuffle.com first!`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '🔗 Connect Now', url: connectUrl }
          ]]
        }
      }
    );
    
  } catch (error) {
    console.error('Connect command error:', error);
    await ctx.reply('❌ Error generating connection link. Please try again.');
  }
});

function generateConnectToken(userId) {
  const crypto = require('crypto');
  const secret = process.env.CONNECT_TOKEN_SECRET || 'default-secret';
  return crypto.createHmac('sha256', secret).update(userId.toString()).digest('hex');
}

// Error handler
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ An error occurred. Please try again later.');
});

// Function to notify user about payment confirmation
async function notifyPaymentConfirmed(telegramUserId, subscriptionDetails) {
  try {
    await bot.telegram.sendMessage(
      telegramUserId,
      `✅ *Payment Confirmed!*\n\n` +
      `Your subscription is now active!\n\n` +
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
    console.error('Error notifying user:', error);
  }
}

// Export for webhook handler
module.exports = { bot, userSessions, notifyPaymentConfirmed };

// Launch bot
bot.launch().then(() => {
  console.log('🤖 Subscription bot started!');
  botInstance = bot;
}).catch((error) => {
  console.error('Failed to start bot:', error);
  process.exit(1);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
