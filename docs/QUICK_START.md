# Quick Start Guide - Trial & Cleanup System

## ✅ What Was Fixed

### Problem 1: Expired Usernames Not Auto-Deleted
**SOLVED!** Expired accounts are now automatically deleted from the database.

### Problem 2: Free Trial Abuse Prevention
**SOLVED!** Users cannot abuse the 30-minute trial, even after their accounts expire.

## 🎯 How It Works

### The Smart Solution

We created **two separate systems** that work together:

#### 1. **Permanent Trial History** (Never Deleted)
- Records who has used the free trial forever
- Tracks both Telegram ID AND username
- Prevents trial abuse even after account deletion

#### 2. **Temporary Active Accounts** (Auto-Deleted)
- Stores active subscriptions
- Automatically deleted after expiry
- Allows users to resubscribe without errors

### User Flow

**First-Time User:**
1. User enters username `shuffle123`
2. System checks trial history → Not found ✅
3. User gets 30-minute free trial
4. Trial expires → Account **deleted**
5. Trial history → **Kept forever**

**Returning User (After Expiry):**
1. User wants to subscribe again with `shuffle123`
2. Old account is deleted → No duplicate error ✅
3. Trial history exists → No free trial ❌
4. User must purchase → Can resubscribe successfully ✅

**Trial Abuse Attempt:**
1. User tries to claim trial again with different username
2. System checks trial history by Telegram ID → Found ❌
3. Trial denied → Must purchase subscription ✅

## 🧹 Running Cleanup

### Manual Cleanup
```bash
node scripts/cleanup-expired-accounts.js
```

**Example Output:**
```
🧹 Starting cleanup of expired accounts...
✅ Deleted 3 expired account(s):
   - thagoofy (expired at 2025-11-17T07:21:24.416Z)
   - starboy (expired at 2025-11-17T07:21:24.416Z)
   - monkey (expired at 2025-11-17T07:21:24.416Z)
🎉 Cleanup completed successfully!
```

### Automated Cleanup (Recommended)

Set up a cron job to run every 15 minutes:
```bash
*/15 * * * * cd /path/to/project && node scripts/cleanup-expired-accounts.js
```

## 📊 Current Pricing (Active in Database)

All 7 pricing plans are now live in your Firebase database:

| Plan | Price | Duration |
|------|-------|----------|
| 1 Day ❗️ | $10 | Perfect for Friday Stream |
| 1 Week 💵 | $18 | 7 days |
| 1 Month 💼 | $40 | 30 days |
| 3 Months 💎 | $100 | 90 days |
| 6 Months 💎 | $150 | 180 days |
| 1 Year 💎 | $250 | 365 days |
| Lifetime 💎 | $400 | Forever (100 years) |

## 🤖 Testing Your Bot

1. Open Telegram
2. Go to @ShuffleSubscriptionBot
3. Send `/start`
4. Click "➕ Add New Accounts"
5. Enter username(s)
6. You should now see all 7 pricing plans! ✅

## 📚 Full Documentation

- **Trial System Details**: See `docs/TRIAL_SYSTEM.md`
- **Project Overview**: See `replit.md`

## 🔧 Key Files Modified

1. `server/firebaseDb.js` - Added 3 new methods:
   - `createTrialHistory()` - Record trial usage
   - `hasUsedTrial()` - Check trial eligibility
   - `deleteExpiredShuffleAccounts()` - Cleanup expired accounts

2. `subscription-bot-v2.js` - Updated trial logic:
   - Checks `trialHistory` instead of active accounts
   - Creates permanent trial records
   - Allows resubscription after expiry

3. `scripts/cleanup-expired-accounts.js` - New cleanup script
   - Deletes expired accounts automatically
   - Can be run manually or scheduled

4. `scripts/seed-plans.js` - Updated pricing:
   - 1 Day: $10
   - 1 Week: $18
   - 1 Month: $40
   - 3 Months: $100
   - 6 Months: $150
   - 1 Year: $250
   - Lifetime: $400

## ✅ Everything Tested & Working

- ✅ Pricing plans seeded into Firebase
- ✅ Subscription bot restarted
- ✅ Trial history tracking implemented
- ✅ Expired account cleanup tested (deleted 3 old accounts)
- ✅ Documentation created
- ✅ All workflows running

## 🚀 Next Steps

1. **Test the bot** - Try adding accounts and viewing plans
2. **Set up automated cleanup** - Schedule the cleanup script
3. **Add Firebase indexes** (for performance):
   - Go to Firebase Console → Realtime Database → Rules
   - Add indexes for `trialHistory` (telegramUserId, username)

## ❓ Questions?

See `docs/TRIAL_SYSTEM.md` for complete technical documentation including:
- API methods
- Database structure
- Security notes
- Troubleshooting
- Future enhancements
