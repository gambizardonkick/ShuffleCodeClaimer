const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");

console.log('==============================================');
console.log('   Telegram Login - Session Generator');
console.log('==============================================');
console.log('');
console.log('This script will help you log in to Telegram');
console.log('and generate a session string.');
console.log('');

async function main() {
  // Get credentials
  const apiIdInput = await input.text("Enter your API ID: ");
  const apiHashInput = await input.text("Enter your API Hash: ");
  
  const apiId = parseInt(apiIdInput);
  const apiHash = apiHashInput.trim();

  if (!apiId || !apiHash) {
    console.error('ERROR: Invalid API credentials');
    process.exit(1);
  }

  const stringSession = new StringSession("");

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  try {
    console.log('');
    console.log('Connecting to Telegram...');
    
    await client.start({
      phoneNumber: async () => await input.text("Enter your phone number (with country code, e.g., +1234567890): "),
      password: async () => await input.text("Enter your 2FA password (if you have one, otherwise press Enter): "),
      phoneCode: async () => await input.text("Enter the code Telegram sent you: "),
      onError: (err) => console.error('Authentication error:', err),
    });

    console.log('');
    console.log('==============================================');
    console.log('✓ Successfully logged in!');
    console.log('==============================================');
    console.log('');

    const session = client.session.save();
    
    console.log('IMPORTANT: Copy these values to your Replit Secrets:');
    console.log('');
    console.log('TELEGRAM_API_ID=' + apiId);
    console.log('TELEGRAM_API_HASH=' + apiHash);
    console.log('TELEGRAM_SESSION=' + session);
    console.log('');
    console.log('After saving these secrets, you can run the main client!');
    console.log('');

    await client.disconnect();
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
