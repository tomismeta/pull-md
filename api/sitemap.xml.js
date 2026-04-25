import { assetDetailPath } from './_lib/asset_paths.js';
import { listAssetsCatalog } from './_lib/services/assets.js';
import { resolveSiteContext } from './_lib/site_url.js';

function escapeXml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function renderSitemap(urls = []) {
  const rows = urls
    .map((url) => `  <url>\n    <loc>${escapeXml(url)}</loc>\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows}\n</urlset>\n`;
}

export default async function handler(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(200).end();
  }

  if (!['GET', 'HEAD'].includes(method)) {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { baseUrl } = resolveSiteContext(req.headers || {});
  const assets = await listAssetsCatalog({});
  const urls = [
    `${baseUrl}/`,
    `${baseUrl}/security.html`,
    `${baseUrl}/WEBMCP.md`,
    `${baseUrl}/.well-known/api-catalog`,
    `${baseUrl}/.well-known/mcp/server-card.json`,
    `${baseUrl}/.well-known/agent-skills/index.json`,
    `${baseUrl}/api/openapi.json`,
    `${baseUrl}/api/mcp/manifest`,
    `${baseUrl}/api/assets`,
    ...assets.map((asset) => `${baseUrl}${assetDetailPath(asset.id)}`)
  ];
  const xml = renderSitemap([...new Set(urls)]);

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400');
  return method === 'HEAD' ? res.status(200).end() : res.status(200).send(xml);
}
