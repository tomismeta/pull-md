import { getSoul, soulIds } from '../../_lib/catalog.js';
import { setCors, verifyPurchaseReceipt } from '../../_lib/payments.js';

export default function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const payload = req.body || {};

  const walletAddress = String(payload.wallet_address || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Invalid or missing wallet_address' });
  }

  const proofs = Array.isArray(payload.proofs) ? payload.proofs : [];
  if (proofs.length === 0) {
    return res.status(400).json({
      error: 'Missing proofs',
      message: 'Provide proofs: [{ soul_id, receipt }]'
    });
  }

  const results = proofs.map((proof) => {
    const soulId = String(proof?.soul_id || '');
    const receipt = String(proof?.receipt || '');

    if (!getSoul(soulId)) {
      return {
        soul_id: soulId,
        entitled: false,
        reason: 'Unknown soul',
        available_souls: soulIds()
      };
    }

    const check = verifyPurchaseReceipt({
      receipt,
      wallet: walletAddress,
      soulId
    });

    return {
      soul_id: soulId,
      entitled: check.ok,
      reason: check.ok ? null : check.error,
      transaction: check.transaction || null
    };
  });

  return res.status(200).json({
    wallet_address: walletAddress,
    entitlements: results,
    total_entitled: results.filter((item) => item.entitled).length
  });
}
