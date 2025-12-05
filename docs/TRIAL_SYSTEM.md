# Trial System & Account Expiry

## Overview

The system now has a robust trial tracking mechanism that:
- ✅ Prevents free trial abuse
- ✅ Auto-deletes expired accounts
- ✅ Allows users to resubscribe after expiry

## How It Works

### 1. Trial History Tracking (Permanent)

The `trialHistory` collection permanently stores records of who has used the free trial:

```javascript
{
  id: 1,
  telegramUserId: "123456789",
  username: "shuffle_user",
  claimedAt: "2025-11-17T10:30:00.000Z"
}
```

**Key Features:**
- Records are **NEVER deleted**
- Tracks both `telegramUserId` and `username` separately
- Prevents trial abuse even after account expiry

### 2. Expired Account Cleanup

The `shuffleAccounts` collection stores active subscriptions that get auto-deleted after expiry:

```javascript
{
  id: 1,
  userId: 5,
  username: "shuffle_user",
  status: "active",
  expiryAt: "2025-11-17T11:00:00.000Z",  // Deleted after this time
  createdAt: "2025-11-17T10:30:00.000Z",
  updatedAt: "2025-11-17T10:30:00.000Z"
}
```

### 3. Trial Eligibility Check

When a user enters usernames, the system checks:

```javascript
// Check 1: Has this Telegram ID used the trial?
const hasTrialHistory = await firebaseDB.hasUsedTrial(telegramUserId);

// Check 2: Has ANY username been used for a trial?
for (const username of usernames) {
  if (await firebaseDB.hasUsedTrial(null, username)) {
    usernameHasTrialHistory = true;
  }
}

// If EITHER is true -> NOT eligible for free trial
if (hasTrialHistory || usernameHasTrialHistory) {
  // Show paid plans only
}
```

## Running Cleanup Script

### Manual Cleanup

```bash
node scripts/cleanup-expired-accounts.js
```

**Output:**
```
🧹 Starting cleanup of expired accounts...
✅ Deleted 3 expired account(s):
   - user123 (expired at 2025-11-17T10:00:00.000Z)
   - user456 (expired at 2025-11-17T10:15:00.000Z)
   - user789 (expired at 2025-11-17T10:30:00.000Z)
🎉 Cleanup completed successfully!
```

### Automated Cleanup (Recommended)

**Option 1: Cron Job (Linux/Mac)**

Add to crontab:
```bash
# Run cleanup every hour
0 * * * * cd /path/to/project && node scripts/cleanup-expired-accounts.js >> logs/cleanup.log 2>&1

# Run cleanup every 15 minutes
*/15 * * * * cd /path/to/project && node scripts/cleanup-expired-accounts.js >> logs/cleanup.log 2>&1
```

**Option 2: Node Scheduler (Built-in)**

Add to your bot or API server:
```javascript
const cron = require('node-cron');

// Run every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  console.log('Running scheduled cleanup...');
  const result = await firebaseDB.deleteExpiredShuffleAccounts();
  console.log(`Cleaned up ${result.deleted} expired accounts`);
});
```

**Option 3: Render Cron Job**

In `render.yaml`:
```yaml
- type: cron
  name: cleanup-expired-accounts
  env: node
  schedule: "*/15 * * * *"  # Every 15 minutes
  buildCommand: "echo 'No build needed'"
  startCommand: "node scripts/cleanup-expired-accounts.js"
  envVars:
    - key: FIREBASE_PROJECT_ID
      sync: false
    - key: FIREBASE_CLIENT_EMAIL
      sync: false
    - key: FIREBASE_PRIVATE_KEY
      sync: false
    - key: FIREBASE_DATABASE_URL
      sync: false
```

## Firebase Database Indexes (Important!)

For optimal performance, add these indexes in Firebase Console:

### `trialHistory` Collection
1. Go to Firebase Console → Realtime Database → Rules
2. Add indexes for:
   - `telegramUserId` (string)
   - `username` (string)

**Firebase Rules Example:**
```json
{
  "rules": {
    "trialHistory": {
      ".indexOn": ["telegramUserId", "username"]
    },
    "shuffleAccounts": {
      ".indexOn": ["userId", "username", "expiryAt"]
    }
  }
}
```

## Database Collections

### Permanent Collections (Never Auto-Deleted)
- `trialHistory` - Trial usage records
- `users` - User profiles
- `plans` - Subscription plans
- `subscriptions` - Subscription records
- `codes` - Promo code history

### Temporary Collections (Auto-Cleaned)
- `shuffleAccounts` - Active accounts (deleted after expiry)
- `authTokens` - Session tokens (deleted after expiry)
- `claimJobs` - Job queue (deleted after processing)

## User Flow Examples

### Example 1: New User (First Time)
1. User enters username: `shuffle123`
2. System checks `trialHistory` → Not found ✅
3. User is **eligible** for 30-minute trial
4. Trial is granted:
   - Create `shuffleAccount` with 30-min expiry
   - Create `trialHistory` record (permanent)
5. After 30 minutes:
   - `shuffleAccount` is auto-deleted
   - `trialHistory` remains forever

### Example 2: Returning User (After Trial Expiry)
1. User enters same username: `shuffle123`
2. System checks `trialHistory` → Found ❌
3. User is **NOT eligible** for trial
4. User must purchase a subscription
5. After purchase:
   - New `shuffleAccount` created with subscription expiry
   - After expiry, account is deleted
   - User can **resubscribe** (no duplicate error!)

### Example 3: Trial Abuse Attempt
1. User A uses trial with `username1` on Telegram ID `12345`
2. Trial expires, `shuffleAccount` is deleted
3. User A tries to claim trial again with `username2`
4. System checks `trialHistory` by Telegram ID → Found ❌
5. Trial denied!

**Alternative abuse attempt:**
1. User A uses trial with `username1`
2. User B tries to claim trial with `username1` (same username, different Telegram)
3. System checks `trialHistory` by username → Found ❌
4. Trial denied!

## API Methods

### `createTrialHistory(historyData)`
Creates a permanent trial record.
```javascript
await firebaseDB.createTrialHistory({
  telegramUserId: "123456789",
  username: "shuffle_user"
});
```

### `hasUsedTrial(telegramUserId, username)`
Checks if a user or username has used the trial.
```javascript
// Check by Telegram ID
const hasTrial = await firebaseDB.hasUsedTrial("123456789");

// Check by username
const hasTrial = await firebaseDB.hasUsedTrial(null, "shuffle_user");

// Check both
const hasTrial = await firebaseDB.hasUsedTrial("123456789", "shuffle_user");
```

### `deleteExpiredShuffleAccounts()`
Deletes all expired accounts.
```javascript
const result = await firebaseDB.deleteExpiredShuffleAccounts();
console.log(`Deleted ${result.deleted} accounts`);
console.log(result.accounts); // Array of deleted accounts
```

## Monitoring & Logs

### Check Expired Accounts (Without Deleting)
```javascript
const accountsRef = firebase.database().ref('shuffleAccounts');
const snapshot = await accountsRef.once('value');
const now = new Date().toISOString();

snapshot.forEach(child => {
  const account = child.val();
  if (account.expiryAt && account.expiryAt < now) {
    console.log(`Expired: ${account.username} (${account.expiryAt})`);
  }
});
```

### View Trial History
```javascript
const historyRef = firebase.database().ref('trialHistory');
const snapshot = await historyRef.once('value');
console.log('Total trials used:', snapshot.numChildren());
```

## Troubleshooting

### Issue: Users can claim multiple trials
**Solution:** Make sure `trialHistory` records are being created in `grantFreeTrial()` function.

### Issue: Users get errors when resubscribing
**Solution:** Run the cleanup script to delete expired accounts.

### Issue: Cleanup script not running automatically
**Solution:** Set up cron job or scheduled task (see automated cleanup section above).

### Issue: Trial checks are slow
**Solution:** Add database indexes in Firebase Console (see Firebase Database Indexes section).

## Security Notes

1. **Trial History is Immutable** - Never delete from `trialHistory` collection
2. **Check Both ID and Username** - Always verify both to prevent abuse
3. **Run Cleanup Regularly** - Set up automated cleanup every 15-60 minutes
4. **Monitor Unusual Activity** - Check `trialHistory` for patterns of abuse

## Future Enhancements

- Add admin dashboard to view trial statistics
- Add IP address tracking for additional abuse prevention
- Add email/phone verification for trial eligibility
- Add grace period before account deletion (e.g., 1 day after expiry)
