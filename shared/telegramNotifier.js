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

  async deleteMessage(chatId, messageId) {
    try {
      return await this._makeRequest('deleteMessage', {
        chat_id: chatId,
        message_id: messageId
      });
    } catch (error) {
      console.error('Error deleting message:', error.message);
      return false;
    }
  }

  async notifyPaymentConfirmed(chatId, messageId, subscriptionDetails) {
    const expiryDate = new Date(subscriptionDetails.expiryDate);
    
    const dateStr = expiryDate.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    
    const timeStr = expiryDate.toISOString().substring(11, 19);
    
    const messageText = 
      `🎉 *CONGRATULATIONS!*\n\n` +
      `Your payment has been confirmed!\n\n` +
      `✅ Your accounts are now *ACTIVE* and will auto-claim codes:\n` +
      subscriptionDetails.usernames.map((u, i) => `  ${i + 1}. ${u}`).join('\n') + `\n\n` +
      `📋 *Plan:* ${subscriptionDetails.planName}\n\n` +
      `⏰ *Subscription expires:*\n` +
      `📅 ${dateStr}\n` +
      `🕐 ${timeStr} UTC\n\n` +
      `🚀 Start using it now - codes will auto-claim automatically!`;

    const inlineKeyboard = {
      inline_keyboard: [
        [{ text: '🎯 Setup Your Bot Now', url: 'https://shufflecodeclaimer.onrender.com/#guide' }]
      ]
    };

    try {
      // Send new message with inline keyboard button
      await this._makeRequest('sendMessage', {
        chat_id: chatId,
        text: messageText,
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard
      });
      console.log(`✅ Sent confirmation message with setup button to chat ${chatId}`);
      return true;
    } catch (error) {
      console.error('Error sending confirmation message:', error.message);
      // Fallback without button
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
