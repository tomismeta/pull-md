import { AppError } from './errors.js';
import { listSoulsCatalog, resolveSoulDetails, buildMcpSoulDetailsResponse } from './services/souls.js';

function baseUrlFromHeaders(headers = {}) {
  const host = String(headers['x-forwarded-host'] || headers.host || 'soulstarter.vercel.app').trim();
  const proto = String(headers['x-forwarded-proto'] || 'https').trim();
  return `${proto}://${host}`;
}

function asJson(value) {
  return JSON.stringify(value, null, 2);
}

function soulResourceUri(id) {
  return `soulstarter://souls/${encodeURIComponent(String(id || ''))}`;
}

export async function getMcpResourcesList(context = {}) {
  const souls = await listSoulsCatalog({});
  const docs = [
    {
      uri: 'soulstarter://docs/manifest',
      name: 'MCP Manifest',
      description: 'Machine-readable capability contract',
      mimeType: 'application/json'
    },
    {
      uri: 'soulstarter://docs/webmcp',
      name: 'WebMCP Markdown',
      description: 'Human-readable MCP + x402 contract',
      mimeType: 'text/markdown'
    },
    {
      uri: 'soulstarter://souls',
      name: 'Public Soul Catalog',
      description: 'Publicly listed soul summaries',
      mimeType: 'application/json'
    }
  ];

  const soulResources = souls.map((soul) => ({
    uri: soulResourceUri(soul.id),
    name: String(soul.name || soul.id || ''),
    description: `${String(soul.description || 'Soul listing')}`,
    mimeType: 'application/json'
  }));

  return [...docs, ...soulResources];
}

export async function readMcpResource(uri, context = {}) {
  const normalizedUri = String(uri || '').trim();
  if (!normalizedUri) {
    throw new AppError(400, { error: 'Missing required field: uri', code: 'missing_resource_uri' });
  }

  const baseUrl = baseUrlFromHeaders(context.headers || {});

  if (normalizedUri === 'soulstarter://docs/manifest') {
    return {
      uri: normalizedUri,
      mimeType: 'application/json',
      text: asJson({
        endpoint: '/mcp',
        manifest: `${baseUrl}/api/mcp/manifest`,
        webmcp_markdown: `${baseUrl}/WEBMCP.md`
      })
    };
  }

  if (normalizedUri === 'soulstarter://docs/webmcp') {
    return {
      uri: normalizedUri,
      mimeType: 'text/markdown',
      text: `Read the full contract at ${baseUrl}/WEBMCP.md`
    };
  }

  if (normalizedUri === 'soulstarter://souls') {
    const souls = await listSoulsCatalog({});
    return {
      uri: normalizedUri,
      mimeType: 'application/json',
      text: asJson({ count: souls.length, souls })
    };
  }

  if (normalizedUri.startsWith('soulstarter://souls/')) {
    const id = decodeURIComponent(normalizedUri.slice('soulstarter://souls/'.length));
    const details = await resolveSoulDetails(id);
    const body = buildMcpSoulDetailsResponse(details);
    return {
      uri: normalizedUri,
      mimeType: 'application/json',
      text: asJson(body)
    };
  }

  throw new AppError(404, {
    error: 'Unknown MCP resource',
    code: 'mcp_resource_not_found',
    uri: normalizedUri
  });
}

const MCP_PROMPTS = [
  {
    name: 'purchase_soul',
    description: 'Canonical x402 purchase flow for a soul',
    arguments: [
      { name: 'soul_id', required: true, description: 'Soul identifier' },
      { name: 'wallet_address', required: true, description: 'Buyer wallet address' }
    ]
  },
  {
    name: 'redownload_soul',
    description: 'Strict no-repay re-download flow using receipt + wallet signature',
    arguments: [
      { name: 'soul_id', required: true, description: 'Soul identifier' },
      { name: 'wallet_address', required: true, description: 'Buyer wallet address' },
      { name: 'purchase_receipt', required: true, description: 'Saved X-PURCHASE-RECEIPT value' }
    ]
  },
  {
    name: 'publish_listing',
    description: 'Immediate creator publish flow with SIWE ownership auth',
    arguments: [
      { name: 'wallet_address', required: true, description: 'Creator wallet address' },
      { name: 'name', required: true, description: 'Soul listing name' },
      { name: 'price_usdc', required: true, description: 'Price in USDC' },
      { name: 'description', required: true, description: 'Buyer-facing summary' }
    ]
  }
];

export function getMcpPromptsList() {
  return MCP_PROMPTS;
}

export function getMcpPrompt(name, args = {}) {
  const promptName = String(name || '').trim();
  const parsedArgs = args && typeof args === 'object' ? args : {};

  if (promptName === 'purchase_soul') {
    const soulId = String(parsedArgs.soul_id || '<soul_id>');
    const wallet = String(parsedArgs.wallet_address || '<wallet_address>');
    return {
      name: promptName,
      description: 'Canonical x402 purchase flow',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Purchase soul ${soulId} with wallet ${wallet}.`,
              '1) GET /api/souls/{id}/download with X-CLIENT-MODE: agent + X-WALLET-ADDRESS.',
              '2) Read 402 PAYMENT-REQUIRED and sign per payment_signing_instructions.',
              '3) Retry GET /api/souls/{id}/download with PAYMENT-SIGNATURE.',
              '4) Persist X-PURCHASE-RECEIPT from successful 200 response.'
            ].join('\n')
          }
        }
      ]
    };
  }

  if (promptName === 'redownload_soul') {
    const soulId = String(parsedArgs.soul_id || '<soul_id>');
    const wallet = String(parsedArgs.wallet_address || '<wallet_address>');
    return {
      name: promptName,
      description: 'Strict no-repay re-download flow',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Re-download soul ${soulId} with wallet ${wallet} without repaying.`,
              '1) Get SIWE template from get_auth_challenge(flow=redownload).',
              '2) Sign exact SIWE message text.',
              '3) Send GET /api/souls/{id}/download with X-CLIENT-MODE, X-WALLET-ADDRESS, X-PURCHASE-RECEIPT, X-REDOWNLOAD-SIGNATURE, X-REDOWNLOAD-TIMESTAMP.'
            ].join('\n')
          }
        }
      ]
    };
  }

  if (promptName === 'publish_listing') {
    const wallet = String(parsedArgs.wallet_address || '<wallet_address>');
    return {
      name: promptName,
      description: 'Immediate creator publish flow',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Publish a listing as wallet ${wallet}.`,
              '1) Call get_auth_challenge(flow=creator, action=publish_listing).',
              '2) Sign exact SIWE message and use auth_timestamp = Date.parse(Issued At).',
              '3) Call tools/call name=publish_listing with wallet_address, auth_signature, auth_timestamp, listing.'
            ].join('\n')
          }
        }
      ]
    };
  }

  throw new AppError(404, {
    error: 'Unknown MCP prompt',
    code: 'mcp_prompt_not_found',
    prompt_name: promptName
  });
}
