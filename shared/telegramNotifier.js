const https = require('https');

class TelegramNotifier {
  constructor(botToken) {
    this.botToken = botToken;
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  async sendMessage(chatId, text, options = {}) {
    return this._makeRequest('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: options.parse_mode || 'Markdown',
      ...options
    });
  }

  async editMessageText(chatId, messageId, text, options = {}) {
    return this._makeRequest('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: options.parse_mode || 'Markdown',
      ...options
    });
  }

  async notifyPaymentConfirmed(chatId, messageId, subscriptionDetails) {
    const messageText = 
      `✅ *Payment Confirmed!*\n\n` +
      `Your subscription is now *active*!\n\n` +
      `📋 *Details:*\n` +
      `Plan: ${subscriptionDetails.planName}\n` +
      `Accounts: ${subscriptionDetails.accountCount}\n` +
      `Expires: ${subscriptionDetails.expiryDate}\n\n` +
      `🎰 *Your accounts are now connected and will auto-claim codes!*\n\n` +
      `Active accounts:\n` +
      subscriptionDetails.usernames.map((u, i) => `  ${i + 1}. ${u}`).join('\n');

    try {
      // Try to edit the existing payment message
      if (messageId) {
        await this.editMessageText(chatId, messageId, messageText);
        console.log(`✅ Updated payment message for chat ${chatId}`);
      } else {
        // Fallback to new message if no messageId
        await this.sendMessage(chatId, messageText);
        console.log(`✅ Sent new confirmation message to chat ${chatId}`);
      }
      return true;
    } catch (error) {
      console.error('Error updating payment message:', error.message);
      // Fallback to new message if edit fails
      try {
        await this.sendMessage(chatId, messageText);
        console.log(`✅ Sent fallback confirmation message to chat ${chatId}`);
        return true;
      } catch (fallbackError) {
        console.error('Error sending fallback message:', fallbackError.message);
        return false;
      }
    }
  }

  _makeRequest(method, data) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(data);
      
      const options = {
        hostname: 'api.telegram.org',
        path: `/bot${this.botToken}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let responseData = '';

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          try {
            const response = JSON.parse(responseData);
            if (response.ok) {
              resolve(response.result);
            } else {
              reject(new Error(response.description || 'Telegram API error'));
            }
          } catch (e) {
            reject(new Error('Failed to parse Telegram response'));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.write(postData);
      req.end();
    });
  }
}

module.exports = { TelegramNotifier };
