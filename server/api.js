const express = require('express');
const cors = require('cors');
const path = require('path');
const firebaseDB = require('./firebaseDb.js');
const { initializeFirebase } = require('./firebase.js');
const { oxaPayService } = require('./oxapay.js');
const { TelegramNotifier } = require('../shared/telegramNotifier.js');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

initializeFirebase();

// Initialize Telegram notifier
const telegramNotifier = new TelegramNotifier(process.env.SUBSCRIPTION_BOT_TOKEN);

const JWT_SECRET = process.env.JWT_SECRET || 'shuffle-codes-secret-change-in-production';
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 30;

// IN-MEMORY CODE CACHE (fully client-side dashboard - no database storage)
const recentCodes = [];
const CODE_CACHE_DURATION = 5 * 60 * 1000; // Keep codes for 5 minutes

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
app.use(express.json());
app.use(express.raw({ type: 'application/json' }));
app.use(express.static(path.join(__dirname, '../public')));

// Health Check Endpoint (for Render monitoring)
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    service: 'shuffle-api-server'
  });
});

// OxaPay Webhook Handler
app.post('/api/oxapay/webhook', async (req, res) => {
  try {
    const payload = JSON.stringify(req.body);
    const hmacHeader = req.headers['hmac'];
    
    // Verify webhook signature
    const isValid = oxaPayService.verifyWebhookSignature(payload, hmacHeader);
    
    if (!isValid) {
      console.error('Invalid OxaPay webhook signature');
      return res.status(403).send('Invalid signature');
    }
    
    const data = req.body;
    console.log('📢 OxaPay Webhook received:', data);
    
    // Find subscription by order ID
    const subscriptionsRef = firebaseDB.db.ref('subscriptions');
    const subscriptionSnapshot = await subscriptionsRef.orderByChild('oxapayOrderId').equalTo(data.orderId).once('value');
    
    if (!subscriptionSnapshot.exists()) {
      console.error('Subscription not found for orderId:', data.orderId);
      return res.status(404).send('Subscription not found');
    }
    
    const subscriptionId = Object.keys(subscriptionSnapshot.val())[0];
    const subscription = { id: subscriptionId, ...subscriptionSnapshot.val()[subscriptionId] };
    
    // Update subscription based on payment status
    if (data.status === 'paid') {
      const plan = await firebaseDB.findPlanById(subscription.planId);
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + plan.durationDays);
      
      // Update subscription
      await firebaseDB.updateSubscription(subscription.id, {
        status: 'active',
        expiryAt: expiryDate.toISOString(),
        paidAmount: data.paidAmount,
        paidCurrency: data.paidCurrency,
        txId: data.txID,
      });
      
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
      
      // Send Telegram notification
      if (subscription.telegramChatId) {
        try {
          const expiryDateStr = expiryDate.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
          });
          
          await telegramNotifier.notifyPaymentConfirmed(
            subscription.telegramChatId,
            subscription.paymentMessageId,
            {
              planName: plan.name,
              accountCount: subscription.pendingUsernames ? subscription.pendingUsernames.length : 0,
              expiryDate: expiryDateStr,
              usernames: subscription.pendingUsernames || []
            }
          );
        } catch (notifyError) {
          console.error('❌ Error sending Telegram notification:', notifyError);
        }
      }
      
    } else if (data.status === 'expired') {
      await firebaseDB.updateSubscription(subscription.id, { status: 'expired' });
      
      console.log(`⏰ Subscription ${subscription.id} expired`);
    }
    
    res.status(200).send('OK');
    
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Internal server error');
  }
});

// Admin: Manually add shuffle username to subscription
app.post('/api/admin/shuffle-accounts', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    
    if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const { telegramUserId, username, expiryAt } = req.body;
    
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
    
    // Add shuffle account
    const account = await firebaseDB.createShuffleAccount({
      userId: user.id,
      username: username.trim().toLowerCase(),
      status: 'active',
      expiryAt: expiryAt ? new Date(expiryAt).toISOString() : null,
    });
    
    console.log(`✅ Admin added shuffle account: ${username} for user ${user.id}`);
    
    res.json({
      success: true,
      account,
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
      }));
      
      userPromises.push(userPromise);
    });
    
    const accountsWithUsers = await Promise.all(userPromises);
    accountsWithUsers.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    
    res.json(accountsWithUsers);
    
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
app.post('/api/admin/codes', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    
    if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const { code, value, limit, wagerRequirement, timeline } = req.body;
    
    if (!code) {
      return res.status(400).json({ error: 'Code is required' });
    }
    
    // Check if code already exists in cache
    const existing = recentCodes.find(c => c.code === code);
    if (existing) {
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
      rejectionReason: null
    };
    
    recentCodes.unshift(newCode);
    
    console.log(`✅ Admin added code to cache: ${code}`);
    
    res.json({ success: true, code: newCode });
    
  } catch (error) {
    console.error('Add code error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete code - NO DATABASE, removes from in-memory cache only
app.delete('/api/admin/codes/:code', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'];
    
    if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const codeToDelete = req.params.code;
    
    // Remove from in-memory cache
    const initialLength = recentCodes.length;
    const filtered = recentCodes.filter(c => c.code !== codeToDelete);
    recentCodes.length = 0;
    recentCodes.push(...filtered);
    
    console.log(`✅ Deleted code from cache: ${codeToDelete}`);
    res.json({ success: true });
    
  } catch (error) {
    console.error('Delete code error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark code as claimed - CLIENT-SIDE ONLY (returns success, no server storage)
app.post('/api/code/claim', async (req, res) => {
  try {
    const { code, reason } = req.body;
    
    // NO DATABASE - clients track claim status locally
    // This endpoint is kept for backward compatibility but does nothing
    
    console.log(`✅ Code claim recorded (client-side): ${code}`);
    res.json({ success: true });
    
  } catch (error) {
    console.error('Claim code error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Telegram message endpoint (for code detection) - PASS-THROUGH MODE
app.post('/api/telegram-message', async (req, res) => {
  try {
    const { message } = req.body;
    
    // Simple code detection regex (4-20 alphanumeric characters)
    const codeMatch = message.match(/\b([A-Z0-9]{4,20})\b/);
    
    if (codeMatch) {
      const code = codeMatch[1];
      
      // Check if code already exists in cache
      const existingInCache = recentCodes.find(c => c.code === code);
      
      if (!existingInCache) {
        // NEW COMPREHENSIVE EXTRACTION (supports all 4 formats)
        // Pattern: "$X.XX for the first Y! - $Z,ZZZ wager requirement past N days"
        
        // VALUE: "$X.XX for the first"
        const valueMatch = message.match(/\$(\d+(?:\.\d+)?)\s+for\s+the\s+first/i);
        const value = valueMatch ? `$${valueMatch[1]}` : null;
        
        // LIMIT: "for the first Y!"
        const limitMatch = message.match(/for\s+the\s+first\s+([\d,]+)!/i);
        const limit = limitMatch ? limitMatch[1] : null;
        
        // WAGER: "$X,XXX wager requirement"
        const wagerMatch = message.match(/\$([\d,]+)\s+wager\s+requirement/i);
        const wager = wagerMatch ? `$${wagerMatch[1]}` : null;
        
        // TIMELINE: "past N days"
        const timelineMatch = message.match(/past\s+(\d+)\s+days?/i);
        const timeline = timelineMatch ? `${timelineMatch[1]} days` : null;
        
        // ADD TO IN-MEMORY CACHE (no database storage)
        const newCode = {
          code,
          value,
          limit,
          wagerRequirement: wager,
          timeline,
          timestamp: Date.now(),
          claimed: false,
          rejectionReason: null
        };
        
        recentCodes.unshift(newCode);
        
        // Cleanup old codes (older than 5 minutes)
        const now = Date.now();
        const validCodes = recentCodes.filter(c => (now - c.timestamp) < CODE_CACHE_DURATION);
        recentCodes.length = 0;
        recentCodes.push(...validCodes);
        
        console.log(`✅ Detected code: ${code} | Value: ${value || 'N/A'} | Limit: ${limit || 'N/A'} | Wager: ${wager || 'N/A'} | Timeline: ${timeline || 'N/A'} | In-memory cache: ${recentCodes.length} codes`);
      }
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Telegram message error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 API server running on port ${PORT}`);
  console.log(`📡 Webhook URL: http://0.0.0.0:${PORT}/api/oxapay/webhook`);
  console.log(`📊 Admin Dashboard: http://0.0.0.0:${PORT}/admin.html`);
});

module.exports = app;
