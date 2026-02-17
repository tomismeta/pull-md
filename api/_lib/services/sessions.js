import {
  buildRedownloadSessionSetCookie,
  createRedownloadSessionToken,
  verifyRedownloadSessionToken,
  verifyWalletAuth
} from '../payments.js';
import { AppError } from '../errors.js';

const DEFAULT_TTL_SECONDS = Number(process.env.REDOWNLOAD_SESSION_TTL_SECONDS || '43200');
const SESSION_TTL_SECONDS = Number.isFinite(DEFAULT_TTL_SECONDS) && DEFAULT_TTL_SECONDS > 0 ? DEFAULT_TTL_SECONDS : 43200;

function isStrictAgentMode(clientMode) {
  const normalized = String(clientMode || '')
    .trim()
    .toLowerCase();
  return normalized === 'agent' || normalized === 'headless-agent' || normalized === 'strict-agent';
}

export async function createBrowserRedownloadSession({
  wallet,
  signature,
  timestamp,
  clientMode,
  reqHost
}) {
  if (isStrictAgentMode(clientMode)) {
    throw new AppError(410, {
      error: 'Session API is deprecated for strict agent mode',
      code: 'session_api_not_for_agents',
      flow_hint:
        'Headless agents should use strict re-download: X-CLIENT-MODE: agent + X-WALLET-ADDRESS + X-PURCHASE-RECEIPT + X-REDOWNLOAD-SIGNATURE + X-REDOWNLOAD-TIMESTAMP.',
      required_headers: ['X-CLIENT-MODE', 'X-WALLET-ADDRESS', 'X-PURCHASE-RECEIPT', 'X-REDOWNLOAD-SIGNATURE', 'X-REDOWNLOAD-TIMESTAMP']
    });
  }

  const auth = await verifyWalletAuth({
    wallet,
    soulId: '*',
    action: 'session',
    timestamp,
    signature
  });

  if (!auth.ok) {
    throw new AppError(401, { error: auth.error, auth_debug: auth.auth_debug || null });
  }

  let token;
  try {
    token = createRedownloadSessionToken({ wallet: auth.wallet });
  } catch (error) {
    throw new AppError(500, { error: error?.message || 'Failed to create session token' }, { cause: error });
  }

  const checked = verifyRedownloadSessionToken({ token, wallet: auth.wallet });
  if (!checked.ok) {
    throw new AppError(500, { error: checked.error || 'Failed to verify session token' });
  }

  const expiresAtMs = Number(checked.exp || Date.now() + SESSION_TTL_SECONDS * 1000);
  return {
    token,
    setCookie: buildRedownloadSessionSetCookie({ token, reqHost }),
    payload: {
      ok: true,
      wallet: auth.wallet,
      token,
      expires_at_ms: expiresAtMs,
      ttl_seconds: SESSION_TTL_SECONDS
    }
  };
}

