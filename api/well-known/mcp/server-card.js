import { cacheControl, setPublicReadHeaders } from '../../_lib/agent_ready.js';
import { resolveBaseUrl } from '../../_lib/discovery.js';
import { getMcpServerMetadata } from '../../_lib/mcp_sdk.js';
import { getMcpToolsForManifest } from '../../_lib/mcp_tools.js';

function buildServerCard(baseUrl) {
  const metadata = getMcpServerMetadata();
  const tools = getMcpToolsForManifest();

  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
    version: '1.0',
    protocolVersion: metadata.protocolVersion,
    serverInfo: {
      name: metadata.name,
      title: 'PULL.md',
      version: '1.0.0'
    },
    description: 'Markdown asset marketplace with MCP orchestration and canonical x402 HTTP settlement.',
    iconUrl: `${baseUrl}/favicon.svg`,
    documentationUrl: `${baseUrl}/WEBMCP.md`,
    transport: {
      type: 'streamable-http',
      endpoint: metadata.endpoint
    },
    capabilities: {
      tools: {
        listChanged: false
      },
      prompts: {
        listChanged: false
      },
      resources: {
        subscribe: false,
        listChanged: false
      }
    },
    auth: {
      type: 'none',
      note: 'The MCP endpoint is public. Wallet proof and x402 payment are enforced within specific publish, entitlement, and download flows.'
    },
    discovery: {
      apiCatalog: `${baseUrl}/.well-known/api-catalog`,
      openapi: `${baseUrl}/api/openapi.json`,
      manifest: `${baseUrl}/api/mcp/manifest`,
      agentSkills: `${baseUrl}/.well-known/agent-skills/index.json`
    },
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      method: tool.method,
      endpoint: tool.endpoint
    }))
  };
}

export default function handler(req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  setPublicReadHeaders(res);
  res.setHeader('Cache-Control', cacheControl({ sMaxAge: 900, staleWhileRevalidate: 86400 }));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(200).end();
  }

  if (!['GET', 'HEAD'].includes(method)) {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = buildServerCard(resolveBaseUrl(req.headers || {}));
  if (method === 'HEAD') {
    return res.status(200).end();
  }
  return res.status(200).json(body);
}
