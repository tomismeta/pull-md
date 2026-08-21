import { escapeXml } from './agent_ready.js';

function renderSitemap(baseUrl) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url>',
    `    <loc>${escapeXml(`${baseUrl}/`)}</loc>`,
    '    <lastmod>2026-08-21</lastmod>',
    '  </url>',
    '</urlset>',
    ''
  ].join('\n');
}

export async function handleSitemapRequest({ req, res, baseUrl }) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(204).end();
  }

  if (!['GET', 'HEAD'].includes(method)) {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const xml = renderSitemap(baseUrl);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400');
  return method === 'HEAD' ? res.status(200).end() : res.status(200).send(xml);
}
