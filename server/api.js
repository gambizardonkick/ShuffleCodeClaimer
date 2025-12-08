// ============================================
// TURBO MODE: Maximum speed optimizations
// ============================================
// Set production mode for V8 optimizations
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const express = require('express');
const cors = require('cors');
const path = require('path');
const { WebSocketServer } = require('ws');
const firebaseDB = require('./firebaseDb.js');
const { initializeFirebase } = require('./firebase.js');
const { oxaPayService } = require('./oxapay.js');
const { TelegramNotifier } = require('../shared/telegramNotifier.js');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const https = require('https');

// Performance: Force V8 to optimize hot functions
if (typeof gc === 'function') {
  // Disable automatic GC during message processing
  console.log('⚡ Manual GC control enabled');
}

initializeFirebase();

// Initialize TWO Telegram notifiers:
// 1. telegramNotifier - for code notifications (uses @ShuffleCodeClaimerBot)
// 2. subscriptionNotifier - for payment confirmations (uses the subscription bot users interact with)
const notifierBotToken = process.env.TELEGRAM_BOT_TOKEN || process.env.SUBSCRIPTION_BOT_TOKEN;
const subscriptionBotToken = process.env.SUBSCRIPTION_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;

const telegramNotifier = new TelegramNotifier(notifierBotToken);
const subscriptionNotifier = new TelegramNotifier(subscriptionBotToken);

// Validate bot token on startup
async function validateBotToken() {
  if (!notifierBotToken) {
    console.error('❌ [TELEGRAM] No bot token configured! Notifications will NOT work.');
    return false;
  }
  
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${notifierBotToken}/getMe`,
      method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.ok) {
            console.log(`✅ [TELEGRAM] Bot validated: @${result.result.username} (ID: ${result.result.id})`);
            resolve(true);
          } else {
            console.error(`❌ [TELEGRAM] Bot token INVALID: ${result.description}`);
            console.error('❌ [TELEGRAM] Notifications will NOT work until you fix the bot token!');
            resolve(false);
          }
        } catch (e) {
          console.error('❌ [TELEGRAM] Failed to validate bot token:', e.message);
          resolve(false);
        }
      });
    });
    req.on('error', (e) => {
      console.error('❌ [TELEGRAM] Network error validating bot:', e.message);
      resolve(false);
    });
    req.end();
  });
}

// Track bot status globally
let telegramBotValid = false;

// Register webhook for notification bot /start handling
async function registerNotificationBotWebhook() {
  // Get webhook URL from environment
  const webhookDomain = process.env.DOMAIN || 
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null);
  
  if (!webhookDomain || !notifierBotToken) {
    console.log('⚠️  [TELEGRAM] Skipping webhook registration (no domain or token)');
    return false;
  }
  
  const webhookUrl = `${webhookDomain}/api/telegram/webhook`;
  
  return new Promise((resolve) => {
    const postData = JSON.stringify({ url: webhookUrl });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${notifierBotToken}/setWebhook`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.ok) {
            console.log(`✅ [TELEGRAM] Webhook registered: ${webhookUrl}`);
            resolve(true);
          } else {
            console.error(`❌ [TELEGRAM] Webhook registration failed: ${result.description}`);
            resolve(false);
          }
        } catch (e) {
          console.error('❌ [TELEGRAM] Failed to parse webhook response:', e.message);
          resolve(false);
        }
      });
    });
    req.on('error', (e) => {
      console.error('❌ [TELEGRAM] Network error registering webhook:', e.message);
      resolve(false);
    });
    req.write(postData);
    req.end();
  });
}

const JWT_SECRET = process.env.JWT_SECRET || 'shuffle-codes-secret-change-in-production';

// ============================================
// COMPREHENSIVE EVENT LOGGER
// ============================================
function logEvent(type, data) {
  const timestamp = new Date().toISOString();
  const icons = {
    'connect': '🟢',
    'disconnect': '🔴',
    'new_code': '🎰',
    'claim_success': '✅',
    'claim_rejected': '❌',
    'admin_code': '👑',
    'telegram_code': '📱',
    'manual_code': '📝',
    'notification_sent': '📲',
    'notification_failed': '⚠️'
  };
  const icon = icons[type] || '📋';
  console.log(`${icon} [${timestamp}] [${type.toUpperCase()}] ${JSON.stringify(data)}`);
}
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 30;

// IN-MEMORY CODE CACHE (fully client-side dashboard - no database storage)
const recentCodes = [];
const CODE_CACHE_DURATION = 5 * 60 * 1000; // Keep codes for 5 minutes

// ACTIVE CONNECTIONS TRACKING (for admin dashboard)
const activeConnections = new Map(); // shuffleAccountId -> { username, lastSeen }
const CONNECTION_TIMEOUT = 180000; // Consider offline after 180 seconds (tolerates browser tab throttling)

// WEBSOCKET CONNECTIONS (for instant code delivery)
const wsClients = new Map(); // shuffleAccountId -> WebSocket
const adminClients = new Set(); // Authenticated admin WebSocket connections
let wss = null; // WebSocket server instance

// SUPER TURBO MODE (admin-controlled fast polling)
let superTurboMode = false;

// GLOBAL NOTIFICATION SETTINGS
let notificationSettings = {
  telegramEnabled: true,        // Master toggle for Telegram notifications
  notifyConnections: true,      // Notify when users connect/disconnect
  notifyCodeClaims: true,       // Notify on code claim success/reject
  notifyNewCodes: true,         // Notify when new codes are detected
  notifyAdminCodes: true,       // Notify when admin adds codes
  adminChatId: null             // Admin chat ID for receiving all notifications
};

// Central notification function - sends to user's Telegram
// Now checks per-user telegramNotifyEnabled setting!
async function sendUserNotification(telegramId, message, eventType = 'general', options = {}) {
  const { checkUserPref = true, accountId = null, forceCheck = false } = options;
  
  // Global master toggle
  if (!notificationSettings.telegramEnabled) {
    console.log(`📴 [NOTIFICATION] Telegram disabled globally - skipping ${eventType}`);
    return { sent: false, reason: 'disabled_globally' };
  }
  
  if (!telegramId) {
    console.log(`⚠️ [NOTIFICATION] No Telegram ID - skipping ${eventType}`);
    return { sent: false, reason: 'no_telegram_id' };
  }
  
  // Check per-user preference if accountId provided
  if (checkUserPref && accountId) {
    try {
      const account = await firebaseDB.getShuffleAccountWithUser(accountId);
      if (account && account.telegramNotifyEnabled === false) {
        console.log(`📴 [NOTIFICATION] User ${account.username || accountId} has DM alerts OFF - skipping ${eventType}`);
        return { sent: false, reason: 'user_disabled' };
      }
    } catch (e) {
      // Continue if we can't check - better to send than not
    }
  }
  
  try {
    await telegramNotifier.sendMessage(telegramId, message);
    console.log(`📲 [NOTIFICATION] Sent ${eventType} to ${telegramId}`);
    logEvent('notification_sent', { type: eventType, telegramId });
    return { sent: true };
  } catch (e) {
    console.error(`❌ [NOTIFICATION] Failed ${eventType} to ${telegramId}: ${e.message}`);
    logEvent('notification_failed', { type: eventType, telegramId, error: e.message });
    return { sent: false, reason: e.message };
  }
}

// Send notification to admin (for monitoring all activity)
async function sendAdminNotification(message, eventType = 'admin') {
  if (!notificationSettings.telegramEnabled || !notificationSettings.adminChatId) {
    return { sent: false, reason: 'disabled_or_no_admin' };
  }
  
  try {
    await telegramNotifier.sendMessage(notificationSettings.adminChatId, message);
    console.log(`👑 [ADMIN NOTIFICATION] Sent ${eventType}`);
    return { sent: true };
  } catch (e) {
    console.error(`❌ [ADMIN NOTIFICATION] Failed: ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

// ADMIN ROLE-BASED ACCESS
// 'full' = full admin access (users, codes, settings, etc.)
// 'codes' = code-only access (view/add/delete codes only)
function getAdminRole(adminKey) {
  if (!adminKey) return null;
  if (adminKey === process.env.ADMIN_API_KEY) return 'full';
  if (adminKey === process.env.CODES_ADMIN_API_KEY) return 'codes';
  return null;
}

function requireAdminRole(requiredRole = 'full') {
  return (req, res, next) => {
    const adminKey = req.headers['x-admin-key'];
    const role = getAdminRole(adminKey);
    
    if (!role) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    // 'full' role has access to everything
    // 'codes' role only has access if requiredRole is 'codes'
    if (requiredRole === 'codes' || role === 'full') {
      req.adminRole = role;
      return next();
    }
    
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

// JWT AUTH MIDDLEWARE - Verifies Bearer token and attaches user info to request
function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }
    
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    
    req.user = {
      userId: decoded.userId,
      shuffleAccountId: decoded.shuffleAccountId
    };
    
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Broadcast code to all authenticated WebSocket clients - ULTRA FAST
function broadcastCode(code) {
  if (!wss || wsClients.size === 0) {
    console.log(`📡 No clients connected - code ${code.code} not broadcasted`);
    return;
  }
  
  const message = JSON.stringify({
    type: 'new_code',
    code: code
  });
  
  let sent = 0;
  
  // SYNCHRONOUS WebSocket broadcast (fastest possible)
  for (const [accountId, ws] of wsClients) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      try {
        ws.send(message);
        sent++;
      } catch (e) {
        // Silent fail for speed
      }
    }
  }
  
  console.log(`\n========== CODE BROADCAST ==========`);
  console.log(`📋 Code: ${code.code}`);
  console.log(`📡 Source: ${code.source || 'unknown'}`);
  console.log(`📤 WebSocket: Sent to ${sent} clients`);
  
  // ASYNC Telegram notifications - only to users who have DM alerts ON
  if (sent > 0 && notificationSettings.telegramEnabled) {
    setImmediate(async () => {
      const notifiedUsers = new Set();
      let telegramNotified = 0;
      let telegramSkipped = 0;
      
      for (const [accountId, ws] of wsClients) {
        const accountInfo = ws.accountInfo;
        if (accountInfo?.user?.telegramUserId && !notifiedUsers.has(accountInfo.user.telegramUserId)) {
          notifiedUsers.add(accountInfo.user.telegramUserId);
          const telegramId = accountInfo.user.telegramUserId;
          const username = accountInfo?.username || `Account#${accountId}`;
          
          // Check if this user has DM alerts enabled
          const userHasAlertsOn = accountInfo?.telegramNotifyEnabled === true;
          
          if (userHasAlertsOn) {
            const message = `🎰 *NEW CODE DETECTED*\n\n` +
              `*Code:* \`${code.code}\`\n` +
              (code.value ? `💰 *Value:* ${code.value}\n` : '') +
              (code.limit ? `👥 *Limit:* ${code.limit}\n` : '') +
              (code.wagerRequirement ? `🎲 *Wager:* ${code.wagerRequirement}\n` : '') +
              (code.timeline ? `⏰ *Deadline:* ${code.timeline}\n` : '') +
              `\n⚡ Auto-claiming in progress...`;
            
            const result = await sendUserNotification(telegramId, message, 'new_code', { checkUserPref: false });
            if (result.sent) telegramNotified++;
          } else {
            telegramSkipped++;
          }
        }
      }
      
      // Also notify admin
      if (notificationSettings.adminChatId) {
        const adminMsg = `🎰 *NEW CODE BROADCASTED*\n\n` +
          `*Code:* \`${code.code}\`\n` +
          (code.value ? `💰 *Value:* ${code.value}\n` : '') +
          `📡 *Source:* ${code.source || 'unknown'}\n` +
          `👥 *Sent to:* ${sent} clients\n` +
          `📲 *DM sent:* ${telegramNotified}, skipped: ${telegramSkipped}`;
        await sendAdminNotification(adminMsg, 'new_code');
      }
      
      console.log(`📲 Telegram: ${telegramNotified} sent, ${telegramSkipped} skipped (DM alerts OFF)`);
      console.log(`====================================\n`);
    });
  } else if (sent > 0) {
    console.log(`📲 Telegram: Disabled globally`);
    console.log(`====================================\n`);
  } else {
    console.log(`📲 Telegram: No clients connected`);
    console.log(`====================================\n`);
  }
}

// Broadcast super turbo state change
function broadcastTurboState(enabled) {
  if (!wss) return;
  
  const message = JSON.stringify({
    type: 'turbo_state',
    enabled: enabled
  });
  
  for (const [_, ws] of wsClients) {
    if (ws.readyState === 1) {
      try { ws.send(message); } catch (e) {}
    }
  }
}

// Cleanup stale connections every 30 seconds
// ONLY remove if WebSocket is also disconnected (WebSocket is source of truth)
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [id, data] of activeConnections) {
    // Only mark offline if WebSocket is also closed
    if (!wsClients.has(id) && now - data.lastSeen > CONNECTION_TIMEOUT) {
      activeConnections.delete(id);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`🔌 Connection cleanup: ${removed} stale entries removed, ${activeConnections.size} online`);
  }
}, 30000);

// Auto-cleanup cache every minute
setInterval(() => {
  const now = Date.now();
  const validCodes = recentCodes.filter(c => (now - c.timestamp) < CODE_CACHE_DURATION);
  const removed = recentCodes.length - validCodes.length;
  recentCodes.length = 0;
  recentCodes.push(...validCodes);
  if (removed > 0) {
    console.log(`🧹 Cache cleanup: removed ${removed} old codes, ${recentCodes.length} remaining`);
  }
}, 60 * 1000); // Run every minute

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());

// REQUEST LOGGER - Only log important requests
app.use((req, res, next) => {
  // Skip logging for spammy/polling endpoints
  const skipUrls = [
    '/api/codes',        // Client polling
    '/health',           // Health checks
    '/api/heartbeat',    // Heartbeat polling
    '/api/check',        // Status checks
    '/api/settings',     // Admin dashboard polling
    '/api/admin/users',  // Admin dashboard polling
    '/',                 // Root health probes
  ];
  
  if (skipUrls.some(url => req.url === url || req.url.startsWith(url + '?'))) {
    return next();
  }
  
  const timestamp = new Date().toISOString();
  console.log(`📥 [${timestamp}] ${req.method} ${req.url} from ${req.ip || req.connection.remoteAddress}`);
  next();
});

// Health Check Endpoint (for Render monitoring)
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'shuffle-api-server'
  });
});

// Notification Bot Webhook - Handle /start command for @ShuffleCodeClaimerBot
app.post('/api/telegram/webhook', express.json(), async (req, res) => {
  try {
    const update = req.body;
    
    // Handle /start command
    if (update.message?.text === '/start') {
      const chatId = update.message.chat.id;
      const firstName = update.message.from?.first_name || 'there';
      
      const welcomeMessage = 
        `👋 Hello ${firstName}!\n\n` +
        `This bot sends you notifications for:\n` +
        `• ✅ Successful code claims\n` +
        `• ❌ Failed/rejected codes\n` +
        `• 🟢 Connection status updates\n\n` +
        `*To use this bot:*\n` +
        `1. Purchase a subscription via @ShuffleSubscriptionBot\n` +
        `2. Enable "Telegram DM Alerts" in the Tampermonkey dashboard\n\n` +
        `📢 Join our Telegram for codes: https://t.me/shufflecodesdrops\n\n` +
        `🔗 Your chat is now linked and ready to receive notifications!`;
      
      await telegramNotifier.sendMessage(chatId, welcomeMessage);
      console.log(`👋 /start from ${firstName} (${chatId})`);
    }
    
    res.json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook error:', error);
    res.json({ ok: true }); // Always return OK to Telegram
  }
});

// Webhook Test Endpoint - verifies webhook is reachable
app.get('/api/oxapay/webhook/test', (req, res) => {
  res.status(200).json({ 
    status: 'ok',
    message: 'Webhook endpoint is reachable',
    timestamp: new Date().toISOString()
  });
});

// OxaPay Webhook Handler - MUST be before express.json() to capture raw body
app.post('/api/oxapay/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  console.log('========== WEBHOOK START ==========');
  try {
    // Get raw body as string for signature verification
    let rawPayload;
    let data;
    
    if (Buffer.isBuffer(req.body)) {
      rawPayload = req.body.toString('utf8');
      console.log('📥 Raw body captured (Buffer)');
    } else if (typeof req.body === 'string') {
      rawPayload = req.body;
      console.log('📥 Raw body captured (String)');
    } else {
      rawPayload = JSON.stringify(req.body);
      console.log('📥 Raw body reconstructed from object');
    }
    
    console.log('🔍 Raw payload length:', rawPayload.length);
    console.log('🔍 Raw payload:', rawPayload.substring(0, 500));
    
    if (!rawPayload || rawPayload.trim() === '') {
      console.error('❌ Empty request body');
      return res.status(400).send('Empty request body');
    }
    
    data = JSON.parse(rawPayload);
    
    console.log('🔍 Content-Type:', req.headers['content-type']);
    console.log('📢 Parsed data:', JSON.stringify(data));
    
    const hmacHeader = req.headers['hmac'];
    
    // Verify webhook signature (if HMAC header is present)
    if (hmacHeader) {
      console.log('🔍 HMAC header:', hmacHeader);
      const isValid = oxaPayService.verifyWebhookSignature(rawPayload, hmacHeader);
      
      if (!isValid) {
        console.error('❌ Invalid OxaPay webhook signature');
        console.error('❌ Raw payload used for verification:', rawPayload);
        return res.status(403).send('Invalid signature');
      }
      console.log('✅ Webhook signature verified');
    } else {
      // OxaPay may not always send HMAC - validate by checking required fields
      if (!data.orderId || !data.status) {
        console.error('Invalid webhook payload - missing required fields');
        console.error('Data received:', data);
        return res.status(400).send('Invalid payload');
      }
      console.log('⚠️ No HMAC header - validating by payload structure');
    }
    
    console.log('📢 OxaPay Webhook received:', data);
    
    console.log('Step 3: Looking up subscription for orderId:', data.orderId);
    
    // Find subscription by order ID
    const subscriptionsRef = firebaseDB.db.ref('subscriptions');
    const subscriptionSnapshot = await subscriptionsRef.orderByChild('oxapayOrderId').equalTo(data.orderId).once('value');
    
    if (!subscriptionSnapshot.exists()) {
      console.error('Step 3 FAILED: Subscription not found for orderId:', data.orderId);
      return res.status(404).send('Subscription not found');
    }
    
    console.log('Step 4: Subscription found');
    const subscriptionId = Object.keys(subscriptionSnapshot.val())[0];
    const subscription = { id: subscriptionId, ...subscriptionSnapshot.val()[subscriptionId] };
    console.log('Step 5: Subscription data:', JSON.stringify(subscription));
    
    // Normalize status to lowercase for comparison
    const paymentStatus = data.status.toLowerCase();
    
    // Handle "Paying" status - user initiated payment, waiting for funds
    if (paymentStatus === 'paying') {
      console.log(`💳 Payment initiated for subscription ${subscription.id}`);
      return res.status(200).send('OK');
    }
    
    // Handle "Confirming" status - payment received, waiting for blockchain confirmation
    if (paymentStatus === 'confirming') {
      console.log(`⏳ Payment confirming for subscription ${subscription.id}`);
      
      // Send "confirming" notification via SUBSCRIPTION BOT (same bot user interacted with)
      if (subscription.telegramChatId) {
        try {
          const confirmingMsg = await subscriptionNotifier.sendMessage(
            subscription.telegramChatId,
            `⏳ *Payment Received!*\n\nYour payment is being confirmed on the blockchain. This usually takes 1-5 minutes.\n\nWe'll notify you once it's complete! ✅`,
            { parse_mode: 'Markdown' }
          );
          
          // Save the confirming message ID so we can delete it later
          if (confirmingMsg && confirmingMsg.message_id) {
            await firebaseDB.updateSubscription(subscription.id, {
              confirmingMessageId: confirmingMsg.message_id
            });
          }
          
          console.log('📨 Sent confirming notification to user (via subscription bot)');
        } catch (notifyError) {
          console.error('❌ Error sending confirming notification:', notifyError);
        }
      }
      
      return res.status(200).send('OK');
    }
    
    // Update subscription based on payment status
    if (paymentStatus === 'paid') {
      console.log('Step 6: Processing PAID status...');
      console.log('Step 7: Looking up plan:', subscription.planId);
      const plan = await firebaseDB.findPlanById(subscription.planId);
      if (!plan) {
        console.error('Step 7 FAILED: Plan not found:', subscription.planId);
        return res.status(500).send('Plan not found');
      }
      console.log('Step 8: Plan found:', plan.name);
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + plan.durationDays);
      console.log('Step 9: Calculated expiry:', expiryDate.toISOString());
      
      // Update subscription (OxaPay uses payAmount/payCurrency, not paidAmount/paidCurrency)
      // Only include fields that have values (Firebase doesn't allow undefined)
      const subscriptionUpdate = {
        status: 'active',
        expiryAt: expiryDate.toISOString(),
        paidAmount: data.payAmount || data.amount || null,
        paidCurrency: data.payCurrency || data.currency || null,
      };
      
      // Add optional fields only if they exist
      if (data.txId) subscriptionUpdate.txId = data.txId;
      if (data.txID) subscriptionUpdate.txId = data.txID;
      if (data.network) subscriptionUpdate.network = data.network;
      if (data.senderAddress) subscriptionUpdate.senderAddress = data.senderAddress;
      
      await firebaseDB.updateSubscription(subscription.id, subscriptionUpdate);
      
      // Update user status
      await firebaseDB.updateUser(subscription.userId, { status: 'active' });
      
      console.log(`✅ Subscription ${subscription.id} activated for user ${subscription.userId}`);
      
      // Activate shuffle accounts if usernames were provided
      if (subscription.pendingUsernames && Array.isArray(subscription.pendingUsernames) && subscription.pendingUsernames.length > 0) {
        console.log(`📝 Activating ${subscription.pendingUsernames.length} shuffle accounts...`);
        
        for (const username of subscription.pendingUsernames) {
          try {
            // Check if account already exists
            const existingAccounts = await firebaseDB.findShuffleAccountsByUsername(username.toLowerCase());
            
            if (existingAccounts.length > 0) {
              // Update existing account
              await firebaseDB.updateShuffleAccount(existingAccounts[0].id, {
                status: 'active',
                expiryAt: expiryDate.toISOString(),
              });
              console.log(`✅ Updated shuffle account: ${username}`);
            } else {
              // Create new account
              await firebaseDB.createShuffleAccount({
                userId: subscription.userId,
                username: username.toLowerCase(),
                status: 'active',
                expiryAt: expiryDate.toISOString(),
              });
              console.log(`✅ Created shuffle account: ${username}`);
            }
          } catch (accountError) {
            console.error(`❌ Error activating account ${username}:`, accountError);
          }
        }
      }
      
      // Send Telegram notification using SUBSCRIPTION BOT (same bot user interacted with)
      if (subscription.telegramChatId) {
        try {
          // Delete the "confirming" message if it exists
          if (subscription.confirmingMessageId) {
            await subscriptionNotifier.deleteMessage(
              subscription.telegramChatId,
              subscription.confirmingMessageId
            );
            console.log('🗑️ Deleted confirming message');
          }
          
          // Delete the original payment message if it exists
          if (subscription.paymentMessageId) {
            await subscriptionNotifier.deleteMessage(
              subscription.telegramChatId,
              subscription.paymentMessageId
            );
            console.log('🗑️ Deleted payment message');
          }
          
          // Send fresh confirmation message via subscription bot
          await subscriptionNotifier.notifyPaymentConfirmed(
            subscription.telegramChatId,
            null,
            {
              planName: plan.name,
              accountCount: subscription.pendingUsernames ? subscription.pendingUsernames.length : 0,
              expiryDate: expiryDate.toISOString(),
              usernames: subscription.pendingUsernames || []
            }
          );
          console.log('📨 Sent payment confirmation to user (via subscription bot)');
        } catch (notifyError) {
          console.error('❌ Error sending Telegram notification:', notifyError);
        }
      }
      
    } else if (paymentStatus === 'expired') {
      await firebaseDB.updateSubscription(subscription.id, { status: 'expired' });
      
      console.log(`⏰ Subscription ${subscription.id} expired`);
    }
    
    res.status(200).send('OK');
    
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
    console.error('❌ Webhook error stack:', error.stack);
    console.error('❌ Webhook payload was:', JSON.stringify(req.body, null, 2));
    res.status(500).send('Internal server error');
  }
});

// Standard JSON parsing for all other routes (AFTER webhook handler)
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Admin: Manually add shuffle username to subscription
app.post('/api/admin/shuffle-accounts', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    
    if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const { telegramUserId, username, expiryAt, telegramChatId } = req.body;
    
    if (!telegramUserId || !username) {
      return res.status(400).json({ error: 'Missing telegramUserId or username' });
    }
    
    // Find or create user
    let user = await firebaseDB.findUserByTelegramId(telegramUserId);
    
    if (!user) {
      user = await firebaseDB.createUser({
        telegramUserId,
        status: 'active',
      });
    }
    
    // Check if username already exists
    const existing = await firebaseDB.findShuffleAccountsByUsername(username.toLowerCase());
    
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    
    // Create subscription with telegramChatId for notifications (use telegramUserId as chatId if not provided)
    const chatId = telegramChatId || telegramUserId;
    await firebaseDB.createSubscription({
      orderId: `ADMIN-${Date.now()}`,
      userId: user.id,
      planId: 0, // Admin granted
      status: 'active',
      telegramChatId: chatId,
      pendingUsernames: [username.trim().toLowerCase()],
      expiresAt: expiryAt ? new Date(expiryAt).toISOString() : null
    });
    
    // Add shuffle account
    const account = await firebaseDB.createShuffleAccount({
      userId: user.id,
      username: username.trim().toLowerCase(),
      status: 'active',
      expiryAt: expiryAt ? new Date(expiryAt).toISOString() : null,
    });
    
    console.log(`✅ Admin added shuffle account: ${username} for user ${user.id} (chatId: ${chatId})`);
    
    res.json({
      success: true,
      account,
      telegramChatId: chatId,
    });
    
  } catch (error) {
    console.error('Admin add account error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Auth: Connect with shuffle username
app.post('/api/auth/connect', async (req, res) => {
  try {
    const { shuffleUsername } = req.body;
    
    if (!shuffleUsername) {
      return res.status(400).json({ error: 'Missing shuffleUsername' });
    }
    
    // Find shuffle account
    const accounts = await firebaseDB.findShuffleAccountsByUsername(shuffleUsername.toLowerCase());
    
    if (accounts.length === 0) {
      return res.status(404).json({ error: 'No active subscription for this username' });
    }
    
    const account = accounts[0];
    
    // Check if account is active and not expired
    if (account.status !== 'active') {
      return res.status(403).json({ error: 'Account is not active' });
    }
    
    if (account.expiryAt && new Date(account.expiryAt) < new Date()) {
      return res.status(403).json({ error: 'Subscription has expired' });
    }
    
    // Get telegram chat ID from user's subscription
    let telegramChatId = null;
    let telegramLinked = false;
    const subscriptionsRef = firebaseDB.db.ref('subscriptions');
    const subSnapshot = await subscriptionsRef.orderByChild('userId').equalTo(account.userId).once('value');
    if (subSnapshot.exists()) {
      subSnapshot.forEach((childSnapshot) => {
        const sub = childSnapshot.val();
        if (sub.telegramChatId) {
          telegramChatId = sub.telegramChatId;
          telegramLinked = true;
        }
      });
    }
    
    // Generate tokens
    const accessToken = jwt.sign(
      { 
        userId: account.userId,
        shuffleAccountId: account.id,
        username: account.username,
      },
      JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_EXPIRY }
    );
    
    const refreshToken = crypto.randomBytes(32).toString('hex');
    const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    
    const refreshExpiryDate = new Date();
    refreshExpiryDate.setDate(refreshExpiryDate.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);
    
    // Delete old sessions for this account
    const sessionsRef = firebaseDB.db.ref('authSessions');
    const oldSessionsSnapshot = await sessionsRef.orderByChild('shuffleAccountId').equalTo(account.id).once('value');
    if (oldSessionsSnapshot.exists()) {
      const updates = {};
      oldSessionsSnapshot.forEach((session) => {
        updates[session.key] = null;
      });
      await sessionsRef.update(updates);
    }
    
    // Create new session
    await firebaseDB.createAuthSession({
      userId: account.userId,
      shuffleAccountId: account.id,
      accessToken: refreshTokenHash,
      refreshToken: refreshTokenHash,
      expiresAt: refreshExpiryDate.toISOString(),
    });
    
    console.log(`✅ User authenticated: ${account.username}`);
    
    res.json({
      success: true,
      accessToken,
      refreshToken,
      username: account.username,
      expiryAt: account.expiryAt,
      telegramLinked: telegramLinked,
      telegramNotifyEnabled: account.telegramNotifyEnabled || false,
      telegramChatId: telegramChatId,
      telegramBotToken: process.env.SUBSCRIPTION_BOT_TOKEN,
    });
    
  } catch (error) {
    console.error('Auth connect error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Auth: Verify current session
app.get('/api/auth/verify', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ valid: false, error: 'No token provided' });
    }
    
    const token = authHeader.substring(7);
    
    // Verify JWT
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ valid: false, error: 'Invalid or expired token' });
    }
    
    // Check if account still active
    const accountSnapshot = await firebaseDB.db.ref(`shuffleAccounts/${decoded.shuffleAccountId}`).once('value');
    
    if (!accountSnapshot.exists()) {
      return res.status(403).json({ valid: false, error: 'Account not found' });
    }
    
    const account = { id: decoded.shuffleAccountId, ...accountSnapshot.val() };
    
    if (account.status !== 'active') {
      return res.status(403).json({ valid: false, error: 'Account is not active' });
    }
    
    if (account.expiryAt && new Date(account.expiryAt) < new Date()) {
      return res.status(403).json({ valid: false, error: 'Subscription has expired' });
    }
    
    res.json({
      valid: true,
      username: account.username,
      subscriptionExpiry: account.expiryAt,
    });
    
  } catch (error) {
    console.error('Auth verify error:', error);
    res.status(500).json({ valid: false, error: 'Internal server error' });
  }
});

// Auth: Refresh tokens
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      return res.status(400).json({ error: 'Missing refreshToken' });
    }
    
    const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    
    // Find session
    const session = await firebaseDB.findAuthSessionByRefreshToken(refreshTokenHash);
    
    if (!session) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    
    if (new Date(session.expiresAt) < new Date()) {
      return res.status(401).json({ error: 'Refresh token expired' });
    }
    
    // Check account still active
    const accountSnapshot = await firebaseDB.db.ref(`shuffleAccounts/${session.shuffleAccountId}`).once('value');
    
    if (!accountSnapshot.exists()) {
      return res.status(403).json({ error: 'Account not found' });
    }
    
    const account = { id: session.shuffleAccountId, ...accountSnapshot.val() };
    
    if (account.status !== 'active') {
      return res.status(403).json({ error: 'Account is not active' });
    }
    
    if (account.expiryAt && new Date(account.expiryAt) < new Date()) {
      return res.status(403).json({ error: 'Subscription has expired' });
    }
    
    // Generate new tokens
    const newAccessToken = jwt.sign(
      { 
        userId: account.userId,
        shuffleAccountId: account.id,
        username: account.username,
      },
      JWT_SECRET,
      { expiresIn: ACCESS_TOKEN_EXPIRY }
    );
    
    const newRefreshToken = crypto.randomBytes(32).toString('hex');
    const newRefreshTokenHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
    
    // Update session with new refresh token (rotation)
    await firebaseDB.db.ref(`authSessions/${session.id}`).update({
      refreshToken: newRefreshTokenHash,
      lastActiveAt: new Date().toISOString(),
    });
    
    res.json({
      success: true,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
    
  } catch (error) {
    console.error('Auth refresh error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Auth: Logout
app.post('/api/auth/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      return res.status(400).json({ error: 'Missing refreshToken' });
    }
    
    const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    
    // Delete session
    const session = await firebaseDB.findAuthSessionByRefreshToken(refreshTokenHash);
    if (session) {
      await firebaseDB.deleteAuthSession(session.id);
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Auth logout error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// REMOVED: Telegram notification endpoints (toggle + send)
// All Telegram functionality now handled directly in browser:
// - Toggle ON/OFF stored in GM_setValue (no backend)
// - Messages sent directly from browser to Telegram Bot API
// - Eliminates backend load for 5000+ users

// ============================================
// HEARTBEAT & SETTINGS ENDPOINTS
// ============================================

// Heartbeat - track active connections (called every 30s by userscript)
app.post('/api/heartbeat', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token' });
    }
    
    const token = authHeader.substring(7);
    
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    // Update active connection
    activeConnections.set(decoded.shuffleAccountId, {
      username: decoded.username,
      lastSeen: Date.now()
    });
    
    // Return current settings
    res.json({ 
      ok: true,
      superTurbo: superTurboMode,
      pollInterval: superTurboMode ? 50 : 200 // 50ms turbo, 200ms normal
    });
    
  } catch (error) {
    console.error('Heartbeat error:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Get settings (public - for userscript to check turbo mode)
app.get('/api/settings', (req, res) => {
  res.json({
    superTurbo: superTurboMode,
    pollInterval: superTurboMode ? 50 : 200,
    onlineUsers: activeConnections.size,
    notifications: notificationSettings
  });
});

// Update notification settings (admin only)
app.post('/api/admin/notifications/settings', requireAdminRole('full'), (req, res) => {
  try {
    const { telegramEnabled, notifyConnections, notifyCodeClaims, notifyNewCodes, notifyAdminCodes, adminChatId } = req.body;
    
    console.log(`\n========== NOTIFICATION SETTINGS UPDATED ==========`);
    
    if (typeof telegramEnabled === 'boolean') {
      notificationSettings.telegramEnabled = telegramEnabled;
      console.log(`📱 Telegram notifications: ${telegramEnabled ? 'ENABLED' : 'DISABLED'}`);
    }
    if (typeof notifyConnections === 'boolean') {
      notificationSettings.notifyConnections = notifyConnections;
      console.log(`🔌 Connection notifications: ${notifyConnections ? 'ON' : 'OFF'}`);
    }
    if (typeof notifyCodeClaims === 'boolean') {
      notificationSettings.notifyCodeClaims = notifyCodeClaims;
      console.log(`✅ Claim notifications: ${notifyCodeClaims ? 'ON' : 'OFF'}`);
    }
    if (typeof notifyNewCodes === 'boolean') {
      notificationSettings.notifyNewCodes = notifyNewCodes;
      console.log(`🎰 New code notifications: ${notifyNewCodes ? 'ON' : 'OFF'}`);
    }
    if (typeof notifyAdminCodes === 'boolean') {
      notificationSettings.notifyAdminCodes = notifyAdminCodes;
      console.log(`👑 Admin code notifications: ${notifyAdminCodes ? 'ON' : 'OFF'}`);
    }
    if (adminChatId !== undefined) {
      notificationSettings.adminChatId = adminChatId;
      console.log(`👤 Admin chat ID: ${adminChatId || 'NOT SET'}`);
    }
    
    console.log(`===================================================\n`);
    
    res.json({ success: true, settings: notificationSettings });
  } catch (error) {
    console.error('Update notification settings error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Sync user's notification preference (from Tampermonkey script)
app.post('/api/notifications/sync', requireAuth, async (req, res) => {
  try {
    const { telegramNotifyEnabled } = req.body;
    const shuffleAccountId = req.user.shuffleAccountId;
    
    if (typeof telegramNotifyEnabled !== 'boolean') {
      return res.status(400).json({ error: 'telegramNotifyEnabled must be a boolean' });
    }
    
    // If enabling, verify chat ID is reachable first (silent probe - no user-visible message)
    if (telegramNotifyEnabled) {
      const account = await firebaseDB.getShuffleAccountWithUser(shuffleAccountId);
      const telegramId = account?.user?.telegramUserId;
      
      if (!telegramId) {
        return res.status(400).json({ 
          error: 'No Telegram ID linked',
          needsStart: true,
          botLink: 'https://t.me/ShuffleCodeClaimerBot'
        });
      }
      
      // Silent reachability test - doesn't send any user-visible message
      const reachability = await telegramNotifier.canReachChat(telegramId);
      if (!reachability.reachable) {
        console.log(`❌ Cannot reach chat ${telegramId}: ${reachability.error}`);
        return res.status(400).json({ 
          error: 'Cannot send messages to your Telegram. Please click /start on the bot first.',
          needsStart: true,
          botLink: 'https://t.me/ShuffleCodeClaimerBot'
        });
      }
    }
    
    // Update the shuffle account with the notification preference
    await firebaseDB.updateShuffleAccount(shuffleAccountId, {
      telegramNotifyEnabled: telegramNotifyEnabled
    });
    
    console.log(`📲 [SYNC] Account ${shuffleAccountId} notifications: ${telegramNotifyEnabled ? 'ON' : 'OFF'}`);
    
    res.json({ success: true, telegramNotifyEnabled });
  } catch (error) {
    console.error('Notification sync error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Test notification endpoint (admin only)
app.post('/api/admin/notifications/test', requireAdminRole('full'), async (req, res) => {
  try {
    const { telegramId, message } = req.body;
    
    if (!telegramId) {
      return res.status(400).json({ error: 'Telegram ID required' });
    }
    
    const testMessage = message || `🔔 *Test Notification*\n\nThis is a test message from the Shuffle Code Claimer admin panel.\n\n✅ Your notifications are working!`;
    
    console.log(`📤 Sending test notification to ${telegramId}...`);
    
    const result = await sendUserNotification(telegramId, testMessage, 'test');
    
    res.json({ success: result.sent, ...result });
  } catch (error) {
    console.error('Test notification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Verify admin key and return role/permissions
app.get('/api/admin/verify', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  const role = getAdminRole(adminKey);
  
  if (!role) {
    return res.status(403).json({ error: 'Invalid admin key' });
  }
  
  // Return role and what sections they can access
  const permissions = {
    role: role,
    canAccessCodes: true, // Both roles can access codes
    canAccessUsers: role === 'full',
    canAccessSettings: role === 'full',
    canAccessTurboMode: role === 'full',
    canAddShuffleAccounts: role === 'full'
  };
  
  res.json(permissions);
});

// Connect user's Shuffle account (OLD ENDPOINT - DEPRECATED)
app.post('/api/connect', async (req, res) => {
  try {
    const { userId, token, shuffleUsername, authToken } = req.body;
    
    // Verify connection token
    const secret = process.env.CONNECT_TOKEN_SECRET || 'default-secret';
    const expectedToken = crypto.createHmac('sha256', secret).update(userId.toString()).digest('hex');
    
    if (token !== expectedToken) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    
    // Get user
    const user = await firebaseDB.findUserById(parseInt(userId));
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Check if user has active subscription
    const activeSubscriptions = await firebaseDB.findActiveSubscriptionsByUserId(user.id);
    
    if (activeSubscriptions.length === 0) {
      return res.status(403).json({ error: 'No active subscription' });
    }
    
    // Update user with Shuffle username
    await firebaseDB.updateUser(user.id, {
      shuffleUsername,
      status: 'active',
    });
    
    // Store auth token (encrypted in production)
    await firebaseDB.createAuthToken({
      userId: user.id,
      tokenType: 'shuffle_auth',
      tokenValue: authToken,
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    
    console.log(`✅ User ${user.id} connected Shuffle account: ${shuffleUsername}`);
    
    res.json({
      success: true,
      message: 'Account connected successfully!',
      username: shuffleUsername,
    });
    
  } catch (error) {
    console.error('Connect error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get subscription status
app.get('/api/subscription/status/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    
    const user = await firebaseDB.findUserById(userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const activeSubscriptions = await firebaseDB.findActiveSubscriptionsByUserId(userId);
    
    res.json({
      user,
      subscription: activeSubscriptions[0] || null,
    });
    
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve HTML connect page
app.get('/connect', (req, res) => {
  const { userId, token } = req.query;
  
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Connect Shuffle Account</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Inter', 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            padding: 40px;
            max-width: 500px;
            width: 100%;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        h1 {
            color: #667eea;
            font-size: 28px;
            margin-bottom: 10px;
            text-align: center;
        }
        p {
            color: #666;
            line-height: 1.6;
            margin-bottom: 20px;
            text-align: center;
        }
        .step {
            background: #f5f7fa;
            border-radius: 10px;
            padding: 15px;
            margin: 15px 0;
            border-left: 4px solid #667eea;
        }
        .step-number {
            display: inline-block;
            background: #667eea;
            color: white;
            width: 30px;
            height: 30px;
            border-radius: 50%;
            text-align: center;
            line-height: 30px;
            margin-right: 10px;
            font-weight: bold;
        }
        button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 15px 30px;
            border-radius: 10px;
            font-size: 18px;
            font-weight: 600;
            cursor: pointer;
            width: 100%;
            margin-top: 20px;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
        }
        button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        .status {
            text-align: center;
            padding: 15px;
            border-radius: 10px;
            margin-top: 20px;
            display: none;
        }
        .status.success {
            background: #d4edda;
            color: #155724;
            display: block;
        }
        .status.error {
            background: #f8d7da;
            color: #721c24;
            display: block;
        }
        .status.loading {
            background: #d1ecf1;
            color: #0c5460;
            display: block;
        }
        .loader {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid rgba(0,0,0,0.1);
            border-top-color: #667eea;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-right: 10px;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔗 Connect Shuffle Account</h1>
        <p>Link your Shuffle.com account to start auto-claiming promo codes!</p>
        
        <div class="step">
            <span class="step-number">1</span>
            <strong>Open shuffle.com/vip-program in a new tab</strong>
        </div>
        
        <div class="step">
            <span class="step-number">2</span>
            <strong>Make sure you're logged in to your account</strong>
        </div>
        
        <div class="step">
            <span class="step-number">3</span>
            <strong>Click the button below to auto-connect</strong>
        </div>
        
        <button id="connectBtn" onclick="connectAccount()">
            🚀 Connect Now
        </button>
        
        <div id="status" class="status"></div>
    </div>

    <script>
        const userId = "${userId}";
        const token = "${token}";
        
        async function connectAccount() {
            const btn = document.getElementById('connectBtn');
            const status = document.getElementById('status');
            
            btn.disabled = true;
            status.className = 'status loading';
            status.innerHTML = '<div class="loader"></div> Extracting your username...';
            
            try {
                // Open VIP page to extract username
                window.open('https://shuffle.com/vip-program', '_blank');
                
                // Wait for user to go to VIP page
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                status.innerHTML = '<div class="loader"></div> Please switch to the Shuffle tab and wait...';
                
                // This would normally inject a script to extract username
                // For now, we'll use a simplified approach
                const shuffleUsername = prompt('Please enter your Shuffle username (from the VIP page):');
                
                if (!shuffleUsername) {
                    throw new Error('Username not provided');
                }
                
                status.innerHTML = '<div class="loader"></div> Connecting your account...';
                
                // Get auth token from localStorage (simplified)
                const authToken = 'PLACEHOLDER'; // TODO: Extract real token
                
                // Send to backend
                const response = await fetch('/api/connect', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId,
                        token,
                        shuffleUsername,
                        authToken
                    })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    status.className = 'status success';
                    status.innerHTML = '✅ Account connected successfully! You can close this page and return to Telegram.';
                } else {
                    throw new Error(data.error || 'Connection failed');
                }
                
            } catch (error) {
                status.className = 'status error';
                status.innerHTML = '❌ ' + error.message;
                btn.disabled = false;
            }
        }
    </script>
</body>
</html>
  `);
});

// ============================================
// ADMIN ENDPOINTS
// ============================================

// Get all users with shuffle accounts
app.get('/api/admin/users', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    
    if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const shuffleAccountsRef = firebaseDB.db.ref('shuffleAccounts');
    const accountsSnapshot = await shuffleAccountsRef.orderByChild('createdAt').once('value');
    
    if (!accountsSnapshot.exists()) {
      return res.json([]);
    }
    
    const accounts = [];
    const userPromises = [];
    
    accountsSnapshot.forEach((childSnapshot) => {
      const account = childSnapshot.val();
      const accountId = parseInt(childSnapshot.key);
      
      const userPromise = firebaseDB.findUserById(account.userId).then(user => ({
        id: accountId,
        username: account.username,
        status: account.status,
        expiryAt: account.expiryAt,
        createdAt: account.createdAt,
        telegramUserId: user ? user.telegramUserId : null,
        isOnline: activeConnections.has(accountId),
        lastSeen: activeConnections.get(accountId)?.lastSeen || null,
      }));
      
      userPromises.push(userPromise);
    });
    
    const accountsWithUsers = await Promise.all(userPromises);
    accountsWithUsers.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    
    // Add summary stats
    const onlineCount = accountsWithUsers.filter(u => u.isOnline).length;
    
    res.json({
      users: accountsWithUsers,
      stats: {
        total: accountsWithUsers.length,
        online: onlineCount,
        superTurbo: superTurboMode
      }
    });
    
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete user
app.delete('/api/admin/users/:id', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    
    if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const id = parseInt(req.params.id);
    
    const authSessionsRef = firebaseDB.db.ref('authSessions');
    const sessionsSnapshot = await authSessionsRef.orderByChild('shuffleAccountId').equalTo(id).once('value');
    
    if (sessionsSnapshot.exists()) {
      const deletePromises = [];
      sessionsSnapshot.forEach((childSnapshot) => {
        deletePromises.push(authSessionsRef.child(childSnapshot.key).remove());
      });
      await Promise.all(deletePromises);
    }
    
    await firebaseDB.db.ref(`shuffleAccounts/${id}`).remove();
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Toggle Super Turbo Mode (admin only)
app.post('/api/admin/super-turbo', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    
    if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const { enabled } = req.body;
    superTurboMode = !!enabled;
    
    console.log(`🚀 Super Turbo Mode: ${superTurboMode ? 'ENABLED' : 'DISABLED'}`);
    
    res.json({ 
      success: true, 
      superTurbo: superTurboMode,
      pollInterval: superTurboMode ? 50 : 200
    });
    
  } catch (error) {
    console.error('Super turbo toggle error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// CODES ENDPOINTS
// ============================================

// Get all codes - CLIENT-SIDE DASHBOARD (returns from in-memory cache only)
app.get('/api/codes', async (req, res) => {
  try {
    // Cleanup stale codes before returning
    const now = Date.now();
    const validCodes = recentCodes.filter(c => (now - c.timestamp) < CODE_CACHE_DURATION);
    recentCodes.length = 0;
    recentCodes.push(...validCodes);
    
    // Return codes from in-memory cache (no database query)
    // Clients store codes locally in browser - this is just for new code detection
    res.json(recentCodes);
  } catch (error) {
    console.error('Get codes error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Add code manually (admin) - NO DATABASE, uses in-memory cache only
// Both 'full' and 'codes' roles can add codes
app.post('/api/admin/codes', requireAdminRole('codes'), async (req, res) => {
  try {
    const { code, value, limit, wagerRequirement, timeline } = req.body;
    
    console.log(`\n========== ADMIN CODE ADDED ==========`);
    console.log(`👑 Code: ${code}`);
    console.log(`💰 Value: ${value || 'N/A'}`);
    console.log(`👥 Limit: ${limit || 'N/A'}`);
    console.log(`🎲 Wager: ${wagerRequirement || 'N/A'}`);
    console.log(`⏰ Timeline: ${timeline || 'N/A'}`);
    console.log(`🔌 Connected clients: ${wsClients.size}`);
    
    if (!code) {
      console.log(`❌ Code missing - rejected`);
      return res.status(400).json({ error: 'Code is required' });
    }
    
    // Check if code already exists in cache
    const existing = recentCodes.find(c => c.code === code);
    if (existing) {
      console.log(`❌ Code already exists - rejected`);
      return res.status(400).json({ error: 'Code already exists' });
    }
    
    // Add to in-memory cache (NO DATABASE)
    const newCode = {
      code,
      value: value || null,
      limit: limit || null,
      wagerRequirement: wagerRequirement || null,
      timeline: timeline || null,
      timestamp: Date.now(),
      claimed: false,
      rejectionReason: null,
      source: 'admin'
    };
    
    recentCodes.unshift(newCode);
    codeSet.add(code); // Add to Set for duplicate checking
    
    // Log new code from admin
    logEvent('admin_code', { code, value, limit, wagerRequirement, timeline, connectedClients: wsClients.size });
    
    // Broadcast to all WebSocket clients instantly
    broadcastCode(newCode);
    
    console.log(`✅ Admin code added and broadcast initiated`);
    console.log(`=======================================\n`);
    
    res.json({ success: true, code: newCode });
    
  } catch (error) {
    console.error('❌ Add code error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete code - NO DATABASE, removes from in-memory cache only
// Both 'full' and 'codes' roles can delete codes
app.delete('/api/admin/codes/:code', requireAdminRole('codes'), async (req, res) => {
  try {
    const codeToDelete = req.params.code;
    
    // Remove from in-memory cache AND codeSet
    const filtered = recentCodes.filter(c => c.code !== codeToDelete);
    recentCodes.length = 0;
    recentCodes.push(...filtered);
    codeSet.delete(codeToDelete); // Sync Set with cache
    
    console.log(`✅ Deleted code from cache: ${codeToDelete}`);
    res.json({ success: true });
    
  } catch (error) {
    console.error('Delete code error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// REMOVED: /api/code/claim endpoint - claims tracked locally in browser only

// ============================================
// ULTRA-FAST CODE DETECTION (OPTIMIZED FOR SPEED)
// ============================================

// PRE-COMPILED REGEX PATTERNS (faster than compiling each time)
const CODE_PATTERN_STANDALONE = /^([A-Za-z0-9]+)$/m;
const CODE_PATTERN_INLINE = /\b([A-Za-z0-9]+)\b/;
const VALUE_PATTERN = /\$(\d+(?:\.\d+)?)\s+for\s+the\s+first/i;
const LIMIT_PATTERN = /for\s+the\s+first\s+([\d,]+)!/i;
const WAGER_PATTERN = /\$([\d,]+)\s+wager\s+requirement/i;
const TIMELINE_PATTERN = /past\s+(\d+)\s+days?/i;

// O(1) lookup for duplicate detection
const codeSet = new Set();

// Code detection function - OPTIMIZED FOR <50ms
function detectAndStoreCode(messageText) {
  const startTime = Date.now();
  
  // Fast code extraction
  let codeMatch = messageText.match(CODE_PATTERN_STANDALONE);
  if (!codeMatch) {
    codeMatch = messageText.match(CODE_PATTERN_INLINE);
  }
  
  if (!codeMatch) return;
  
  const code = codeMatch[1];
  
  // O(1) duplicate check using Set
  if (codeSet.has(code)) return;
  
  // IMMEDIATELY add to Set to prevent duplicates
  codeSet.add(code);
  
  // Create code object with just the code first (SPEED!)
  const newCode = {
    code,
    value: null,
    limit: null,
    wagerRequirement: null,
    timeline: null,
    timestamp: Date.now(),
    claimed: false,
    rejectionReason: null
  };
  
  // Add to cache BEFORE extracting metadata
  recentCodes.unshift(newCode);
  
  // BROADCAST IMMEDIATELY - don't wait for metadata extraction
  broadcastCode(newCode);
  
  const broadcastTime = Date.now() - startTime;
  
  // Extract metadata AFTER broadcast (non-blocking enhancement)
  setImmediate(() => {
    const valueMatch = messageText.match(VALUE_PATTERN);
    const limitMatch = messageText.match(LIMIT_PATTERN);
    const wagerMatch = messageText.match(WAGER_PATTERN);
    const timelineMatch = messageText.match(TIMELINE_PATTERN);
    
    // Update code with metadata
    newCode.value = valueMatch ? `$${valueMatch[1]}` : null;
    newCode.limit = limitMatch ? limitMatch[1] : null;
    newCode.wagerRequirement = wagerMatch ? `$${wagerMatch[1]}` : null;
    newCode.timeline = timelineMatch ? `${timelineMatch[1]} days` : null;
    
    // Cleanup old codes (older than 5 minutes) - deferred
    const now = Date.now();
    if (recentCodes.length > 10) {
      const validCodes = recentCodes.filter(c => (now - c.timestamp) < CODE_CACHE_DURATION);
      recentCodes.length = 0;
      recentCodes.push(...validCodes);
      
      // Sync codeSet with recentCodes
      codeSet.clear();
      recentCodes.forEach(c => codeSet.add(c.code));
    }
    
    // Log new code from Telegram
    logEvent('telegram_code', { code, value: newCode.value, limit: newCode.limit, broadcastMs: broadcastTime, connectedClients: wsClients.size });
  });
}

// Telegram message endpoint (for code detection) - PASS-THROUGH MODE
app.post('/api/telegram-message', async (req, res) => {
  try {
    const { message } = req.body;
    detectAndStoreCode(message);
    res.json({ success: true });
  } catch (error) {
    console.error('Telegram message error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// CLAIM RESULT NOTIFICATION ENDPOINT
// ============================================
// Receives claim results from Tampermonkey and sends Telegram notifications
app.post('/api/claim-result', requireAuth, async (req, res) => {
  try {
    const { code, success, reason, value, shuffleUsername, source } = req.body;
    const userId = req.user.userId;
    const shuffleAccountId = req.user.shuffleAccountId;
    
    console.log(`\n========== CLAIM RESULT RECEIVED ==========`);
    console.log(`📋 Code: ${code}`);
    console.log(`${success ? '✅' : '❌'} Result: ${success ? 'SUCCESS' : 'REJECTED'}`);
    if (!success && reason) console.log(`📝 Reason: ${reason}`);
    console.log(`🔗 Source: ${source || 'auto'}`);
    
    if (!code) {
      return res.status(400).json({ error: 'Code is required' });
    }
    
    // Get user info for Telegram notification
    const accountInfo = await firebaseDB.getShuffleAccountWithUser(shuffleAccountId);
    const telegramUserId = accountInfo?.user?.telegramUserId;
    const username = shuffleUsername || accountInfo?.username || `Account#${shuffleAccountId}`;
    
    console.log(`👤 Username: ${username}`);
    console.log(`📱 Telegram ID: ${telegramUserId || 'NOT LINKED'}`);
    
    // Comprehensive logging
    const eventType = success ? 'claim_success' : 'claim_rejected';
    logEvent(eventType, {
      code,
      username,
      telegramId: telegramUserId,
      value: value || null,
      reason: reason || null,
      source: source || 'auto'
    });
    
    // Send Telegram notification based on PER-USER preference (not global setting)
    let notificationSent = false;
    const userHasAlertsOn = accountInfo?.telegramNotifyEnabled === true;
    
    console.log(`🔔 User DM alerts: ${userHasAlertsOn ? 'ON' : 'OFF'}`);
    
    if (notificationSettings.telegramEnabled && telegramUserId) {
      if (userHasAlertsOn) {
        const escapeMarkdown = (text) => {
          if (!text) return text;
          return String(text).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
        };
        
        const safeCode = escapeMarkdown(code);
        const safeUsername = escapeMarkdown(username);
        const safeReason = escapeMarkdown(reason || 'Unknown');
        const safeValue = escapeMarkdown(value);
        
        const message = success 
          ? `✅ CODE CLAIMED!\n\n` +
            `Code: ${code}\n` +
            (value ? `💰 Value: ${value}\n` : '') +
            `👤 Account: ${username}\n\n` +
            `🎉 Successfully added to your balance!`
          : `❌ CODE REJECTED\n\n` +
            `Code: ${code}\n` +
            `👤 Account: ${username}\n` +
            `📝 Reason: ${reason || 'Unknown'}\n\n` +
            `💡 This code may be expired or already claimed.`;
        
        console.log(`📤 Sending claim DM to ${telegramUserId}...`);
        
        // Skip per-user check since we already checked above
        const result = await sendUserNotification(telegramUserId, message, 'claim_result', { 
          checkUserPref: false 
        });
        notificationSent = result.sent;
        
        if (notificationSent) {
          console.log(`✅ Claim DM SENT to ${telegramUserId}`);
        } else {
          console.error(`❌ Claim DM FAILED to ${telegramUserId}: ${result.reason}`);
        }
      } else {
        console.log(`📴 Claim DM skipped for ${username} (DM alerts OFF)`);
      }
      
      // Always notify admin if admin chat is configured
      if (notificationSettings.adminChatId) {
        const adminMsg = `📋 *CLAIM ${success ? 'SUCCESS' : 'REJECTED'}*\n\n` +
          `*Code:* \`${code}\`\n` +
          `👤 *User:* ${username}\n` +
          `📱 *Telegram:* ${telegramUserId || 'Not linked'}\n` +
          `🔔 *DM Alerts:* ${userHasAlertsOn ? 'ON' : 'OFF'}\n` +
          (success ? (value ? `💰 *Value:* ${value}\n` : '') : `📝 *Reason:* ${reason || 'Unknown'}\n`) +
          `🔗 *Source:* ${source || 'auto'}`;
        await sendAdminNotification(adminMsg, 'claim_result');
      }
    } else if (!telegramUserId) {
      logEvent('notification_failed', { type: 'claim_result', username, reason: 'No Telegram ID linked' });
      console.log(`⚠️ Cannot send DM - no Telegram ID linked for ${username}`);
    }
    
    console.log(`============================================\n`);
    
    // Broadcast to admin WebSocket clients
    broadcastAdminUpdate({
      type: 'claim_result',
      accountId: shuffleAccountId,
      username,
      code,
      success,
      reason: reason || null,
      value: value || null,
      timestamp: Date.now()
    });
    
    res.json({ success: true, notified: notificationSent, telegramId: telegramUserId || null });
    
  } catch (error) {
    console.error('❌ Claim result error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Broadcast updates to admin clients (defined here for use above)
function broadcastAdminUpdate(data) {
  if (adminClients.size === 0) return;
  const message = JSON.stringify(data);
  for (const client of adminClients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      try {
        client.send(message);
      } catch (e) {
        adminClients.delete(client);
      }
    } else {
      adminClients.delete(client);
    }
  }
}

const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 API server running on port ${PORT}`);
  console.log(`📡 Webhook URL: http://0.0.0.0:${PORT}/api/oxapay/webhook`);
  console.log(`📊 Admin Dashboard: http://0.0.0.0:${PORT}/admin.html`);
  
  // Validate Telegram bot token for notifications
  console.log('\n============ TELEGRAM BOT VALIDATION ============');
  telegramBotValid = await validateBotToken();
  if (telegramBotValid) {
    await registerNotificationBotWebhook();
  }
  console.log('==================================================\n');
  
  // Initialize WebSocket server - ULTRA OPTIMIZED FOR SPEED
  wss = new WebSocketServer({ 
    server, 
    path: '/ws',
    perMessageDeflate: false,  // Disable compression for minimum latency
    maxPayload: 64 * 1024      // 64KB max (codes are tiny)
  });
  
  // Enable TCP_NODELAY on the underlying HTTP server for instant packet delivery
  server.on('connection', (socket) => {
    socket.setNoDelay(true);  // Disable Nagle's algorithm
  });
  
  console.log(`🔌 WebSocket server ready at ws://0.0.0.0:${PORT}/ws (TURBO MODE)`);
  console.log(`   ⚡ Compression: DISABLED | TCP_NODELAY: ENABLED`);
  
  wss.on('connection', (ws, req) => {
    let accountId = null;
    let accountInfo = null;
    let authenticated = false;
    
    // Set up ping/pong for connection health
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    
    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // Authentication message
        if (msg.type === 'auth' && msg.token) {
          try {
            const decoded = jwt.verify(msg.token, JWT_SECRET);
            accountId = decoded.shuffleAccountId;
            authenticated = true;
            
            // Store connection with metadata
            ws.accountId = accountId;
            wsClients.set(accountId, ws);
            
            // Look up user info for notifications
            accountInfo = await firebaseDB.getShuffleAccountWithUser(accountId);
            ws.accountInfo = accountInfo;
            
            // Send auth success + current state
            ws.send(JSON.stringify({
              type: 'auth_success',
              turboMode: superTurboMode,
              recentCodes: recentCodes
            }));
            
            const username = accountInfo?.username || `Account#${accountId}`;
            const telegramUserId = accountInfo?.user?.telegramUserId;
            
            // Comprehensive connection logging
            logEvent('connect', { username, accountId, telegramId: telegramUserId, totalOnline: wsClients.size });
            
            // Update active connections
            activeConnections.set(accountId, {
              username: username,
              lastSeen: Date.now()
            });
            
            // Broadcast connection state to admin clients
            broadcastAdminUpdate({ type: 'user_connected', accountId, username, totalOnline: wsClients.size });
            
            // Send Telegram notification for connect ONLY if user has DM alerts enabled
            if (notificationSettings.telegramEnabled && telegramUserId) {
              // Check if this user has DM alerts enabled
              const userHasAlertsOn = accountInfo?.telegramNotifyEnabled === true;
              
              if (userHasAlertsOn) {
                const connectMsg = `🟢 *CONNECTED*\n\n` +
                  `Your account *${username}* is now online and ready to auto-claim codes!\n\n` +
                  `📡 WebSocket connected\n` +
                  `⚡ Instant code delivery active`;
                sendUserNotification(telegramUserId, connectMsg, 'connect', { checkUserPref: false });
                console.log(`📲 Connection alert sent to ${username} (DM alerts ON)`);
              } else {
                console.log(`📴 Connection alert skipped for ${username} (DM alerts OFF)`);
              }
              
              // Notify admin of connection (always, if admin chat configured)
              if (notificationSettings.adminChatId) {
                const adminConnectMsg = `🟢 *USER CONNECTED*\n\n` +
                  `👤 *User:* ${username}\n` +
                  `📱 *Telegram:* ${telegramUserId || 'Not linked'}\n` +
                  `🔔 *DM Alerts:* ${userHasAlertsOn ? 'ON' : 'OFF'}\n` +
                  `👥 *Total Online:* ${wsClients.size}`;
                sendAdminNotification(adminConnectMsg, 'connect');
              }
            }
          } catch (e) {
            ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
            ws.close();
          }
        }
        
        // Heartbeat/ping from client
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          
          // Update active connections (same as REST polling)
          if (accountId && msg.username) {
            activeConnections.set(accountId, {
              username: msg.username,
              lastSeen: Date.now()
            });
          }
        }
        
        // Admin subscription (for real-time updates) - with key verification
        if (msg.type === 'admin_subscribe') {
          if (msg.adminKey && msg.adminKey === process.env.ADMIN_API_KEY) {
            ws.isAdmin = true;
            adminClients.add(ws);
            ws.send(JSON.stringify({ type: 'admin_auth_success', totalOnline: wsClients.size }));
            console.log(`👑 Admin subscribed to real-time updates (${adminClients.size} admin(s))`);
          } else {
            ws.send(JSON.stringify({ type: 'admin_auth_error', message: 'Invalid admin key' }));
            console.log('⛔ Admin subscription rejected: invalid key');
          }
        }
      } catch (e) {
        // Invalid JSON - ignore
      }
    });
    
    ws.on('close', async () => {
      // Clean up admin client if applicable
      if (ws.isAdmin) {
        adminClients.delete(ws);
        console.log(`👑 Admin disconnected (${adminClients.size} admin(s) remaining)`);
      }
      
      if (accountId) {
        wsClients.delete(accountId);
        activeConnections.delete(accountId);
        
        const username = accountInfo?.username || `Account#${accountId}`;
        const telegramUserId = accountInfo?.user?.telegramUserId;
        
        // Comprehensive disconnection logging
        logEvent('disconnect', { username, accountId, telegramId: telegramUserId, totalOnline: wsClients.size });
        
        // Broadcast connection state to admin clients
        broadcastAdminUpdate({ type: 'user_disconnected', accountId, username, totalOnline: wsClients.size });
        
        // Send Telegram notification for disconnect ONLY if user has DM alerts enabled
        if (notificationSettings.telegramEnabled && telegramUserId) {
          const userHasAlertsOn = accountInfo?.telegramNotifyEnabled === true;
          
          if (userHasAlertsOn) {
            const disconnectMsg = `🔴 *DISCONNECTED*\n\n` +
              `Your account *${username}* went offline.\n\n` +
              `⚠️ Codes will NOT be auto-claimed while offline.\n` +
              `💡 Refresh Shuffle.com to reconnect.`;
            sendUserNotification(telegramUserId, disconnectMsg, 'disconnect', { checkUserPref: false });
            console.log(`📲 Disconnect alert sent to ${username} (DM alerts ON)`);
          } else {
            console.log(`📴 Disconnect alert skipped for ${username} (DM alerts OFF)`);
          }
          
          // Notify admin of disconnection (always, if admin chat configured)
          if (notificationSettings.adminChatId) {
            const adminDisconnectMsg = `🔴 *USER DISCONNECTED*\n\n` +
              `👤 *User:* ${username}\n` +
              `📱 *Telegram:* ${telegramUserId || 'Not linked'}\n` +
              `🔔 *DM Alerts:* ${userHasAlertsOn ? 'ON' : 'OFF'}\n` +
              `👥 *Total Online:* ${wsClients.size}`;
            sendAdminNotification(adminDisconnectMsg, 'disconnect');
          }
        }
      }
    });
    
    ws.on('error', (err) => {
      console.error('WS error:', err.message);
    });
  });
  
  // Heartbeat to detect dead connections (every 30s)
  setInterval(() => {
    if (!wss) return;
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);
  
  // Start bots after server is ready (only when running directly)
  if (require.main === module) {
    setTimeout(async () => {
      try {
        await startBots();
      } catch (error) {
        console.error('💥 Bot startup error:', error);
        console.error(error.stack);
      }
    }, 500);
  }
});

async function startBots() {
  console.log('\n' + '='.repeat(60));
  console.log('🤖 Starting integrated bots...');
  console.log('='.repeat(60) + '\n');
  
  const botErrors = [];
  
  console.log('📝 Checking SUBSCRIPTION_BOT_TOKEN...');
  try {
    if (process.env.SUBSCRIPTION_BOT_TOKEN) {
      console.log('   ✓ SUBSCRIPTION_BOT_TOKEN found, loading bot...');
      const { bot } = require('../subscription-bot-v2.js');
      console.log('   ✓ Bot module loaded, launching...');
      
      let botRunning = false;
      bot.launch().then(() => {
        console.log('✅ Subscription bot started successfully');
        botRunning = true;
      }).catch((err) => {
        console.error('❌ Subscription bot launch error:', err.message);
      });
      
      process.once('SIGINT', () => { if (botRunning) bot.stop('SIGINT'); });
      process.once('SIGTERM', () => { if (botRunning) bot.stop('SIGTERM'); });
      console.log('   ⏩ Subscription bot launch initiated (non-blocking)');
    } else {
      console.warn('⚠️  SUBSCRIPTION_BOT_TOKEN not set - subscription bot skipped');
      botErrors.push('SUBSCRIPTION_BOT_TOKEN missing');
    }
  } catch (error) {
    console.error('❌ Failed to start subscription bot:', error.message);
    console.error(error.stack);
    botErrors.push(`Subscription bot: ${error.message}`);
  }

  console.log('\n📝 Checking TELEGRAM_API_ID and TELEGRAM_API_HASH...');
  try {
    if (process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH) {
      console.log('   ✓ Telegram credentials found');
      const { TelegramClient } = require("telegram");
      const { StringSession } = require("telegram/sessions");
      const { NewMessage } = require("telegram/events");

      const apiId = parseInt(process.env.TELEGRAM_API_ID);
      const apiHash = process.env.TELEGRAM_API_HASH;
      let sessionString = process.env.TELEGRAM_SESSION || process.env.TELEGRAM_SESSION_STRING || "";
      console.log(`   Session length: ${sessionString.length} characters`);

      if (sessionString && sessionString.length > 0) {
        const isValidSession = /^[A-Za-z0-9+/=]+$/.test(sessionString) && sessionString.length > 100;
        if (!isValidSession) {
          console.log('⚠️  Invalid session string detected, telegram client skipped');
          sessionString = "";
        }
      }

      if (!sessionString || sessionString.length < 100) {
        console.warn('⚠️  No valid TELEGRAM_SESSION found - telegram client skipped');
        console.warn('   Generate session with: node login.js');
        botErrors.push('TELEGRAM_SESSION missing/invalid');
      } else {
        console.log('   ✓ Valid session detected, connecting...');
        const SOURCE_GROUPS = ['shuffle', 'shufflevip', 'shuffleboost', 'shufflesports', 'shufflecodebottest'];
        const TARGET_CHANNEL = '@shufflecodesdrops';

        console.log('📱 Starting Telegram User Client (TURBO MODE)...');
        const stringSession = new StringSession(sessionString);
        const client = new TelegramClient(stringSession, apiId, apiHash, { 
          connectionRetries: 5,
          retryDelay: 100,              // Fast retry on disconnect
          autoReconnect: true,          // Always stay connected
          useWSS: true,                 // WebSocket for lower latency
          requestRetries: 1,            // Minimal retries for speed
          floodSleepThreshold: 0,       // Don't auto-sleep (we handle limits)
          deviceModel: 'ShuffleCodeBot',
          systemVersion: 'TurboMode',
          appVersion: '7.6.0'
        });

        await client.connect();
        console.log('✅ Telegram client connected');

        const targetChannel = await client.getEntity(TARGET_CHANNEL);
        const sourceEntities = [];
        for (const groupUsername of SOURCE_GROUPS) {
          try {
            const entity = await client.getEntity(groupUsername);
            sourceEntities.push(entity);
            console.log(`   ✓ ${entity.title || groupUsername}`);
          } catch (error) {
            console.error(`   ✗ ${groupUsername}`);
          }
        }

        if (sourceEntities.length === 0) {
          throw new Error('No source groups accessible');
        }

        console.log(`✅ Monitoring ${sourceEntities.length} groups → ${TARGET_CHANNEL}`);

        // Pre-compute source group IDs for O(1) lookup (SPEED OPTIMIZATION)
        const sourceGroupIds = new Set(sourceEntities.map(e => e.id.toString()));
        console.log(`   ⚡ Fast lookup enabled for ${sourceGroupIds.size} groups`);

        client.addEventHandler(async (event) => {
          const handlerStart = Date.now();
          try {
            const message = event.message;
            if (!message) return;
            
            // FAST PATH: Get chat ID directly without full entity resolution
            const chatId = message.peerId?.channelId?.toString() || 
                          message.peerId?.chatId?.toString() ||
                          message.chatId?.toString();
            
            if (!chatId || !sourceGroupIds.has(chatId)) {
              // Fallback to slower method only if fast path fails
              const chat = await message.getChat();
              if (!chat || !sourceGroupIds.has(chat.id?.toString())) return;
            }
            
            const messageText = message.message || '';
            
            // IMMEDIATELY detect and broadcast code (SPEED PRIORITY!)
            detectAndStoreCode(messageText);
            
            const broadcastTime = Date.now() - handlerStart;
            console.log(`📩 Code detected in ${broadcastTime}ms → broadcasting to ${wsClients.size} clients`);
            
            // Forward message to target channel AFTER broadcasting (non-blocking)
            setImmediate(async () => {
              try {
                const sendOptions = { message: messageText };
                if (message.media) sendOptions.file = message.media;
                await client.sendMessage(targetChannel, sendOptions);
                
                await client.sendMessage(targetChannel, {
                  message: '🤖 **Get Automatic Code Claimer Bot**\n└ Start here: @ShuffleSubscriptionBot'
                });
              } catch (error) {
                console.error(`   ✗ Forward failed: ${error.message}`);
              }
            });
          } catch (error) {
            // Silent fail for speed - log only in debug mode
            if (process.env.DEBUG) console.error('Message handler error:', error.message);
          }
        }, new NewMessage({}));
      }
    } else {
      console.warn('⚠️  TELEGRAM_API_ID/HASH not set - telegram client skipped');
      botErrors.push('TELEGRAM_API_ID/HASH missing');
    }
  } catch (error) {
    console.error('❌ Failed to start telegram client:', error.message);
    botErrors.push(`Telegram client: ${error.message}`);
  }

  console.log('\n' + '='.repeat(60));
  if (botErrors.length === 0) {
    console.log('✅ All bots running');
  } else {
    console.log('⚠️  Some bots skipped:', botErrors.join(', '));
  }
  console.log('='.repeat(60) + '\n');
}

module.exports = app;
