import axios from 'axios';
import crypto from 'crypto';

const OXAPAY_API_URL = 'https://api.oxapay.com';

export interface CreateInvoiceParams {
  amount: number;
  currency: string;
  orderId: string;
  description: string;
  callbackUrl: string;
  email?: string;
}

export interface OxaPayInvoiceResponse {
  result: number;
  message: string;
  trackId: string;
  payLink: string;
}

export class OxaPayService {
  private merchantApiKey: string;

  constructor() {
    this.merchantApiKey = process.env.OXAPAY_MERCHANT_API_KEY || '';
    
    if (!this.merchantApiKey) {
      throw new Error('OXAPAY_MERCHANT_API_KEY is required');
    }
  }

  async createInvoice(params: CreateInvoiceParams): Promise<OxaPayInvoiceResponse> {
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
    } catch (error: any) {
      console.error('OxaPay create invoice error:', error.response?.data || error.message);
      throw new Error(`Failed to create invoice: ${error.response?.data?.message || error.message}`);
    }
  }

  verifyWebhookSignature(payload: string, hmacHeader: string): boolean {
    const calculatedHmac = crypto
      .createHmac('sha512', this.merchantApiKey)
      .update(payload)
      .digest('hex');

    return calculatedHmac === hmacHeader;
  }
}

export const oxaPayService = new OxaPayService();
