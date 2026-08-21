import { promises as fs } from 'fs';
import path from 'path';

import {
  cacheControl,
  requestPrefersMarkdown,
  setContentSignalHeader,
  setMarkdownDocumentHeaders
} from './agent_ready.js';
import { REDOWNLOAD_GRACE_END_AT, RETIRED_AT } from './retirement.js';

const INDEX_HTML_PATH = path.join(process.cwd(), 'public', 'index.html');
let homepageHtmlPromise = null;

function loadHomepageHtml() {
  if (!homepageHtmlPromise) {
    homepageHtmlPromise = fs.readFile(INDEX_HTML_PATH, 'utf8');
  }
  return homepageHtmlPromise;
}

function renderHomepageHtml(baseUrl) {
  return loadHomepageHtml().then((template) =>
    template
      .replaceAll('__PULLMD_BASE_URL__', baseUrl)
      .replaceAll('__PULLMD_CANONICAL_URL__', `${baseUrl}/`)
  );
}

function renderHomepageMarkdown(baseUrl) {
  return [
    '---',
    'title: PULL.md has been retired',
    'status: retired',
    `retired_at: ${RETIRED_AT}`,
    `redownload_grace_ends_at: ${REDOWNLOAD_GRACE_END_AT}`,
    '---',
    '',
    '# PULL.md has been retired',
    '',
    'The PULL.md marketplace experiment concluded on August 21, 2026.',
    '',
    '## Service status',
    '',
    '- New publishing: unavailable',
    '- MCP transport and tools: `410 Gone`',
    '- Catalog and discovery APIs: `410 Gone`',
    '- New purchases and x402 settlement: unavailable',
    `- Existing entitlement recovery: available through ${REDOWNLOAD_GRACE_END_AT}`,
    '',
    'Existing entitlement holders may continue using the original `GET /api/assets/{id}/download` endpoint during the grace period. A valid receipt or other existing entitlement proof is required; the endpoint will not issue payment quotes or settle new purchases.',
    '',
    'The source is preserved at https://github.com/tomismeta/pull-md.',
    '',
    `Canonical retirement notice: ${baseUrl}/`
  ].join('\n');
}

export async function handleHomepageRequest({ req, res, baseUrl, statusCode = 200 }) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(204).end();
  }

  if (!['GET', 'HEAD'].includes(method)) {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader(
    'Link',
    `<${baseUrl}/>; rel="canonical", <${baseUrl}/>; rel="alternate"; type="text/markdown"`
  );
  res.setHeader('Vary', 'Accept');
  res.setHeader('Cache-Control', cacheControl({ sMaxAge: 300, staleWhileRevalidate: 86400 }));
  res.setHeader('Sunset', new Date(REDOWNLOAD_GRACE_END_AT).toUTCString());
  res.setHeader('X-PULLMD-RETIRED', 'true');
  if (statusCode >= 400) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
  setContentSignalHeader(res);

  const prefersMarkdown = requestPrefersMarkdown(req.headers || {});
  if (prefersMarkdown) {
    const markdown = renderHomepageMarkdown(baseUrl);
    setMarkdownDocumentHeaders(res, markdown, { sMaxAge: 300, staleWhileRevalidate: 86400 });
    if (method === 'HEAD') {
      return res.status(statusCode).end();
    }
    return res.status(statusCode).send(markdown);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (method === 'HEAD') {
    return res.status(statusCode).end();
  }

  try {
    const rendered = await renderHomepageHtml(baseUrl);
    return res.status(statusCode).send(rendered);
  } catch (error) {
    return res.status(500).json({
      error: 'Unable to load retirement notice',
      details: error?.message || 'unknown_error'
    });
  }
}
