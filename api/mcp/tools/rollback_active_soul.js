import { createSoulSessionToken, setCors, verifySoulSessionToken } from '../../_lib/payments.js';
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

  const tokenCheck = verifySoulSessionToken({
    token: String(payload.soul_session_token || ''),
    wallet
  });
  if (!tokenCheck.ok) {
    return res.status(401).json({ error: tokenCheck.error });
  }
  if (!tokenCheck.previousSoulId) {
    return res.status(400).json({ error: 'No previous_soul_id available in soul session token' });
  }

  const ownership = verifySoulOwnership({
    wallet,
    soulId: tokenCheck.previousSoulId,
    receipt: payload.rollback_receipt
  });
  if (!ownership.ok) {
    return res.status(401).json({ error: ownership.error });
  }

  const nextToken = createSoulSessionToken({
    wallet,
    soulId: ownership.soul.id,
    previousSoulId: tokenCheck.soulId
  });

  return res.status(200).json({
    wallet_address: wallet,
    active_soul: buildSoulSummary(ownership.soul, ownership.transaction),
    previous_soul_id: tokenCheck.soulId,
    soul_session_token: nextToken,
    switched_at: Date.now(),
    redownload_contract: buildRedownloadContract({
      wallet,
      soulId: ownership.soul.id
    })
  });
}
