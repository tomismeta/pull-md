import { buildDiscoveryLinkEntries, buildDiscoveryUrls } from './public_contract.js';

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
  return buildDiscoveryLinkEntries(baseUrl)
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
    ...buildDiscoveryLinkEntries(baseUrl),
    { href: `${baseUrl}/mcp`, rel: 'item' }
  ];
  return entries
    .map((entry) => serializeLinkEntry(entry))
    .filter(Boolean)
    .join(', ');
}

export function buildApiCatalogDocument(baseUrl) {
  const routes = buildDiscoveryUrls(baseUrl);
  return {
    linkset: [
      {
        anchor: routes.api_catalog,
        item: [{ href: `${baseUrl}/mcp` }, { href: routes.public_catalog }]
      },
      {
        anchor: `${baseUrl}/mcp`,
        'service-desc': [{ href: routes.mcp_manifest, type: 'application/json' }],
        'service-doc': [{ href: routes.webmcp_markdown, type: 'text/markdown' }],
        'service-meta': [{ href: routes.mcp_manifest, type: 'application/json' }]
      },
      {
        anchor: routes.public_catalog,
        'service-desc': [{ href: routes.openapi, type: OPENAPI_CONTENT_TYPE }],
        'service-doc': [{ href: routes.webmcp_markdown, type: 'text/markdown' }],
        'service-meta': [{ href: routes.mcp_manifest, type: 'application/json' }]
      },
      {
        anchor: routes.canonical_purchase_endpoint_pattern,
        'service-desc': [{ href: routes.openapi, type: OPENAPI_CONTENT_TYPE }],
        'service-doc': [{ href: routes.webmcp_markdown, type: 'text/markdown' }],
        'service-meta': [{ href: routes.mcp_manifest, type: 'application/json' }]
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
