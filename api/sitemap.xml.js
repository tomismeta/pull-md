import { cacheControl, escapeXml, setPublicReadHeaders } from './_lib/agent_ready.js';
import { resolveBaseUrl } from './_lib/discovery.js';
import { listAssetsCatalog } from './_lib/services/assets.js';

function toAbsoluteUrl(baseUrl, pathOrUrl) {
  try {
    return new URL(String(pathOrUrl || '/'), baseUrl).href;
  } catch (_) {
    return new URL('/', baseUrl).href;
  }
}

function candidateLastmod(asset) {
  const values = [
    asset?.scan_scanned_at,
    asset?.updated_at,
    asset?.published_at,
    asset?.created_at
  ];
  for (const value of values) {
    const timestamp = Date.parse(String(value || ''));
    if (Number.isFinite(timestamp)) {
      return new Date(timestamp).toISOString();
    }
  }
  return null;
}

function renderUrlEntry(loc, lastmod = null) {
  const lines = ['  <url>', `    <loc>${escapeXml(loc)}</loc>`];
  if (lastmod) {
    lines.push(`    <lastmod>${escapeXml(lastmod)}</lastmod>`);
  }
  lines.push('  </url>');
  return lines.join('\n');
}

function buildStaticUrlEntries(baseUrl) {
  return [
    { loc: toAbsoluteUrl(baseUrl, '/'), lastmod: null },
    { loc: toAbsoluteUrl(baseUrl, '/security.html'), lastmod: null },
    { loc: toAbsoluteUrl(baseUrl, '/WEBMCP.md'), lastmod: null },
    { loc: toAbsoluteUrl(baseUrl, '/.well-known/api-catalog'), lastmod: null },
    { loc: toAbsoluteUrl(baseUrl, '/api/openapi.json'), lastmod: null },
    { loc: toAbsoluteUrl(baseUrl, '/api/mcp/manifest'), lastmod: null },
    { loc: toAbsoluteUrl(baseUrl, '/.well-known/mcp/server-card.json'), lastmod: null },
    { loc: toAbsoluteUrl(baseUrl, '/.well-known/agent-skills/index.json'), lastmod: null }
  ];
}

function buildAssetEntries(baseUrl, assets) {
  return (Array.isArray(assets) ? assets : []).map((asset) => {
    const sharePath =
      String(asset?.share_path || '').trim() || `/asset.html?id=${encodeURIComponent(String(asset?.id || ''))}`;
    return {
      loc: toAbsoluteUrl(baseUrl, sharePath),
      lastmod: candidateLastmod(asset)
    };
  });
}

function renderSitemap(baseUrl, assets) {
  const byUrl = new Map();
  for (const entry of [...buildStaticUrlEntries(baseUrl), ...buildAssetEntries(baseUrl, assets)]) {
    if (!entry?.loc) continue;
    if (!byUrl.has(entry.loc)) {
      byUrl.set(entry.loc, entry);
    }
  }
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...[...byUrl.values()].map((entry) => renderUrlEntry(entry.loc, entry.lastmod)),
    '</urlset>'
  ];
  return body.join('\n');
}

export default async function handler(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  setPublicReadHeaders(res);
  res.setHeader('Cache-Control', cacheControl({ sMaxAge: 300, staleWhileRevalidate: 86400 }));

  if (method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(200).end();
  }

  if (!['GET', 'HEAD'].includes(method)) {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let assets = [];
  try {
    assets = await listAssetsCatalog();
  } catch (_) {
    assets = [];
  }

  const body = renderSitemap(resolveBaseUrl(req.headers || {}), assets);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  if (method === 'HEAD') {
    return res.status(200).end();
  }
  return res.status(200).send(body);
}
