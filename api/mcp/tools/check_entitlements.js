import { isAppError } from '../../_lib/errors.js';
import { setCors } from '../../_lib/payments.js';
import { checkReceiptEntitlements } from '../../_lib/services/souls.js';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const payload = req.body || {};
    const response = await checkReceiptEntitlements({
      walletAddress: payload.wallet_address,
      proofs: payload.proofs
    });
    return res.status(200).json(response);
  } catch (error) {
    if (isAppError(error)) {
      return res.status(error.status).json(error.payload);
    }
    return res.status(500).json({ error: 'Unable to verify entitlements' });
  }
}
