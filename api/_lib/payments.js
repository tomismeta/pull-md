import crypto from 'crypto';
import { ethers } from 'ethers';

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
    'Content-Type, PAYMENT, PAYMENT-SIGNATURE, X-PAYMENT, X-WALLET-ADDRESS, X-AUTH-SIGNATURE, X-AUTH-TIMESTAMP, X-PURCHASE-RECEIPT, X-BANKR-API-KEY'
  );
  res.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PURCHASE-RECEIPT');
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

  const message = buildAuthMessage({ wallet, soulId, action, timestamp: ts });
  let recovered;
  try {
    recovered = ethers.utils.verifyMessage(message, signature);
  } catch (_) {
    return { ok: false, error: 'Invalid auth signature' };
  }

  if (recovered.toLowerCase() !== wallet.toLowerCase()) {
    return { ok: false, error: 'Signature does not match wallet address' };
  }

  return { ok: true, wallet: wallet.toLowerCase() };
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

function receiptSecret() {
  return process.env.PURCHASE_RECEIPT_SECRET || 'dev-only-insecure-secret-change-me';
}

export function createPurchaseReceipt({ wallet, soulId, transaction }) {
  const payload = JSON.stringify({
    wallet: wallet.toLowerCase(),
    soulId,
    transaction,
    iat: Date.now()
  });
  const payloadB64 = base64UrlEncode(payload);
  const sig = crypto.createHmac('sha256', receiptSecret()).update(payloadB64).digest('base64');
  const sigB64 = sig.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${payloadB64}.${sigB64}`;
}

export function verifyPurchaseReceipt({ receipt, wallet, soulId }) {
  if (!receipt || typeof receipt !== 'string' || !receipt.includes('.')) {
    return { ok: false, error: 'Missing purchase receipt' };
  }

  const [payloadB64, sigB64] = receipt.split('.');
  const expected = crypto
    .createHmac('sha256', receiptSecret())
    .update(payloadB64)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

  if (sigB64 !== expected) {
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
