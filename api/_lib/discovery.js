const API_CATALOG_PROFILE_URI = 'https://www.rfc-editor.org/info/rfc9727';
const OPENAPI_CONTENT_TYPE = 'application/vnd.oai.openapi+json;version=3.1';

function forwardedHeaderValue(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const first = value.split(',')[0];
  return String(first || '').trim();
}

export function resolveBaseUrl(headers = {}) {
  const host = forwardedHeaderValue(headers['x-forwarded-host']) || String(headers.host || 'pull.md').trim();
  const proto = forwardedHeaderValue(headers['x-forwarded-proto']) || 'https';
  return `${proto}://${host}`;
}

function discoveryLinkEntries(baseUrl) {
  return [
    {
      href: `${baseUrl}/.well-known/api-catalog`,
      rel: 'api-catalog',
      type: 'application/linkset+json'
    },
    {
      href: `${baseUrl}/api/openapi.json`,
      rel: 'service-desc',
      type: OPENAPI_CONTENT_TYPE
    },
    {
      href: `${baseUrl}/WEBMCP.md`,
      rel: 'service-doc',
      type: 'text/markdown'
    },
    {
      href: `${baseUrl}/api/mcp/manifest`,
      rel: 'service-meta',
      type: 'application/json'
    }
  ];
}

function serializeLinkEntry(entry) {
  const href = String(entry?.href || '').trim();
  const rel = String(entry?.rel || '').trim();
  if (!href || !rel) return '';
  const attrs = [`<${href}>`, `rel="${rel}"`];
  const type = String(entry?.type || '').trim();
  if (type) attrs.push(`type="${type}"`);
  return attrs.join('; ');
}

export function buildDiscoveryLinkHeader(baseUrl) {
  return discoveryLinkEntries(baseUrl)
    .map((entry) => serializeLinkEntry(entry))
    .filter(Boolean)
    .join(', ');
}

export function setDiscoveryHeaders(res, req) {
  if (!res || typeof res.setHeader !== 'function') return;
  const baseUrl = resolveBaseUrl(req?.headers || {});
  const linkHeader = buildDiscoveryLinkHeader(baseUrl);
  if (linkHeader) {
    res.setHeader('Link', linkHeader);
  }
}

export function buildApiCatalogHeadLinkHeader(baseUrl) {
  const entries = [
    ...discoveryLinkEntries(baseUrl),
    { href: `${baseUrl}/mcp`, rel: 'item' },
    { href: `${baseUrl}/api/assets`, rel: 'item' }
  ];
  return entries
    .map((entry) => serializeLinkEntry(entry))
    .filter(Boolean)
    .join(', ');
}

export function buildApiCatalogDocument(baseUrl) {
  return {
    linkset: [
      {
        anchor: `${baseUrl}/.well-known/api-catalog`,
        item: [{ href: `${baseUrl}/mcp` }, { href: `${baseUrl}/api/assets` }]
      },
      {
        anchor: `${baseUrl}/mcp`,
        'service-desc': [{ href: `${baseUrl}/api/mcp/manifest`, type: 'application/json' }],
        'service-doc': [{ href: `${baseUrl}/WEBMCP.md`, type: 'text/markdown' }],
        'service-meta': [{ href: `${baseUrl}/api/mcp/manifest`, type: 'application/json' }]
      },
      {
        anchor: `${baseUrl}/api/assets`,
        'service-desc': [{ href: `${baseUrl}/api/openapi.json`, type: OPENAPI_CONTENT_TYPE }],
        'service-doc': [{ href: `${baseUrl}/WEBMCP.md`, type: 'text/markdown' }],
        'service-meta': [{ href: `${baseUrl}/api/mcp/manifest`, type: 'application/json' }]
      }
    ]
  };
}

export function apiCatalogContentType() {
  return `application/linkset+json; profile="${API_CATALOG_PROFILE_URI}"`;
}

export function openApiContentType() {
  return OPENAPI_CONTENT_TYPE;
}
