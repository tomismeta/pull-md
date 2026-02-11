import { getSoul, soulIds } from '../../_lib/catalog.js';
import { getSellerAddress, setCors } from '../../_lib/payments.js';
import { createRequestContext, getX402HTTPServer } from '../../_lib/x402.js';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { soul_id: soulId, wallet_address: walletAddress } = req.body || {};

  if (!soulId) {
    return res.status(400).json({ error: 'Missing required parameter: soul_id' });
  }

  if (!walletAddress) {
    return res.status(400).json({ error: 'Missing required parameter: wallet_address' });
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: 'Invalid wallet address format' });
  }

  const soul = getSoul(soulId);
  if (!soul) {
    return res.status(404).json({ error: 'Soul not found', available_souls: soulIds() });
  }

  const sellerAddress = getSellerAddress();
  if (!sellerAddress) {
    return res.status(500).json({ error: 'Server configuration error: SELLER_ADDRESS is required' });
  }

  try {
    const httpServer = await getX402HTTPServer({ soulId, soul, sellerAddress });
    const syntheticReq = {
      method: 'GET',
      url: `/api/souls/${soulId}/download`,
      headers: {
        host: req.headers.host || 'soulstarter.vercel.app',
        accept: 'application/json',
        'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https'
      }
    };
    const result = await httpServer.processHTTPRequest(createRequestContext(syntheticReq));
    if (result.type !== 'payment-error') {
      return res.status(500).json({ error: 'Failed to generate x402 requirements' });
    }

    for (const [key, value] of Object.entries(result.response.headers || {})) {
      if (value != null) {
        res.setHeader(key, value);
      }
    }

    const body = result.response.body && typeof result.response.body === 'object' ? result.response.body : {};
    return res.status(402).json({
      ...body,
      wallet_address: walletAddress,
      payment: {
        amount: soul.priceDisplay,
        currency: 'USDC',
        network: 'Base',
        recipient: sellerAddress
      },
      instructions: {
        step_1: 'Decode PAYMENT-REQUIRED (base64 JSON) and use accepts[0] values for EIP-712 signing',
        step_2: 'Create x402 payment payload JSON and base64-encode it',
        step_3: 'Retry GET /api/souls/{soul_id}/download with header PAYMENT-SIGNATURE (or PAYMENT/X-PAYMENT)',
        step_4: 'On success, store X-PURCHASE-RECEIPT for future re-downloads'
      },
      header_format: {
        preferred: 'PAYMENT-SIGNATURE: <base64(JSON x402 payload)>',
        accepted_alternatives: ['PAYMENT: <base64(JSON x402 payload)>', 'X-PAYMENT: <base64(JSON x402 payload)>']
      },
      wallet_examples: {
        standard_wallet: 'Sign TransferWithAuthorization typed data from PAYMENT-REQUIRED.accepts[0], then send payload in PAYMENT-SIGNATURE.',
        bankr_wallet: 'Use Bankr x402 exact EVM signer output and submit resulting base64 JSON in PAYMENT-SIGNATURE (or PAYMENT).'
      }
    });
  } catch (error) {
    console.error('Failed to generate purchase requirements:', error);
    return res.status(500).json({ error: 'Failed to generate x402 payment requirements' });
  }
}
