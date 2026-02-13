import { createSoulSessionToken, setCors } from '../../_lib/payments.js';
import {
  buildRedownloadContract,
  buildSoulSummary,
  validateWalletAddress,
  verifySoulOwnership
} from '../_lib/soul_switching.js';

export default function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const payload = req.body || {};
  const walletCheck = validateWalletAddress(payload.wallet_address);
  if (!walletCheck.ok) {
    return res.status(400).json({ error: walletCheck.error });
  }
  const wallet = walletCheck.wallet;

  const soulId = String(payload.soul_id || '');
  const ownership = verifySoulOwnership({
    wallet,
    soulId,
    receipt: payload.receipt
  });
  if (!ownership.ok) {
    return res.status(401).json({ error: ownership.error });
  }

  const previousSoulId = String(payload.previous_soul_id || '').trim() || null;
  let previous = null;
  if (previousSoulId) {
    const previousOwnership = verifySoulOwnership({
      wallet,
      soulId: previousSoulId,
      receipt: payload.previous_receipt
    });
    if (!previousOwnership.ok) {
      return res.status(401).json({ error: `Previous soul verification failed: ${previousOwnership.error}` });
    }
    previous = buildSoulSummary(previousOwnership.soul, previousOwnership.transaction);
  }

  const soulSessionToken = createSoulSessionToken({
    wallet,
    soulId: ownership.soul.id,
    previousSoulId: previous?.soul_id || null
  });

  return res.status(200).json({
    wallet_address: wallet,
    active_soul: buildSoulSummary(ownership.soul, ownership.transaction),
    previous_soul: previous,
    soul_session_token: soulSessionToken,
    switched_at: Date.now(),
    redownload_contract: buildRedownloadContract({
      wallet,
      soulId: ownership.soul.id
    })
  });
}
