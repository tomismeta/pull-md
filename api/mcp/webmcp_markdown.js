import manifestHandler from './manifest.js';
import { setCors } from '../_lib/payments.js';

function escapeCell(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ')
    .trim();
}

async function loadManifestPayload(origin) {
  return new Promise((resolve, reject) => {
    const req = { method: 'GET', headers: { origin: origin || '' } };
    const res = {
      statusCode: 200,
      headers: {},
      body: null,
      setHeader(key, value) {
        this.headers[String(key).toLowerCase()] = value;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        resolve(payload);
        return this;
      },
      end() {
        resolve(this.body);
        return this;
      }
    };

    Promise.resolve(manifestHandler(req, res)).catch(reject);
  });
}

function renderToolsTable(tools) {
  const rows = [
    '| Tool | Method | Endpoint | Purpose |',
    '| --- | --- | --- | --- |'
  ];

  for (const tool of tools) {
    rows.push(
      `| \`${escapeCell(tool.name)}\` | \`${escapeCell(tool.method)}\` | \`${escapeCell(tool.endpoint)}\` | ${escapeCell(tool.description)} |`
    );
  }
  return rows.join('\n');
}

function renderStringList(items) {
  if (!Array.isArray(items) || !items.length) return '- none';
  return items.map((item) => `- \`${escapeCell(item)}\``).join('\n');
}

function renderWebmcpMarkdown(manifest) {
  const tools = Array.isArray(manifest?.tools) ? manifest.tools : [];
  const auth = manifest?.auth || {};
  const dl = manifest?.download_contract || {};
  const errors = manifest?.error_codes || {};
  const capabilities = manifest?.facilitator_capabilities || {};

  const errorLines = Object.entries(errors).map(([code, description]) => `- \`${escapeCell(code)}\`: ${escapeCell(description)}`);
  const capabilityLines = Object.entries(capabilities).map(([key, value]) => `- \`${escapeCell(key)}\`: ${escapeCell(value)}`);

  return [
    '# SoulStarter WebMCP Contract',
    '',
    '> Generated dynamically from `GET /api/mcp/manifest`.',
    '',
    '## Canonical Endpoints',
    '- Manifest: `GET /api/mcp/manifest`',
    '- Markdown contract: `GET /WEBMCP.md`',
    '- MCP transport: `POST /mcp`',
    '- Public catalog: `GET /api/souls`',
    '- Purchase + re-download runtime: `GET /api/souls/{id}/download`',
    '',
    '## Identity',
    `- Name: ${escapeCell(manifest?.name || '')}`,
    `- Description: ${escapeCell(manifest?.description || '')}`,
    `- Base URL: ${escapeCell(manifest?.url || '')}`,
    `- Schema: ${escapeCell(manifest?.schema_version || '')}`,
    '',
    '## Auth and Payment',
    `- Type: \`${escapeCell(auth.type)}\``,
    `- Network: \`${escapeCell(auth.network)}\``,
    `- Currency: \`${escapeCell(auth.currency)}\``,
    `- Strict agent mode header: \`X-CLIENT-MODE: ${escapeCell(auth.strict_agent_mode_value || 'agent')}\``,
    '- Required payment header:',
    renderStringList(auth.purchase_header_preference),
    '- Supported request headers:',
    renderStringList(auth.headers),
    '',
    '## Canonical Runtime Flow',
    `1. ${escapeCell(dl.first_request || 'Initial GET returns 402 + PAYMENT-REQUIRED.')}`,
    `2. ${escapeCell(dl.claim_request || 'Retry same endpoint with PAYMENT-SIGNATURE.')}`,
    `3. ${escapeCell(dl.redownload_request || 'Re-download via receipt + wallet proof.')}`,
    '',
    '## Tools',
    renderToolsTable(tools),
    '',
    '## MCP Methods',
    renderStringList(manifest?.mcp?.methods || []),
    '',
    '## Facilitator Capabilities',
    ...(capabilityLines.length ? capabilityLines : ['- none']),
    '',
    '## Error Codes',
    ...(errorLines.length ? errorLines : ['- none']),
    '',
    '## Notes',
    `- ${escapeCell(dl.note || '')}`,
    `- ${escapeCell(dl.domain_note || '')}`
  ].join('\n');
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const manifest = await loadManifestPayload(req.headers.origin);
    const markdown = renderWebmcpMarkdown(manifest || {});
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    return res.status(200).send(markdown);
  } catch (error) {
    return res.status(500).json({
      error: 'Unable to render WebMCP markdown',
      details: error?.message || 'unknown_error'
    });
  }
}
