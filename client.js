const { TelegramClient, Button } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const input = require("input");

// Get credentials from environment variables
const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
let sessionString = process.env.TELEGRAM_SESSION || process.env.TELEGRAM_SESSION_STRING || "";

// Validate session string - if it's not a valid base64 string or empty, reset it
if (sessionString && sessionString.length > 0) {
  // Check if it looks like a valid session (should be long and contain only valid base64 chars)
  const isValidSession = /^[A-Za-z0-9+/=]+$/.test(sessionString) && sessionString.length > 100;
  if (!isValidSession) {
    console.log('Invalid session string detected, starting fresh login...');
    sessionString = "";
  }
}

// Source groups (without @)
const SOURCE_GROUPS = [
  'shuffle',
  'shufflevip',
  'shuffleboost',
  'shufflesports',
  'shufflecodebottest'
];

// Target channel (with @)
const TARGET_CHANNEL = '@shufflecodesdrops';

console.log('Telegram User Client Starting...');
console.log('Source groups:', SOURCE_GROUPS);
console.log('Target channel:', TARGET_CHANNEL);
console.log('');

if (!apiId || !apiHash) {
  console.error('ERROR: Missing API credentials!');
  console.error('Please set TELEGRAM_API_ID and TELEGRAM_API_HASH environment variables');
  console.error('Get them from https://my.telegram.org');
  process.exit(1);
}

const stringSession = new StringSession(sessionString);

const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5,
});

async function main() {
  try {
    console.log('Connecting to Telegram...');
    
    if (!sessionString || sessionString.length < 100) {
      console.error('');
      console.error('ERROR: No valid session found!');
      console.error('');
      console.error('You need to generate a session string first.');
      console.error('');
      console.error('STEPS:');
      console.error('1. Stop this workflow');
      console.error('2. In the Shell tab, run: node login.js');
      console.error('3. Follow the prompts to log in');
      console.error('4. Copy the TELEGRAM_SESSION value to your Secrets');
      console.error('5. Restart this workflow');
      console.error('');
      process.exit(1);
    }

    await client.connect();

    console.log('');
    console.log('================================================');
    console.log('✓ Successfully connected to Telegram!');
    console.log('================================================');
    console.log('');

    // Get channel entity
    console.log(`Getting channel entity for ${TARGET_CHANNEL}...`);
    const targetChannel = await client.getEntity(TARGET_CHANNEL);
    console.log(`✓ Found target channel: ${targetChannel.title || TARGET_CHANNEL}`);
    console.log('');

    // Get source group entities
    console.log('Checking source groups...');
    const sourceEntities = [];
    for (const groupUsername of SOURCE_GROUPS) {
      try {
        const entity = await client.getEntity(groupUsername);
        sourceEntities.push(entity);
        console.log(`✓ Found group: ${entity.title || groupUsername}`);
      } catch (error) {
        console.error(`✗ Could not find group: ${groupUsername}`);
        console.error(`  Make sure you're a member of this group or it's a public group`);
      }
    }
    console.log('');

    if (sourceEntities.length === 0) {
      console.error('ERROR: No source groups found!');
      console.error('Make sure you are a member of at least one source group');
      process.exit(1);
    }

    console.log('================================================');
    console.log('✓ Client is ready and listening for messages!');
    console.log(`  Monitoring ${sourceEntities.length} groups`);
    console.log(`  Forwarding to: ${TARGET_CHANNEL}`);
    console.log('================================================');
    console.log('');

    // Listen for new messages
    client.addEventHandler(async (event) => {
      try {
        const message = event.message;
        const chat = await event.message.getChat();
        
        // Check if message is from one of our source groups
        const isSourceGroup = sourceEntities.some(entity => entity.id.toString() === chat.id.toString());
        
        if (isSourceGroup) {
          const groupName = chat.title || chat.username || 'Unknown';
          const messageText = message.message || '';
          console.log(`📩 New message from: ${groupName}`);
          console.log(`📝 Message content: "${messageText}"`);
          
          try {
            // Try sending with button first
            try {
              const sendOptions = {
                message: messageText,
                buttons: [
                  [Button.url('🤖 Buy Automatic Code Claimer Bot', 'https://t.me/ShuffleSubscriptionBot')]
                ]
              };
              
              // Only include file if media exists
              if (message.media) {
                sendOptions.file = message.media;
              }
              
              await client.sendMessage(targetChannel, sendOptions);
              console.log(`✓ Sent to ${TARGET_CHANNEL} (with button)`);
            } catch (buttonError) {
              console.log(`⚠️ Button failed (${buttonError.message}), sending without button...`);
              
              // Fallback: send without button but add promotional text
              const promotionalText = messageText + '\n\n🤖 Buy Automatic Code Claimer Bot: @ShuffleSubscriptionBot';
              const fallbackOptions = {
                message: promotionalText
              };
              
              if (message.media) {
                fallbackOptions.file = message.media;
              }
              
              await client.sendMessage(targetChannel, fallbackOptions);
              console.log(`✓ Sent to ${TARGET_CHANNEL} (text-only with promo)`);
            }
            
            // Send to dashboard API for code detection
            try {
              const fetch = (await import('node-fetch')).default;
              await fetch('http://localhost:5000/api/telegram-message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: message.message || '' })
              });
            } catch (apiErr) {
              // Dashboard might not be running, that's ok
            }
          } catch (error) {
            console.error(`✗ Failed to send: ${error.message}`);
            if (error.message.includes('CHAT_WRITE_FORBIDDEN')) {
              console.error('  Make sure you have permission to post in the target channel');
            }
          }
        }
      } catch (error) {
        console.error('Error handling message:', error.message);
      }
    }, new NewMessage({}));

    // Keep the client running
    console.log('Client is running. Press Ctrl+C to stop.');
    
  } catch (error) {
    console.error('Fatal error:', error.message);
    console.error('');
    if (error.message.includes('API_ID_INVALID')) {
      console.error('Your API_ID or API_HASH is invalid.');
      console.error('Get valid credentials from https://my.telegram.org');
    } else if (error.message.includes('PHONE_NUMBER_INVALID')) {
      console.error('The phone number you entered is invalid.');
      console.error('Make sure to include country code (e.g., +1234567890)');
    }
    process.exit(1);
  }
}

main().catch(console.error);
