import crypto from 'crypto';
import { ethers } from 'ethers';

const SIWE_STATEMENT = 'Authenticate wallet ownership for SoulStarter. No token transfer or approval.';
const SIWE_DOMAIN = String(process.env.SIWE_DOMAIN || 'soulstarter.vercel.app').trim();
const SIWE_URI = String(process.env.SIWE_URI || `https://${SIWE_DOMAIN}`).trim();
const SIWE_CHAIN_ID = Number(process.env.SIWE_CHAIN_ID || '8453');
const EIP1271_MAGIC_VALUE = '0x1626ba7e';
const EIP1271_MAGIC_VALUE_BYTES = '0x20c13b0b';
const EIP1271_IFACE_32 = new ethers.Interface(['function isValidSignature(bytes32,bytes) view returns (bytes4)']);
const EIP1271_IFACE_BYTES = new ethers.Interface(['function isValidSignature(bytes,bytes) view returns (bytes4)']);
let authProvider = null;
const walletTypeCache = new Map();
const WALLET_TYPE_CACHE_TTL_MS = Number(process.env.WALLET_TYPE_CACHE_TTL_MS || '300000');

function authRpcUrl() {
  return (
    String(process.env.AUTH_RPC_URL || '').trim() ||
    String(process.env.BASE_RPC_URL || '').trim() ||
    String(process.env.RPC_URL || '').trim() ||
    'https://mainnet.base.org'
  );
}

function getAuthProvider() {
  if (authProvider) return authProvider;
  authProvider = new ethers.JsonRpcProvider(authRpcUrl());
  return authProvider;
}

export async function detectWalletType(wallet) {
  const normalizedWallet = String(wallet || '').trim().toLowerCase();
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalizedWallet)) return 'unknown';
  const now = Date.now();
  const cached = walletTypeCache.get(normalizedWallet);
  if (cached && cached.exp > now) return cached.type;
  try {
    const provider = getAuthProvider();
    const code = await provider.getCode(normalizedWallet);
    const type = code && code !== '0x' ? 'contract' : 'eoa';
    walletTypeCache.set(normalizedWallet, { type, exp: now + WALLET_TYPE_CACHE_TTL_MS });
    return type;
  } catch (_) {
    return 'unknown';
  }
}

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
    'Content-Type, PAYMENT-SIGNATURE, X-CLIENT-MODE, X-WALLET-ADDRESS, X-ASSET-TRANSFER-METHOD, X-AUTH-SIGNATURE, X-AUTH-TIMESTAMP, X-PURCHASE-RECEIPT, X-REDOWNLOAD-SESSION, X-REDOWNLOAD-SIGNATURE, X-REDOWNLOAD-TIMESTAMP, X-REVIEWER, X-MODERATOR-ADDRESS, X-MODERATOR-SIGNATURE, X-MODERATOR-TIMESTAMP'
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PURCHASE-RECEIPT, X-PURCHASE-RECEIPT-HINT, X-REDOWNLOAD-SESSION'
  );
}

export function getSellerAddress() {
  const sellerAddress = process.env.SELLER_ADDRESS?.trim()?.replace(/\s/g, '');
  return sellerAddress || null;
}

export async function verifyWalletAuth({ wallet, soulId, action, timestamp, signature }) {
  if (!wallet || !signature || !timestamp) {
    return { ok: false, error: 'Missing wallet authentication headers' };
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return { ok: false, error: 'Invalid wallet address' };
  }

  const ts = parseAuthTimestamp(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, error: 'Invalid auth timestamp' };
  }

  const now = Date.now();
  const driftMs = 5 * 60 * 1000;
  if (Math.abs(now - ts) > driftMs) {
    return { ok: false, error: 'Authentication message expired' };
  }

  const siweCandidates = buildSiweAuthMessageCandidates({ wallet, soulId, action, timestamp: ts });
  const authDebug = {
    mode: 'siwe-only',
    tried_variants: siweCandidates.map((candidate) => candidate.variant),
    eoa_recovered: []
  };
  for (const candidate of siweCandidates) {
    const checked = await verifySiweCandidate({ wallet, signature, message: candidate.message });
    if (checked?.recovered) {
      authDebug.eoa_recovered.push({ variant: candidate.variant, recovered: checked.recovered });
    }
    if (checked.ok) {
      return {
        ok: true,
        wallet: wallet.toLowerCase(),
        auth_format: 'siwe',
        matched_variant: candidate.variant,
        signature_type: checked.signature_type
      };
    }
  }

  return {
    ok: false,
    error: 'Signature does not match SIWE wallet authentication format',
    auth_debug: authDebug
  };
}

async function verifySiweCandidate({ wallet, signature, message }) {
  const normalizedWallet = String(wallet || '').toLowerCase();
  try {
    const recovered = ethers.verifyMessage(message, signature);
    if (typeof recovered === 'string' && recovered.toLowerCase() === normalizedWallet) {
      return { ok: true, signature_type: 'eoa' };
    }
    return { ok: false, recovered: typeof recovered === 'string' ? recovered.toLowerCase() : null };
  } catch (_) {}
  return verifyEip1271Signature({ wallet, signature, message });
}

async function verifyEip1271Signature({ wallet, signature, message }) {
  const normalizedWallet = String(wallet || '').toLowerCase();
  const provider = getAuthProvider();
  let code;
  try {
    code = await provider.getCode(normalizedWallet);
  } catch (_) {
    return { ok: false };
  }
  if (!code || code === '0x') return { ok: false };

  const digest = ethers.hashMessage(message);
  const magic32 = await call1271({
    provider,
    to: normalizedWallet,
    iface: EIP1271_IFACE_32,
    fn: 'isValidSignature',
    args: [digest, signature]
  });
  if (magic32 === EIP1271_MAGIC_VALUE) {
    return { ok: true, signature_type: 'eip1271_bytes32' };
  }

  const messageBytes = ethers.toUtf8Bytes(message);
  const magicBytes = await call1271({
    provider,
    to: normalizedWallet,
    iface: EIP1271_IFACE_BYTES,
    fn: 'isValidSignature',
    args: [messageBytes, signature]
  });
  if (magicBytes === EIP1271_MAGIC_VALUE || magicBytes === EIP1271_MAGIC_VALUE_BYTES) {
    return { ok: true, signature_type: 'eip1271_bytes' };
  }

  return { ok: false };
}

async function call1271({ provider, to, iface, fn, args }) {
  try {
    const data = iface.encodeFunctionData(fn, args);
    const response = await provider.call({ to, data });
    const [magic] = iface.decodeFunctionResult(fn, response);
    return String(magic || '').toLowerCase();
  } catch (_) {
    return null;
  }
}

function buildSiweAuthMessageCandidates({ wallet, soulId, action, timestamp }) {
  const normalizedTimestamps = buildTimestampCandidates(timestamp);
  const rawWallet = String(wallet || '').trim();
  const walletLower = rawWallet.toLowerCase();
  const checksummed = safeChecksumAddress(rawWallet);
  const walletVariants = [walletLower, checksummed].filter(Boolean);
  const uniqueWallets = [...new Set(walletVariants)];
  const candidates = [];
  for (const ts of normalizedTimestamps) {
    for (const walletVariant of uniqueWallets) {
      const walletVariantLabel = walletVariant === walletLower ? 'siwe-lowercase' : 'siwe-checksummed';
      const tsLabel = ts === Number(timestamp) ? 'ts-ms' : 'ts-sec';
      const baseVariant = `${walletVariantLabel}-${tsLabel}`;
      const baseMessage = buildSiweAuthMessage({ wallet: walletVariant, soulId, action, timestamp: ts });
      candidates.push({ variant: `${baseVariant}-lf`, message: baseMessage });
      candidates.push({ variant: `${baseVariant}-lf-trailing`, message: `${baseMessage}\n` });
      const crlf = baseMessage.replace(/\n/g, '\r\n');
      candidates.push({ variant: `${baseVariant}-crlf`, message: crlf });
      candidates.push({ variant: `${baseVariant}-crlf-trailing`, message: `${crlf}\r\n` });
    }
  }
  return candidates;
}

function parseAuthTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value || '').trim();
  if (!raw) return Number.NaN;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric;
  const iso = Date.parse(raw);
  if (Number.isFinite(iso)) return iso;
  return Number.NaN;
}

function buildTimestampCandidates(ts) {
  const base = Number(ts);
  if (!Number.isFinite(base)) return [];
  const sec = Math.floor(base / 1000) * 1000;
  return [...new Set([base, sec])];
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
