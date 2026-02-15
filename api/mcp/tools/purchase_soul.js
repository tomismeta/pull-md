import { setCors } from '../../_lib/payments.js';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  return res.status(410).json({
    error: 'Deprecated endpoint',
    code: 'purchase_soul_deprecated',
    flow_hint:
      'Use canonical purchase flow on GET /api/souls/{id}/download with X-CLIENT-MODE: agent. First call returns 402 + PAYMENT-REQUIRED; retry same endpoint with PAYMENT-SIGNATURE.',
    canonical_purchase_flow: {
      endpoint: '/api/souls/{id}/download',
      method: 'GET',
      required_headers: ['X-CLIENT-MODE: agent', 'PAYMENT-SIGNATURE'],
      first_step: 'GET without payment header to obtain PAYMENT-REQUIRED',
      second_step: 'GET with PAYMENT-SIGNATURE (base64 JSON x402 payload) to settle and download',
      redownload:
        'GET with X-CLIENT-MODE: agent + X-WALLET-ADDRESS + X-PURCHASE-RECEIPT + X-REDOWNLOAD-SIGNATURE + X-REDOWNLOAD-TIMESTAMP'
    }
  });
}
