import {
  buildRedownloadSessionSetCookie,
  createRedownloadSessionToken,
  setCors,
  verifyRedownloadSessionToken,
  verifyWalletAuth
} from '../_lib/payments.js';

const DEFAULT_TTL_SECONDS = Number(process.env.REDOWNLOAD_SESSION_TTL_SECONDS || '43200');
const SESSION_TTL_SECONDS = Number.isFinite(DEFAULT_TTL_SECONDS) && DEFAULT_TTL_SECONDS > 0 ? DEFAULT_TTL_SECONDS : 43200;

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const wallet = String(req.headers['x-wallet-address'] || '').trim();
  const signature = String(req.headers['x-auth-signature'] || '').trim();
  const timestamp = req.headers['x-auth-timestamp'];

  const auth = verifyWalletAuth({
    wallet,
    soulId: '*',
    action: 'session',
    timestamp,
    signature
  });

  if (!auth.ok) {
    return res.status(401).json({ error: auth.error, auth_debug: auth.auth_debug || null });
  }

  let token;
  try {
    token = createRedownloadSessionToken({ wallet: auth.wallet });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to create session token' });
  }

  const checked = verifyRedownloadSessionToken({ token, wallet: auth.wallet });
  if (!checked.ok) {
    return res.status(500).json({ error: checked.error || 'Failed to verify session token' });
  }

  const expiresAtMs = Number(checked.exp || Date.now() + SESSION_TTL_SECONDS * 1000);
  res.setHeader('Set-Cookie', buildRedownloadSessionSetCookie({ token, reqHost: req.headers.host }));
  res.setHeader('X-REDOWNLOAD-SESSION', token);
  return res.status(200).json({
    ok: true,
    wallet: auth.wallet,
    token,
    expires_at_ms: expiresAtMs,
    ttl_seconds: SESSION_TTL_SECONDS
  });
}
