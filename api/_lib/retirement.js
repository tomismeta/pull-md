import { resolveSiteContext } from './site_url.js';

export const RETIRED_AT = '2026-08-21T00:00:00.000Z';
export const REDOWNLOAD_GRACE_END_AT = '2026-09-21T23:59:59.000Z';

export function isRedownloadGraceActive(now = Date.now()) {
  const current = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(current) && current <= Date.parse(REDOWNLOAD_GRACE_END_AT);
}

export function evaluateRetiredDownloadAccess({ hasExistingEntitlementProof, now = Date.now() } = {}) {
  if (!isRedownloadGraceActive(now)) {
    return { allowed: false, reason: 'redownload_grace_ended' };
  }
  if (!hasExistingEntitlementProof) {
    return { allowed: false, reason: 'new_purchases_disabled' };
  }
  return { allowed: true, reason: 'existing_entitlement_grace' };
}

export function buildRetirementProblem({ baseUrl = 'https://pull.md', path = '/', now = Date.now() } = {}) {
  const redownloadAvailable = isRedownloadGraceActive(now);
  const normalizedPath = String(path || '/').startsWith('/') ? String(path || '/') : `/${path}`;
  return {
    type: `${baseUrl}/#retirement`,
    title: 'PULL.md has been retired',
    status: 410,
    detail: redownloadAvailable
      ? 'PULL.md no longer accepts publishing, marketplace discovery, MCP calls, or new purchases. Existing entitlement holders may use the original download endpoint during the grace period.'
      : 'PULL.md no longer accepts publishing, marketplace discovery, MCP calls, purchases, or entitlement recovery. The recovery grace period has ended.',
    instance: `${baseUrl}${normalizedPath}`,
    code: 'service_retired',
    retired_at: RETIRED_AT,
    service_status: {
      publishing: 'retired',
      mcp: 'retired',
      new_purchases: 'retired',
      existing_entitlement_recovery: redownloadAvailable ? 'grace_period' : 'retired'
    },
    redownload_grace: {
      available: redownloadAvailable,
      ends_at: REDOWNLOAD_GRACE_END_AT,
      endpoint_pattern: '/api/assets/{id}/download',
      requirement:
        'Existing entitlement proof is required. New payment quotes and settlement retries are permanently disabled.'
    },
    source_archive: 'https://github.com/tomismeta/pull-md',
    contact: 'https://x.com/tomismeta'
  };
}

export function setRetirementHeaders(
  res,
  {
    baseUrl = 'https://pull.md',
    cacheControl = 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400'
  } = {}
) {
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
  res.setHeader('Sunset', new Date(REDOWNLOAD_GRACE_END_AT).toUTCString());
  res.setHeader('Link', `<${baseUrl}/>; rel="service-doc"`);
  res.setHeader('X-PULLMD-RETIRED', 'true');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

export function sendRetirementProblem({ req, res, path, now = Date.now(), cacheControl }) {
  const { baseUrl } = resolveSiteContext(req?.headers || {});
  const method = String(req?.method || 'GET').toUpperCase();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, X-WALLET-ADDRESS, X-PURCHASE-RECEIPT, X-REDOWNLOAD-SIGNATURE, X-REDOWNLOAD-TIMESTAMP'
  );
  setRetirementHeaders(res, { baseUrl, ...(cacheControl ? { cacheControl } : {}) });

  if (method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, POST, OPTIONS');
    return res.status(204).end();
  }

  const problem = buildRetirementProblem({
    baseUrl,
    path: path || req?.query?.path || req?.url || '/',
    now
  });
  if (method === 'HEAD') {
    return res.status(410).end();
  }
  return res.status(410).json(problem);
}
