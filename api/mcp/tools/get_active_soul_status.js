import { getSoul } from '../../_lib/catalog.js';
import { setCors, verifySoulSessionToken } from '../../_lib/payments.js';
import { buildRedownloadContract, buildSoulSummary, validateWalletAddress } from '../_lib/soul_switching.js';

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

  const soul = getSoul(tokenCheck.soulId);
  if (!soul) {
    return res.status(404).json({ error: 'Active soul not found in catalog' });
  }

  const previousSoul = tokenCheck.previousSoulId ? getSoul(tokenCheck.previousSoulId) : null;

  return res.status(200).json({
    wallet_address: wallet,
    active_soul: buildSoulSummary(soul, null),
    previous_soul: previousSoul ? buildSoulSummary(previousSoul, null) : null,
    switched_at: tokenCheck.iat || null,
    redownload_contract: buildRedownloadContract({
      wallet,
      soulId: soul.id
    })
  });
}
