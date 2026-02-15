import crypto from 'crypto';
import { ethers } from 'ethers';

const AUTH_STATEMENT = 'Authentication only. No token transfer or approval.';
const SIWE_STATEMENT = 'Authenticate wallet ownership for SoulStarter. No token transfer or approval.';
const AUTH_TYPED_DOMAIN = {
  name: 'SoulStarter Authentication',
  version: '1'
};
const AUTH_TYPED_TYPES = {
  SoulStarterAuth: [
    { name: 'wallet', type: 'address' },
    { name: 'soul', type: 'string' },
    { name: 'action', type: 'string' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'statement', type: 'string' }
  ]
};
const SIWE_DOMAIN = String(process.env.SIWE_DOMAIN || 'soulstarter.vercel.app').trim();
const SIWE_URI = String(process.env.SIWE_URI || `https://${SIWE_DOMAIN}`).trim();
const SIWE_CHAIN_ID = Number(process.env.SIWE_CHAIN_ID || '8453');

export function setCors(res, origin) {
  const allowedOrigins = [
    'https://soulstarter.vercel.app',
    'https://soulstarter.io',
    'http://localhost:3000',
    'http://localhost:8080'
  ];

  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, PAYMENT-SIGNATURE, X-CLIENT-MODE, X-WALLET-ADDRESS, X-AUTH-SIGNATURE, X-AUTH-TIMESTAMP, X-PURCHASE-RECEIPT, X-REDOWNLOAD-SESSION, X-REDOWNLOAD-SIGNATURE, X-REDOWNLOAD-TIMESTAMP, X-REVIEWER, X-MODERATOR-ADDRESS, X-MODERATOR-SIGNATURE, X-MODERATOR-TIMESTAMP'
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PURCHASE-RECEIPT, X-REDOWNLOAD-SESSION'
  );
}

export function getSellerAddress() {
  const sellerAddress = process.env.SELLER_ADDRESS?.trim()?.replace(/\s/g, '');
  return sellerAddress || null;
}

export function buildAuthMessage({ wallet, soulId, action, timestamp }) {
  return [
    'SoulStarter Wallet Authentication',
    `address:${wallet.toLowerCase()}`,
    `soul:${soulId}`,
    `action:${action}`,
    `timestamp:${timestamp}`
  ].join('\n');
}

export function verifyWalletAuth({ wallet, soulId, action, timestamp, signature }) {
  if (!wallet || !signature || !timestamp) {
    return { ok: false, error: 'Missing wallet authentication headers' };
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return { ok: false, error: 'Invalid wallet address' };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, error: 'Invalid auth timestamp' };
  }

  const now = Date.now();
  const driftMs = 5 * 60 * 1000;
  if (Math.abs(now - ts) > driftMs) {
    return { ok: false, error: 'Authentication message expired' };
  }

  const allowLegacy = String(action || '').trim().toLowerCase() === 'redownload';

  const siweCandidates = buildSiweAuthMessageCandidates({ wallet, soulId, action, timestamp: ts });
  for (const candidate of siweCandidates) {
    try {
      const recovered = ethers.verifyMessage(candidate.message, signature);
      if (typeof recovered === 'string' && recovered.toLowerCase() === wallet.toLowerCase()) {
        return { ok: true, wallet: wallet.toLowerCase(), auth_format: 'siwe', matched_variant: candidate.variant };
      }
    } catch (_) {}
  }

  if (!allowLegacy) {
    return {
      ok: false,
      error: 'Signature does not match SIWE wallet authentication format'
    };
  }

  const candidates = buildAuthMessageCandidates({ wallet, soulId, action, timestamp: ts });
  const recoveredMatches = [];
  for (const candidate of candidates) {
    try {
      const recovered = ethers.verifyMessage(candidate.message, signature);
      if (typeof recovered === 'string' && recovered.toLowerCase() === wallet.toLowerCase()) {
        return { ok: true, wallet: wallet.toLowerCase(), auth_format: 'personal_sign' };
      }
      recoveredMatches.push({
        variant: candidate.variant,
        recovered: recovered || null
      });
    } catch (_) {
      recoveredMatches.push({
        variant: candidate.variant,
        recovered: null
      });
    }
  }

  return {
    ok: false,
    error: 'Signature does not match wallet address',
    auth_debug: {
      tried_variants: candidates.map((candidate) => candidate.variant),
      recovered: recoveredMatches
    }
  };
}

export function buildAuthTypedData({ wallet, soulId, action, timestamp }) {
  const checksummed = ethers.getAddress(String(wallet || '').trim());
  return {
    domain: AUTH_TYPED_DOMAIN,
    types: AUTH_TYPED_TYPES,
    primaryType: 'SoulStarterAuth',
    message: {
      wallet: checksummed,
      soul: String(soulId || ''),
      action: String(action || ''),
      timestamp: Number(timestamp),
      statement: AUTH_STATEMENT
    }
  };
}

function buildSiweAuthMessageCandidates({ wallet, soulId, action, timestamp }) {
  const rawWallet = String(wallet || '').trim();
  const walletLower = rawWallet.toLowerCase();
  const checksummed = safeChecksumAddress(rawWallet);
  const walletVariants = [walletLower, checksummed].filter(Boolean);
  const uniqueWallets = [...new Set(walletVariants)];
  return uniqueWallets.map((walletVariant) => ({
    variant: walletVariant === walletLower ? 'siwe-lowercase' : 'siwe-checksummed',
    message: buildSiweAuthMessage({ wallet: walletVariant, soulId, action, timestamp })
  }));
}

function buildSiweNonce({ soulId, action, timestamp }) {
  const seed = `${String(soulId || '*')}|${String(action || '')}|${String(timestamp || '')}`;
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

export function buildSiweAuthMessage({ wallet, soulId, action, timestamp }) {
  const address = String(wallet || '').trim().toLowerCase();
  const ts = Number(timestamp);
  const issuedAt = new Date(ts).toISOString();
  const expiresAt = new Date(ts + 5 * 60 * 1000).toISOString();
  const nonce = buildSiweNonce({ soulId, action, timestamp: ts });
  const requestId = `${String(action || 'auth').trim()}:${String(soulId || '*').trim()}`;
  return [
    `${SIWE_DOMAIN} wants you to sign in with your Ethereum account:`,
    address,
    '',
    SIWE_STATEMENT,
    '',
    `URI: ${SIWE_URI}`,
    'Version: 1',
    `Chain ID: ${Number.isFinite(SIWE_CHAIN_ID) ? SIWE_CHAIN_ID : 8453}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
    `Request ID: ${requestId}`,
    'Resources:',
    `- urn:soulstarter:action:${String(action || '').trim()}`,
    `- urn:soulstarter:soul:${String(soulId || '*').trim()}`
  ].join('\n');
}

function buildAuthMessageCandidates({ wallet, soulId, action, timestamp }) {
  const rawWallet = String(wallet || '').trim();
  const walletLower = rawWallet.toLowerCase();
  const checksummed = safeChecksumAddress(rawWallet);
  const walletVariants = [walletLower, checksummed].filter(Boolean);
  const uniqueWallets = [...new Set(walletVariants)];
  const newlineVariants = ['\n', '\r\n'];
  const candidates = [];

  for (const walletVariant of uniqueWallets) {
    for (const newline of newlineVariants) {
      const message = buildAuthMessageWithNewline({
        wallet: walletVariant,
        soulId,
        action,
        timestamp,
        newline
      });
      candidates.push({
        variant: `${walletVariant === walletLower ? 'lowercase' : 'checksummed'}-${newline === '\n' ? 'lf' : 'crlf'}`,
        message
      });
    }
  }

  return candidates;
}

function buildAuthMessageWithNewline({ wallet, soulId, action, timestamp, newline }) {
  return [
    'SoulStarter Wallet Authentication',
    `address:${wallet}`,
    `soul:${soulId}`,
    `action:${action}`,
    `timestamp:${timestamp}`
  ].join(newline);
}

function safeChecksumAddress(address) {
  try {
    return ethers.getAddress(address);
  } catch (_) {
    return null;
  }
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLen), 'base64').toString('utf8');
}

function receiptSecrets() {
  const primary = process.env.PURCHASE_RECEIPT_SECRET?.trim();
  const legacy = String(process.env.PURCHASE_RECEIPT_SECRET_PREVIOUS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const merged = [primary, ...legacy].filter(Boolean);
  return [...new Set(merged)];
}

function receiptSecret() {
  const [primary] = receiptSecrets();
  return primary || null;
}

function sessionSecret() {
  return receiptSecret();
}

function redownloadSessionTtlSeconds() {
  const parsed = Number(process.env.REDOWNLOAD_SESSION_TTL_SECONDS || '43200');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 43200;
}

function purchaseReceiptTtlSeconds() {
  const parsed = Number(process.env.PURCHASE_RECEIPT_COOKIE_TTL_SECONDS || '31536000');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 31536000;
}

export function createPurchaseReceipt({ wallet, soulId, transaction }) {
  const secret = receiptSecret();
  if (!secret) {
    throw new Error('Server configuration error: PURCHASE_RECEIPT_SECRET is required');
  }

  const payload = JSON.stringify({
    wallet: wallet.toLowerCase(),
    soulId,
    transaction,
    iat: Date.now()
  });
  const payloadB64 = base64UrlEncode(payload);
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64');
  const sigB64 = sig.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${payloadB64}.${sigB64}`;
}

export function verifyPurchaseReceipt({ receipt, wallet, soulId }) {
  const secrets = receiptSecrets();
  if (secrets.length === 0) {
    return { ok: false, error: 'Server configuration error: PURCHASE_RECEIPT_SECRET is required' };
  }

  if (!receipt || typeof receipt !== 'string' || !receipt.includes('.')) {
    return { ok: false, error: 'Missing purchase receipt' };
  }

  const [payloadB64, sigB64] = receipt.split('.');
  const signatureMatches = secrets.some((secret) => {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(payloadB64)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    return sigB64 === expected;
  });
  if (!signatureMatches) {
    return { ok: false, error: 'Invalid purchase receipt signature' };
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch (_) {
    return { ok: false, error: 'Invalid purchase receipt payload' };
  }

  if (payload.wallet !== wallet.toLowerCase()) {
    return { ok: false, error: 'Purchase receipt wallet mismatch' };
  }
  if (payload.soulId !== soulId) {
    return { ok: false, error: 'Purchase receipt soul mismatch' };
  }

  return { ok: true, transaction: payload.transaction || null };
}

export function createRedownloadSessionToken({ wallet }) {
  const secret = sessionSecret();
  if (!secret) throw new Error('Server configuration error: PURCHASE_RECEIPT_SECRET is required');
  const now = Date.now();
  const ttlMs = redownloadSessionTtlSeconds() * 1000;
  const payload = JSON.stringify({
    wallet: String(wallet || '').toLowerCase(),
    iat: now,
    exp: now + ttlMs
  });
  const payloadB64 = base64UrlEncode(payload);
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64');
  const sigB64 = sig.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${payloadB64}.${sigB64}`;
}

export function verifyRedownloadSessionToken({ token, wallet }) {
  const secrets = receiptSecrets();
  if (secrets.length === 0) return { ok: false, error: 'Server configuration error: PURCHASE_RECEIPT_SECRET is required' };
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, error: 'Missing re-download session token' };
  }
  const [payloadB64, sigB64] = token.split('.');
  const signatureMatches = secrets.some((secret) => {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(payloadB64)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    return sigB64 === expected;
  });
  if (!signatureMatches) return { ok: false, error: 'Invalid re-download session signature' };

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadB64));
  } catch (_) {
    return { ok: false, error: 'Invalid re-download session payload' };
  }
  if (String(payload.wallet || '').toLowerCase() !== String(wallet || '').toLowerCase()) {
    return { ok: false, error: 'Re-download session wallet mismatch' };
  }
  if (!Number.isFinite(Number(payload.exp)) || Date.now() > Number(payload.exp)) {
    return { ok: false, error: 'Re-download session expired' };
  }
  return { ok: true, exp: Number(payload.exp) };
}

export function parseCookieHeader(cookieHeader) {
  const parsed = {};
  const raw = String(cookieHeader || '');
  if (!raw) return parsed;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (!k) continue;
    parsed[k] = decodeURIComponent(rest.join('=') || '');
  }
  return parsed;
}

export function buildRedownloadSessionSetCookie({ token, reqHost }) {
  const ttl = redownloadSessionTtlSeconds();
  const host = String(reqHost || '').toLowerCase();
  const secure = host.includes('localhost') ? '' : '; Secure';
  return `soulstarter_redownload_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}${secure}`;
}

export function purchaseReceiptCookieName(soulId) {
  const safeSoulId = String(soulId || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  return `soulstarter_receipt_${safeSoulId || 'unknown'}`;
}

export function buildPurchaseReceiptSetCookie({ soulId, receipt, reqHost }) {
  const ttl = purchaseReceiptTtlSeconds();
  const host = String(reqHost || '').toLowerCase();
  const secure = host.includes('localhost') ? '' : '; Secure';
  const name = purchaseReceiptCookieName(soulId);
  return `${name}=${encodeURIComponent(String(receipt || ''))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}${secure}`;
}
