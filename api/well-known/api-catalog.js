import {
  apiCatalogContentType,
  buildApiCatalogDocument,
  buildApiCatalogHeadLinkHeader,
  resolveBaseUrl,
  setDiscoveryHeaders
} from '../_lib/discovery.js';

export default function handler(req, res) {
  setDiscoveryHeaders(res, req);
  const baseUrl = resolveBaseUrl(req.headers || {});
  res.setHeader('Content-Type', apiCatalogContentType());
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400');
  res.setHeader('Link', buildApiCatalogHeadLinkHeader(baseUrl));

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(200).end();
  }

  if (req.method === 'HEAD') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  return res.status(200).json(buildApiCatalogDocument(baseUrl));
}
