import { promises as fs } from 'fs';
import path from 'path';

import {
  cacheControl,
  requestPrefersMarkdown,
  setContentSignalHeader,
  setMarkdownDocumentHeaders
} from './agent_ready.js';
import { buildDiscoveryLinkHeader } from './discovery.js';

const INDEX_HTML_PATH = path.join(process.cwd(), 'public', 'index.html');
let homepageHtmlPromise = null;

function loadHomepageHtml() {
  if (!homepageHtmlPromise) {
    homepageHtmlPromise = fs.readFile(INDEX_HTML_PATH, 'utf8');
  }
  return homepageHtmlPromise;
}

function renderHomepageMarkdown(baseUrl) {
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
    '- x402 paywall contract: `402 PAYMENT-REQUIRED` -> retry with `PAYMENT-SIGNATURE`',
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
    '## Commerce',
    '',
    '- PULL.md is an active commerce site with x402-protected markdown assets.',
    '- Canonical paid route: `GET /api/assets/{id}/download`.',
    '- First request returns `402 PAYMENT-REQUIRED` with a Base64-encoded payment contract.',
    '- Retry the same route with `PAYMENT-SIGNATURE` to settle payment and receive markdown.',
    '',
    '## Current Catalog',
    '',
    '- Fetch `GET /api/assets` to enumerate the current public markdown asset catalog.',
    '- Use `POST /mcp` with `list_assets` when you want the MCP orchestration view of the same catalog.',
    '',
    '## Notes',
    '',
    '- Publishing remains MCP-first: call `get_auth_challenge`, sign the exact SIWE message, then call `publish_listing`.',
    '- Buying remains REST-first: call `GET /api/assets/{id}/download`, handle `402 PAYMENT-REQUIRED`, then retry with `PAYMENT-SIGNATURE`.',
    '- Re-download remains receipt-first: persist `X-PURCHASE-RECEIPT` and prove wallet control on later downloads.',
    '- OAuth/OIDC discovery metadata is intentionally absent in this deployment: protected flows do not use bearer tokens. Wallet identity uses SIWE (EIP-4361); payment and entitlement delivery use x402 plus receipt-bound headers.'
  ].join('\n');
}

export async function handleHomepageRequest({ req, res, baseUrl }) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(200).end();
  }

  if (!['GET', 'HEAD'].includes(method)) {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const discoveryLinks = buildDiscoveryLinkHeader(baseUrl);
  const alternateMarkdownLink = `<${baseUrl}/>; rel="alternate"; type="text/markdown"`;
  res.setHeader('Link', `${discoveryLinks}, ${alternateMarkdownLink}`);
  res.setHeader('Vary', 'Accept');
  res.setHeader('Cache-Control', cacheControl({ sMaxAge: 900, staleWhileRevalidate: 86400 }));
  setContentSignalHeader(res);

  const prefersMarkdown = requestPrefersMarkdown(req.headers || {});
  if (prefersMarkdown) {
    const markdown = renderHomepageMarkdown(baseUrl);
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
