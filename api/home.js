import { promises as fs } from 'fs';
import path from 'path';

import {
  cacheControl,
  requestPrefersMarkdown,
  setContentSignalHeader,
  setMarkdownDocumentHeaders
} from './_lib/agent_ready.js';
import { buildDiscoveryLinkHeader, resolveBaseUrl } from './_lib/discovery.js';
import { listAssetsCatalog } from './_lib/services/assets.js';

const INDEX_HTML_PATH = path.join(process.cwd(), 'public', 'index.html');
let homepageHtmlPromise = null;

function loadHomepageHtml() {
  if (!homepageHtmlPromise) {
    homepageHtmlPromise = fs.readFile(INDEX_HTML_PATH, 'utf8');
  }
  return homepageHtmlPromise;
}

function assetSummaryLine(asset) {
  const id = String(asset?.id || '').trim();
  const assetType = String(asset?.asset_type || '').trim().toUpperCase() || 'ASSET';
  const name = String(asset?.name || '').trim() || id || 'Untitled asset';
  const description = String(asset?.description || '').trim() || 'Markdown asset listing';
  const sharePath =
    String(asset?.share_path || '').trim() || `/asset.html?id=${encodeURIComponent(id)}`;
  return `- [${name}](${sharePath}) \`${assetType}.md\` - ${description}`;
}

function renderHomepageMarkdown(baseUrl, assets = []) {
  const catalogLines = Array.isArray(assets) && assets.length
    ? assets.slice(0, 12).map((asset) => assetSummaryLine(asset))
    : ['- Catalog data loads from `GET /api/assets`.'];

  return [
    '---',
    'title: PULL.md',
    'description: Markdown asset commerce for agents and humans.',
    '---',
    '',
    '# PULL.md',
    '',
    'PULL.md is a markdown-native asset marketplace. Agents and humans share the same catalog, the same MCP discovery surface, and the same canonical x402 download contract.',
    '',
    '## Quickstart',
    '',
    '- MCP transport: `POST /mcp`',
    '- REST discovery: `GET /.well-known/api-catalog`',
    '- OpenAPI: `GET /api/openapi.json`',
    '- MCP manifest: `GET /api/mcp/manifest`',
    '- Public catalog: `GET /api/assets`',
    '- Purchase + re-download: `GET /api/assets/{id}/download`',
    '- MCP server card: `GET /.well-known/mcp/server-card.json`',
    '- Agent skills index: `GET /.well-known/agent-skills/index.json`',
    '',
    '## Discovery',
    '',
    `- Base URL: ${baseUrl}`,
    `- API catalog: ${baseUrl}/.well-known/api-catalog`,
    `- OpenAPI: ${baseUrl}/api/openapi.json`,
    `- MCP manifest: ${baseUrl}/api/mcp/manifest`,
    `- WebMCP markdown contract: ${baseUrl}/WEBMCP.md`,
    '',
    '## Current Catalog',
    '',
    ...catalogLines,
    '',
    '## Notes',
    '',
    '- Publishing remains MCP-first: call `get_auth_challenge`, sign the exact SIWE message, then call `publish_listing`.',
    '- Buying remains REST-first: call `GET /api/assets/{id}/download`, handle `402 PAYMENT-REQUIRED`, then retry with `PAYMENT-SIGNATURE`.',
    '- Re-download remains receipt-first: persist `X-PURCHASE-RECEIPT` and prove wallet control on later downloads.'
  ].join('\n');
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

  const baseUrl = resolveBaseUrl(req.headers || {});
  const discoveryLinks = buildDiscoveryLinkHeader(baseUrl);
  const alternateMarkdownLink = `<${baseUrl}/>; rel="alternate"; type="text/markdown"`;
  res.setHeader('Link', `${discoveryLinks}, ${alternateMarkdownLink}`);
  res.setHeader('Vary', 'Accept');
  res.setHeader('Cache-Control', cacheControl({ sMaxAge: 900, staleWhileRevalidate: 86400 }));
  setContentSignalHeader(res);

  const prefersMarkdown = requestPrefersMarkdown(req.headers || {});
  if (prefersMarkdown) {
    let assets = [];
    try {
      assets = await listAssetsCatalog();
    } catch (_) {
      assets = [];
    }
    const markdown = renderHomepageMarkdown(baseUrl, assets);
    setMarkdownDocumentHeaders(res, markdown, { sMaxAge: 300, staleWhileRevalidate: 86400 });
    if (method === 'HEAD') {
      return res.status(200).end();
    }
    return res.status(200).send(markdown);
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (method === 'HEAD') {
    return res.status(200).end();
  }

  try {
    const html = await loadHomepageHtml();
    return res.status(200).send(html);
  } catch (error) {
    return res.status(500).json({
      error: 'Unable to load homepage',
      details: error?.message || 'unknown_error'
    });
  }
}
