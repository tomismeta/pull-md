import { CONTENT_SIGNAL, cacheControl, setPublicReadHeaders } from './_lib/agent_ready.js';
import { resolveBaseUrl } from './_lib/discovery.js';

function publicAllowRules() {
  return [
    'Allow: /',
    'Allow: /.well-known/',
    'Allow: /WEBMCP.md',
    'Allow: /api/openapi.json',
    'Allow: /api/mcp/manifest',
    'Allow: /api/assets',
    'Disallow: /api/assets/',
    'Disallow: /admin.html',
    'Disallow: /create.html',
    'Disallow: /api/auth/',
    'Disallow: /api/moderation',
    'Disallow: /api/ui/'
  ];
}

function renderRobots(baseUrl) {
  const sharedPublicRules = publicAllowRules();
  return [
    'User-agent: *',
    ...sharedPublicRules,
    '',
    'User-agent: GPTBot',
    'Disallow: /',
    '',
    'User-agent: Google-Extended',
    'Disallow: /',
    '',
    'User-agent: OAI-SearchBot',
    ...sharedPublicRules,
    '',
    'User-agent: Claude-Web',
    ...sharedPublicRules,
    '',
    `Sitemap: ${baseUrl}/sitemap.xml`,
    `Content-Signal: ${CONTENT_SIGNAL}`
  ].join('\n');
}

export default function handler(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  setPublicReadHeaders(res);
  res.setHeader('Cache-Control', cacheControl({ sMaxAge: 3600, staleWhileRevalidate: 86400 }));

  if (method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(200).end();
  }

  if (!['GET', 'HEAD'].includes(method)) {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = renderRobots(resolveBaseUrl(req.headers || {}));
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (method === 'HEAD') {
    return res.status(200).end();
  }
  return res.status(200).send(body);
}
