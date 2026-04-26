const DEFAULT_CANONICAL_HOST = 'pull.md';

function forwardedHeaderValue(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const first = value.split(',')[0];
  return String(first || '').trim();
}

function stripPort(host) {
  return String(host || '')
    .trim()
    .replace(/:\d+$/, '')
    .toLowerCase();
}

export function canonicalProductionHost() {
  const configured = stripPort(process.env.CANONICAL_HOST || '');
  return configured || DEFAULT_CANONICAL_HOST;
}

export function canonicalProductionBaseUrl() {
  return `https://${canonicalProductionHost()}`;
}

export function isLocalHost(host) {
  const value = stripPort(host);
  return (
    value.includes('localhost') ||
    value.startsWith('127.0.0.1') ||
    value.startsWith('0.0.0.0') ||
    value.endsWith('.local')
  );
}

export function isProductionPullMdHost(host) {
  const value = stripPort(host);
  if (!value) return false;
  const canonical = canonicalProductionHost();
  return value === canonical || value === `www.${canonical}`;
}

export function resolveSiteContext(headers = {}) {
  const forwardedHost = forwardedHeaderValue(headers['x-forwarded-host']);
  const host = stripPort(forwardedHost || headers.host || canonicalProductionHost());
  const proto = forwardedHeaderValue(headers['x-forwarded-proto']) || (isLocalHost(host) ? 'http' : 'https');
  const requestBaseUrl = `${proto}://${host || canonicalProductionHost()}`;
  const baseUrl = isProductionPullMdHost(host) || !host
    ? canonicalProductionBaseUrl()
    : requestBaseUrl;

  return {
    host,
    proto,
    requestBaseUrl,
    canonicalHost: canonicalProductionHost(),
    canonicalBaseUrl: canonicalProductionBaseUrl(),
    baseUrl
  };
}

export function canonicalizePullMdUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  const canonicalBase = canonicalProductionBaseUrl();
  return raw
    .replace(/^https:\/\/www\.pull\.md\b/i, canonicalBase)
    .replace(/^https:\/\/pull\.md\b/i, canonicalBase);
}
