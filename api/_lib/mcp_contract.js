import { AppError } from './errors.js';
import {
  buildMcpAssetDetailsResponse,
  listAssetsCatalog,
  resolveAssetDetails
} from './services/souls.js';

function baseUrlFromHeaders(headers = {}) {
  const host = String(headers['x-forwarded-host'] || headers.host || 'soulstarter.vercel.app').trim();
  const proto = String(headers['x-forwarded-proto'] || 'https').trim();
  return `${proto}://${host}`;
}

function asJson(value) {
  return JSON.stringify(value, null, 2);
}

function assetResourceUri(id) {
  return `soulstarter://assets/${encodeURIComponent(String(id || ''))}`;
}

function soulResourceUri(id) {
  return `soulstarter://souls/${encodeURIComponent(String(id || ''))}`;
}

export async function getMcpResourcesList() {
  const assets = await listAssetsCatalog({});
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
      uri: 'soulstarter://assets',
      name: 'Public Asset Catalog',
      description: 'Publicly listed markdown asset summaries',
      mimeType: 'application/json'
    },
    {
      uri: 'soulstarter://souls',
      name: 'Public Soul Catalog',
      description: 'Legacy alias for soulstarter://assets',
      mimeType: 'application/json'
    }
  ];

  const assetResources = assets.flatMap((asset) => [
    {
      uri: assetResourceUri(asset.id),
      name: String(asset.name || asset.id || ''),
      description: `${String(asset.description || 'Asset listing')}`,
      mimeType: 'application/json'
    },
    {
      uri: soulResourceUri(asset.id),
      name: `${String(asset.name || asset.id || '')} (Legacy Soul URI)`,
      description: 'Legacy alias for soulstarter://assets/{id}',
      mimeType: 'application/json'
    }
  ]);

  return [...docs, ...assetResources];
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

  if (normalizedUri === 'soulstarter://assets' || normalizedUri === 'soulstarter://souls') {
    const assets = await listAssetsCatalog({});
    return {
      uri: normalizedUri,
      mimeType: 'application/json',
      text: asJson({ count: assets.length, assets, souls: assets })
    };
  }

  if (normalizedUri.startsWith('soulstarter://assets/') || normalizedUri.startsWith('soulstarter://souls/')) {
    const prefix = normalizedUri.startsWith('soulstarter://assets/')
      ? 'soulstarter://assets/'
      : 'soulstarter://souls/';
    const id = decodeURIComponent(normalizedUri.slice(prefix.length));
    const details = await resolveAssetDetails(id);
    const body = buildMcpAssetDetailsResponse(details);
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
    name: 'purchase_asset',
    description: 'Canonical x402 purchase flow for a markdown asset',
    arguments: [
      { name: 'asset_id', required: true, description: 'Asset identifier' },
      { name: 'wallet_address', required: true, description: 'Buyer wallet address' }
    ]
  },
  {
    name: 'redownload_asset',
    description: 'Strict no-repay re-download flow using receipt + wallet signature',
    arguments: [
      { name: 'asset_id', required: true, description: 'Asset identifier' },
      { name: 'wallet_address', required: true, description: 'Buyer wallet address' },
      {
        name: 'purchase_receipt',
        required: true,
        description: 'Saved X-PURCHASE-RECEIPT value (persist securely and do not expose in logs)'
      }
    ]
  },
  {
    name: 'publish_listing',
    description: 'Immediate creator publish flow with SIWE ownership auth',
    arguments: [
      { name: 'wallet_address', required: true, description: 'Creator wallet address' },
      { name: 'name', required: true, description: 'Listing name' },
      { name: 'price_usdc', required: true, description: 'Price in USDC' },
      { name: 'description', required: true, description: 'Buyer-facing summary' }
    ]
  },
  {
    name: 'purchase_soul',
    description: 'Legacy alias for purchase_asset',
    arguments: [
      { name: 'soul_id', required: true, description: 'Legacy alias for asset_id' },
      { name: 'wallet_address', required: true, description: 'Buyer wallet address' }
    ]
  },
  {
    name: 'redownload_soul',
    description: 'Legacy alias for redownload_asset',
    arguments: [
      { name: 'soul_id', required: true, description: 'Legacy alias for asset_id' },
      { name: 'wallet_address', required: true, description: 'Buyer wallet address' },
      {
        name: 'purchase_receipt',
        required: true,
        description: 'Saved X-PURCHASE-RECEIPT value'
      }
    ]
  }
];

export function getMcpPromptsList() {
  return MCP_PROMPTS;
}

function resolvePromptAssetId(args = {}) {
  const parsedArgs = args && typeof args === 'object' ? args : {};
  return String(parsedArgs.asset_id || parsedArgs.soul_id || '<asset_id>');
}

export function getMcpPrompt(name, args = {}) {
  const promptName = String(name || '').trim();
  const parsedArgs = args && typeof args === 'object' ? args : {};
  const wallet = String(parsedArgs.wallet_address || '<wallet_address>');

  if (promptName === 'purchase_asset' || promptName === 'purchase_soul') {
    const assetId = resolvePromptAssetId(parsedArgs);
    return {
      name: promptName,
      description: 'Canonical x402 purchase flow',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Purchase asset ${assetId} with wallet ${wallet}.`,
              '1) GET /api/assets/{id}/download with X-CLIENT-MODE: agent + X-WALLET-ADDRESS.',
              '2) Read 402 PAYMENT-REQUIRED and sign per payment_signing_instructions.',
              '3) Retry GET /api/assets/{id}/download with PAYMENT-SIGNATURE.',
              '4) Persist X-PURCHASE-RECEIPT from successful 200 response.',
              '5) Treat X-PURCHASE-RECEIPT as wallet-scoped secret proof for re-download. Do not print, publish, or share it.',
              'Legacy alias endpoint remains available at /api/souls/{id}/download.'
            ].join('\n')
          }
        }
      ]
    };
  }

  if (promptName === 'redownload_asset' || promptName === 'redownload_soul') {
    const assetId = resolvePromptAssetId(parsedArgs);
    return {
      name: promptName,
      description: 'Strict no-repay re-download flow',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Re-download asset ${assetId} with wallet ${wallet} without repaying.`,
              '1) Get SIWE template from get_auth_challenge(flow=redownload).',
              '2) Sign exact SIWE message text.',
              '3) Send GET /api/assets/{id}/download with X-CLIENT-MODE, X-WALLET-ADDRESS, X-PURCHASE-RECEIPT, X-REDOWNLOAD-SIGNATURE, X-REDOWNLOAD-TIMESTAMP.',
              '4) Keep X-PURCHASE-RECEIPT in secure storage; it is required proof for strict no-repay re-download.'
            ].join('\n')
          }
        }
      ]
    };
  }

  if (promptName === 'publish_listing') {
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
