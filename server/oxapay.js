const axios = require('axios');
const crypto = require('crypto');

const OXAPAY_API_URL = 'https://api.oxapay.com';

class OxaPayService {
  constructor() {
    this.merchantApiKey = process.env.OXAPAY_MERCHANT_API_KEY || '';
    
    if (!this.merchantApiKey) {
      console.warn('⚠️  OXAPAY_MERCHANT_API_KEY not set');
    }
  }

  async createInvoice(params) {
    try {
      const response = await axios.post(`${OXAPAY_API_URL}/merchants/request`, {
        merchant: this.merchantApiKey,
        amount: params.amount,
        currency: params.currency,
        lifeTime: 30, // 30 minutes
        feePaidByPayer: 0, // merchant pays fee
        underPaidCover: 2.5, // accept up to 2.5% underpayment
        callbackUrl: params.callbackUrl,
        description: params.description,
        orderId: params.orderId,
        email: params.email,
      });

      return response.data;
    } catch (error) {
      console.error('OxaPay create invoice error:', error.response?.data || error.message);
      throw new Error(`Failed to create invoice: ${error.response?.data?.message || error.message}`);
    }
  }

  verifyWebhookSignature(payload, hmacHeader) {
    const calculatedHmac = crypto
      .createHmac('sha512', this.merchantApiKey)
      .update(payload)
      .digest('hex');

    return calculatedHmac === hmacHeader;
  }
}

const oxaPayService = new OxaPayService();

module.exports = { oxaPayService, OxaPayService };
