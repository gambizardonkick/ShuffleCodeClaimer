const firebaseDB = require('../server/firebaseDb.js');
const { initializeFirebase } = require('../server/firebase.js');

async function cleanupExpiredAccounts() {
  try {
    initializeFirebase();
    console.log('🧹 Starting cleanup of expired accounts...');
    
    const result = await firebaseDB.deleteExpiredShuffleAccounts();
    
    if (result.deleted > 0) {
      console.log(`✅ Deleted ${result.deleted} expired account(s):`);
      result.accounts.forEach(account => {
        console.log(`   - ${account.username} (expired at ${account.expiryAt})`);
      });
    } else {
      console.log('✅ No expired accounts found.');
    }
    
    console.log('🎉 Cleanup completed successfully!');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    process.exit(1);
  }
}

cleanupExpiredAccounts();
