import crypto from 'crypto';
import { ethers } from 'ethers';

const SIWE_STATEMENT = 'Authenticate wallet ownership for PULL.md. No token transfer or approval.';
const SIWE_CHAIN_ID = Number(process.env.SIWE_CHAIN_ID || '8453');

function configuredSiweDomain() {
  const configured = String(process.env.SIWE_DOMAIN || '').trim();
  if (!configured) return 'www.pull.md';
  if (configured.toLowerCase().includes('pullmd')) return 'www.pull.md';
  return configured;
}

function configuredSiweUri(domain) {
  const configured = String(process.env.SIWE_URI || '').trim();
  if (!configured) return `https://${domain}`;
  if (configured.toLowerCase().includes('pullmd')) return `https://${domain}`;
  return configured;
}

export function resolveSiweIdentity({ host, proto } = {}) {
  const rawHost = String(host || '').trim().toLowerCase();
  const rawProto = String(proto || '').trim().toLowerCase();
  const isLocalHost =
    rawHost.includes('localhost') ||
    rawHost.startsWith('127.0.0.1') ||
    rawHost.startsWith('0.0.0.0') ||
    rawHost.endsWith('.local');
  const domain = isLocalHost && rawHost ? rawHost : configuredSiweDomain();
  const configuredUri = configuredSiweUri(domain);
  if (!String(configuredUri || '').toLowerCase().includes('pullmd')) {
    return { domain, uri: configuredUri };
  }
  const protocol = isLocalHost && rawProto === 'http' ? 'http' : 'https';
  return { domain, uri: `${protocol}://${domain}` };
}

function normalizeAssetIdentifier(assetId, soulId) {
  return String(assetId || soulId || '*').trim() || '*';
}

export function parseSiweField(message, label) {
  const match = String(message || '').match(new RegExp(`^${label}:\\s*([^\\n\\r]+)`, 'm'));
  return match?.[1]?.trim() || null;
}

export function parseAuthTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value || '').trim();
  if (!raw) return Number.NaN;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric;
  const iso = Date.parse(raw);
  if (Number.isFinite(iso)) return iso;
  return Number.NaN;
}

export function buildTimestampCandidates(ts) {
  const base = Number(ts);
  if (!Number.isFinite(base)) return [];
  const sec = Math.floor(base / 1000) * 1000;
  return [...new Set([base, sec])];
}

export function safeChecksumAddress(address) {
  try {
    return ethers.getAddress(String(address || '').trim());
  } catch (_) {
    return null;
  }
}

function buildSiweNonce({ assetId, action, timestamp }) {
  const seed = `${String(assetId || '*')}|${String(action || '')}|${String(timestamp || '')}`;
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

export function buildSiweAuthMessage({ wallet, assetId, soulId, action, timestamp, domain, uri }) {
  const resolvedIdentity = resolveSiweIdentity({});
  const normalizedDomain = String(domain || resolvedIdentity.domain || configuredSiweDomain()).trim() || configuredSiweDomain();
  const normalizedUri = String(uri || configuredSiweUri(normalizedDomain)).trim() || configuredSiweUri(normalizedDomain);
  const normalizedAssetId = normalizeAssetIdentifier(assetId, soulId);
  const address = String(wallet || '').trim().toLowerCase();
  const ts = Number(timestamp);
  const issuedAt = new Date(ts).toISOString();
  const expiresAt = new Date(ts + 5 * 60 * 1000).toISOString();
  const nonce = buildSiweNonce({ assetId: normalizedAssetId, action, timestamp: ts });
  const requestId = `${String(action || 'auth').trim()}:${normalizedAssetId}`;
  return [
    `${normalizedDomain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    SIWE_STATEMENT,
    '',
    `URI: ${normalizedUri}`,
    'Version: 1',
    `Chain ID: ${Number.isFinite(SIWE_CHAIN_ID) ? SIWE_CHAIN_ID : 8453}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
    `Request ID: ${requestId}`,
    'Resources:',
    `- urn:pullmd:action:${String(action || '').trim()}`,
    `- urn:pullmd:asset:${normalizedAssetId}`
  ].join('\n');
}

export function buildSiweAuthMessageCandidates({ wallet, assetId, soulId, action, timestamp, domain, uri }) {
  const normalizedTimestamps = buildTimestampCandidates(timestamp);
  const rawWallet = String(wallet || '').trim();
  const walletLower = rawWallet.toLowerCase();
  const checksummed = safeChecksumAddress(rawWallet);
  const walletVariants = [...new Set([walletLower, checksummed].filter(Boolean))];
  const normalizedAssetId = normalizeAssetIdentifier(assetId, soulId);
  const candidates = [];
  for (const ts of normalizedTimestamps) {
    for (const walletVariant of walletVariants) {
      const walletVariantLabel = walletVariant === walletLower ? 'siwe-lowercase' : 'siwe-checksummed';
      const tsLabel = ts === Number(timestamp) ? 'ts-ms' : 'ts-sec';
      const baseVariant = `${walletVariantLabel}-${tsLabel}`;
      const baseMessage = buildSiweAuthMessage({
        wallet: walletVariant,
        assetId: normalizedAssetId,
        action,
        timestamp: ts,
        domain,
        uri
      });
      candidates.push({ variant: `${baseVariant}-lf`, message: baseMessage });
      candidates.push({ variant: `${baseVariant}-lf-trailing`, message: `${baseMessage}\n` });
      const crlf = baseMessage.replace(/\n/g, '\r\n');
      candidates.push({ variant: `${baseVariant}-crlf`, message: crlf });
      candidates.push({ variant: `${baseVariant}-crlf-trailing`, message: `${crlf}\r\n` });
    }
  }
  return candidates;
}

export function buildSiweChallengeFields({ wallet, assetId, soulId, action, siweIdentity, timestampMs = Date.now() }) {
  const authMessage = buildSiweAuthMessage({
    wallet,
    assetId,
    soulId,
    action,
    timestamp: timestampMs,
    domain: siweIdentity?.domain,
    uri: siweIdentity?.uri
  });
  const issuedAt = parseSiweField(authMessage, 'Issued At') || new Date(timestampMs).toISOString();
  const expirationTime = parseSiweField(authMessage, 'Expiration Time') || new Date(timestampMs + 300000).toISOString();
  const authTimestampMs = Date.parse(issuedAt);
  return {
    auth_message_template: authMessage,
    issued_at: issuedAt,
    expiration_time: expirationTime,
    auth_timestamp_ms: Number.isFinite(authTimestampMs) ? authTimestampMs : timestampMs
  };
}
