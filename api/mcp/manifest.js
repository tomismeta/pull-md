import { handleHomepageRequest } from '../_lib/homepage.js';
import { sendRetirementProblem } from '../_lib/retirement.js';
import { resolveSiteContext } from '../_lib/site_url.js';
import { handleSitemapRequest } from '../_lib/sitemap.js';

export default function handler(req, res) {
  const { baseUrl } = resolveSiteContext(req.headers || {});
  const view = String(req.query?.view || '').trim().toLowerCase();

  if (view === 'home') {
    return handleHomepageRequest({ req, res, baseUrl });
  }
  if (view === 'sitemap') {
    return handleSitemapRequest({ req, res, baseUrl });
  }
  if (view === 'retired' || view === 'asset') {
    return handleHomepageRequest({ req, res, baseUrl, statusCode: 410 });
  }

  return sendRetirementProblem({
    req,
    res,
    path: '/api/mcp/manifest'
  });
}
