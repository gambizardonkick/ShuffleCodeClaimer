const { getDatabase } = require('./firebase');

class FirebaseDB {
  constructor() {
    this.db = getDatabase();
  }

  async getNextId(entityType) {
    const counterRef = this.db.ref(`_counters/${entityType}`);
    const transaction = await counterRef.transaction((current) => {
      return (current || 0) + 1;
    });
    return transaction.snapshot.val();
  }

  async createUser(userData) {
    const usersRef = this.db.ref('users');
    
    const userSnapshot = await usersRef.orderByChild('telegramUserId').equalTo(userData.telegramUserId).once('value');
    if (userSnapshot.exists()) {
      const userId = Object.keys(userSnapshot.val())[0];
      return { id: parseInt(userId), ...userSnapshot.val()[userId] };
    }

    const userId = await this.getNextId('users');
    
    const newUser = {
      telegramUserId: userData.telegramUserId,
      shuffleUsername: userData.shuffleUsername || null,
      status: userData.status || 'pending',
      trialClaimedAt: userData.trialClaimedAt || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await usersRef.child(userId.toString()).set(newUser);
    return { id: userId, ...newUser };
  }

  async findUserByTelegramId(telegramUserId) {
    const usersRef = this.db.ref('users');
    const snapshot = await usersRef.orderByChild('telegramUserId').equalTo(telegramUserId).once('value');
    
    if (!snapshot.exists()) {
      return null;
    }

    const userId = Object.keys(snapshot.val())[0];
    return { id: parseInt(userId), ...snapshot.val()[userId] };
  }

  async findUserById(userId) {
    const snapshot = await this.db.ref(`users/${userId}`).once('value');
    
    if (!snapshot.exists()) {
      return null;
    }

    return { id: parseInt(userId), ...snapshot.val() };
  }

  async updateUser(userId, updates) {
    updates.updatedAt = new Date().toISOString();
    await this.db.ref(`users/${userId}`).update(updates);
    
    const snapshot = await this.db.ref(`users/${userId}`).once('value');
    return { id: userId, ...snapshot.val() };
  }

  async createPlan(planData) {
    const plansRef = this.db.ref('plans');
    const planId = await this.getNextId('plans');
    
    const newPlan = {
      name: planData.name,
      priceCents: planData.priceCents,
      currency: planData.currency || 'TRX',
      durationDays: planData.durationDays,
      maxCodesPerDay: planData.maxCodesPerDay || 10,
      isActive: planData.isActive !== undefined ? planData.isActive : true,
      createdAt: new Date().toISOString(),
    };

    await plansRef.child(planId.toString()).set(newPlan);
    return { id: planId, ...newPlan };
  }

  async findPlanById(planId) {
    const snapshot = await this.db.ref(`plans/${planId}`).once('value');
    
    if (!snapshot.exists()) {
      return null;
    }

    return { id: parseInt(planId), ...snapshot.val() };
  }

  async getAllPlans() {
    const snapshot = await this.db.ref('plans').orderByChild('isActive').equalTo(true).once('value');
    
    if (!snapshot.exists()) {
      return [];
    }

    const plans = [];
    snapshot.forEach((childSnapshot) => {
      plans.push({
        id: parseInt(childSnapshot.key),
        ...childSnapshot.val(),
      });
    });

    return plans;
  }

  async createSubscription(subscriptionData) {
    const subscriptionsRef = this.db.ref('subscriptions');
    const subscriptionId = await this.getNextId('subscriptions');
    
    const newSubscription = {
      userId: subscriptionData.userId,
      planId: subscriptionData.planId,
      status: subscriptionData.status || 'pending',
      expiryAt: subscriptionData.expiryAt || null,
      oxapayTrackId: subscriptionData.oxapayTrackId || null,
      oxapayOrderId: subscriptionData.oxapayOrderId || null,
      paidAmount: subscriptionData.paidAmount || null,
      paidCurrency: subscriptionData.paidCurrency || null,
      txId: subscriptionData.txId || null,
      telegramChatId: subscriptionData.telegramChatId || null,
      paymentMessageId: subscriptionData.paymentMessageId || null,
      pendingUsernames: subscriptionData.pendingUsernames || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await subscriptionsRef.child(subscriptionId.toString()).set(newSubscription);
    return { id: subscriptionId, ...newSubscription };
  }

  async findSubscriptionByTrackId(trackId) {
    const subscriptionsRef = this.db.ref('subscriptions');
    const snapshot = await subscriptionsRef.orderByChild('oxapayTrackId').equalTo(trackId).once('value');
    
    if (!snapshot.exists()) {
      return null;
    }

    const subscriptionId = Object.keys(snapshot.val())[0];
    return { id: parseInt(subscriptionId), ...snapshot.val()[subscriptionId] };
  }

  async updateSubscription(subscriptionId, updates) {
    updates.updatedAt = new Date().toISOString();
    await this.db.ref(`subscriptions/${subscriptionId}`).update(updates);
    
    const snapshot = await this.db.ref(`subscriptions/${subscriptionId}`).once('value');
    return { id: parseInt(subscriptionId), ...snapshot.val() };
  }

  async findActiveSubscriptionsByUserId(userId) {
    const subscriptionsRef = this.db.ref('subscriptions');
    const snapshot = await subscriptionsRef.orderByChild('userId').equalTo(userId).once('value');
    
    if (!snapshot.exists()) {
      return [];
    }

    const subscriptions = [];
    const now = new Date().toISOString();
    
    snapshot.forEach((childSnapshot) => {
      const sub = childSnapshot.val();
      if (sub.status === 'active' && (!sub.expiryAt || sub.expiryAt > now)) {
        subscriptions.push({
          id: parseInt(childSnapshot.key),
          ...sub,
        });
      }
    });

    return subscriptions;
  }

  async createShuffleAccount(accountData) {
    const accountsRef = this.db.ref('shuffleAccounts');
    const accountId = await this.getNextId('shuffleAccounts');
    
    const newAccount = {
      userId: accountData.userId,
      username: accountData.username.toLowerCase(),
      status: accountData.status || 'pending',
      expiryAt: accountData.expiryAt || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await accountsRef.child(accountId.toString()).set(newAccount);
    return { id: accountId, ...newAccount };
  }

  async findShuffleAccountsByUsername(username) {
    const accountsRef = this.db.ref('shuffleAccounts');
    const normalizedUsername = username.toLowerCase();
    const snapshot = await accountsRef.orderByChild('username').equalTo(normalizedUsername).once('value');
    
    if (!snapshot.exists()) {
      return [];
    }

    const accounts = [];
    snapshot.forEach((childSnapshot) => {
      accounts.push({
        id: parseInt(childSnapshot.key),
        ...childSnapshot.val(),
      });
    });

    return accounts;
  }

  async findShuffleAccountsByUserId(userId) {
    const accountsRef = this.db.ref('shuffleAccounts');
    const snapshot = await accountsRef.orderByChild('userId').equalTo(userId).once('value');
    
    if (!snapshot.exists()) {
      return [];
    }

    const accounts = [];
    snapshot.forEach((childSnapshot) => {
      accounts.push({
        id: parseInt(childSnapshot.key),
        ...childSnapshot.val(),
      });
    });

    return accounts;
  }

  async updateShuffleAccount(accountId, updates) {
    updates.updatedAt = new Date().toISOString();
    await this.db.ref(`shuffleAccounts/${accountId}`).update(updates);
    
    const snapshot = await this.db.ref(`shuffleAccounts/${accountId}`).once('value');
    return { id: parseInt(accountId), ...snapshot.val() };
  }

  async getShuffleAccountWithUser(accountId) {
    const accountSnapshot = await this.db.ref(`shuffleAccounts/${accountId}`).once('value');
    
    if (!accountSnapshot.exists()) {
      return null;
    }

    const account = { id: parseInt(accountId), ...accountSnapshot.val() };
    
    if (account.userId) {
      const userSnapshot = await this.db.ref(`users/${account.userId}`).once('value');
      if (userSnapshot.exists()) {
        account.user = { id: parseInt(account.userId), ...userSnapshot.val() };
      }
    }

    return account;
  }

  async createAuthToken(tokenData) {
    const tokensRef = this.db.ref('authTokens');
    const tokenId = await this.getNextId('authTokens');
    
    const newToken = {
      userId: tokenData.userId,
      tokenType: tokenData.tokenType,
      tokenValue: tokenData.tokenValue,
      validUntil: tokenData.validUntil || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await tokensRef.child(tokenId.toString()).set(newToken);
    return { id: tokenId, ...newToken };
  }

  async findAuthToken(userId, tokenType, tokenValue) {
    const tokensRef = this.db.ref('authTokens');
    const snapshot = await tokensRef.orderByChild('userId').equalTo(userId).once('value');
    
    if (!snapshot.exists()) {
      return null;
    }

    let foundToken = null;
    snapshot.forEach((childSnapshot) => {
      const token = childSnapshot.val();
      if (token.tokenType === tokenType && token.tokenValue === tokenValue) {
        foundToken = {
          id: parseInt(childSnapshot.key),
          ...token,
        };
      }
    });

    return foundToken;
  }

  async deleteAuthToken(tokenId) {
    await this.db.ref(`authTokens/${tokenId}`).remove();
  }

  async createCode(codeData) {
    const codesRef = this.db.ref('codes');
    
    const existingSnapshot = await codesRef.orderByChild('code').equalTo(codeData.code).once('value');
    if (existingSnapshot.exists()) {
      const codeId = Object.keys(existingSnapshot.val())[0];
      return { id: parseInt(codeId), ...existingSnapshot.val()[codeId] };
    }

    const codeId = await this.getNextId('codes');
    
    const newCode = {
      code: codeData.code,
      value: codeData.value || null,
      limit: codeData.limit || null,
      wagerRequirement: codeData.wagerRequirement || null,
      timeline: codeData.timeline || null,
      amount: codeData.amount || null,
      wager: codeData.wager || null,
      deadline: codeData.deadline || null,
      claimed: codeData.claimed || false,
      rejectionReason: codeData.rejectionReason || null,
      claimedBy: codeData.claimedBy || null,
      createdAt: new Date().toISOString(),
      claimedAt: codeData.claimedAt || null,
    };

    await codesRef.child(codeId.toString()).set(newCode);
    return { id: codeId, ...newCode };
  }

  async findCodeByCode(code) {
    const codesRef = this.db.ref('codes');
    const snapshot = await codesRef.orderByChild('code').equalTo(code).once('value');
    
    if (!snapshot.exists()) {
      return null;
    }

    const codeId = Object.keys(snapshot.val())[0];
    return { id: parseInt(codeId), ...snapshot.val()[codeId] };
  }

  async updateCode(codeId, updates) {
    await this.db.ref(`codes/${codeId}`).update(updates);
    
    const snapshot = await this.db.ref(`codes/${codeId}`).once('value');
    return { id: parseInt(codeId), ...snapshot.val() };
  }

  async getRecentCodes(limit = 50) {
    const codesRef = this.db.ref('codes');
    const snapshot = await codesRef.orderByChild('createdAt').limitToLast(limit).once('value');
    
    if (!snapshot.exists()) {
      return [];
    }

    const codes = [];
    snapshot.forEach((childSnapshot) => {
      codes.push({
        id: parseInt(childSnapshot.key),
        ...childSnapshot.val(),
      });
    });

    return codes.reverse();
  }

  async createClaimJob(jobData) {
    const jobsRef = this.db.ref('claimJobs');
    const jobId = await this.getNextId('claimJobs');
    
    const newJob = {
      userId: jobData.userId,
      codeId: jobData.codeId,
      code: jobData.code,
      status: jobData.status || 'pending',
      attempts: jobData.attempts || 0,
      lastAttemptAt: jobData.lastAttemptAt || null,
      completedAt: jobData.completedAt || null,
      errorMessage: jobData.errorMessage || null,
      createdAt: new Date().toISOString(),
    };

    await jobsRef.child(jobId.toString()).set(newJob);
    return { id: jobId, ...newJob };
  }

  async updateClaimJob(jobId, updates) {
    await this.db.ref(`claimJobs/${jobId}`).update(updates);
    
    const snapshot = await this.db.ref(`claimJobs/${jobId}`).once('value');
    return { id: parseInt(jobId), ...snapshot.val() };
  }

  async createAuthSession(sessionData) {
    const sessionsRef = this.db.ref('authSessions');
    const sessionId = await this.getNextId('authSessions');
    
    const newSession = {
      userId: sessionData.userId,
      refreshToken: sessionData.refreshToken,
      expiresAt: sessionData.expiresAt,
      createdAt: new Date().toISOString(),
    };

    await sessionsRef.child(sessionId.toString()).set(newSession);
    return { id: sessionId, ...newSession };
  }

  async findAuthSessionByRefreshToken(refreshToken) {
    const sessionsRef = this.db.ref('authSessions');
    const snapshot = await sessionsRef.orderByChild('refreshToken').equalTo(refreshToken).once('value');
    
    if (!snapshot.exists()) {
      return null;
    }

    const sessionId = Object.keys(snapshot.val())[0];
    return { id: parseInt(sessionId), ...snapshot.val()[sessionId] };
  }

  async deleteAuthSession(sessionId) {
    await this.db.ref(`authSessions/${sessionId}`).remove();
  }

  async createAuditLog(logData) {
    const logsRef = this.db.ref('auditLogs');
    const logId = await this.getNextId('auditLogs');
    
    const newLog = {
      userId: logData.userId || null,
      action: logData.action,
      metadata: logData.metadata || null,
      createdAt: new Date().toISOString(),
    };

    await logsRef.child(logId.toString()).set(newLog);
    return { id: logId, ...newLog };
  }

  async createTrialHistory(historyData) {
    const historyRef = this.db.ref('trialHistory');
    const historyId = await this.getNextId('trialHistory');
    
    const newHistory = {
      telegramUserId: historyData.telegramUserId,
      username: historyData.username.toLowerCase(),
      claimedAt: new Date().toISOString(),
    };

    await historyRef.child(historyId.toString()).set(newHistory);
    return { id: historyId, ...newHistory };
  }

  async hasUsedTrial(telegramUserId, username = null) {
    const historyRef = this.db.ref('trialHistory');
    
    const telegramSnapshot = await historyRef.orderByChild('telegramUserId').equalTo(telegramUserId).once('value');
    if (telegramSnapshot.exists()) {
      return true;
    }
    
    if (username) {
      const normalizedUsername = username.toLowerCase();
      const usernameSnapshot = await historyRef.orderByChild('username').equalTo(normalizedUsername).once('value');
      if (usernameSnapshot.exists()) {
        return true;
      }
    }
    
    return false;
  }

  async deleteExpiredShuffleAccounts() {
    const accountsRef = this.db.ref('shuffleAccounts');
    const snapshot = await accountsRef.once('value');
    
    if (!snapshot.exists()) {
      return { deleted: 0, accounts: [] };
    }

    const now = new Date().toISOString();
    const deletedAccounts = [];
    let deletedCount = 0;

    const deletePromises = [];
    snapshot.forEach((childSnapshot) => {
      const account = childSnapshot.val();
      const accountId = childSnapshot.key;
      
      if (account.expiryAt && account.expiryAt < now) {
        deletedAccounts.push({
          id: parseInt(accountId),
          username: account.username,
          expiryAt: account.expiryAt
        });
        deletePromises.push(accountsRef.child(accountId).remove());
        deletedCount++;
      }
    });

    await Promise.all(deletePromises);
    
    return { 
      deleted: deletedCount, 
      accounts: deletedAccounts 
    };
  }

  async getAllShuffleAccounts() {
    const accountsRef = this.db.ref('shuffleAccounts');
    const snapshot = await accountsRef.once('value');
    
    if (!snapshot.exists()) {
      return null;
    }
    
    return snapshot.val();
  }
}

const firebaseDB = new FirebaseDB();
module.exports = firebaseDB;
