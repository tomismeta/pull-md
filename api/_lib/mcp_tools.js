import {
  buildMcpListSoulsResponse,
  buildMcpSoulDetailsResponse,
  checkReceiptEntitlements,
  listSoulsCatalog,
  resolveSoulDetails
} from './services/souls.js';
import { executeCreatorMarketplaceAction } from './services/creator_marketplace.js';
import { AppError } from './errors.js';
import { buildCreatorAuthMessage, buildModeratorAuthMessage } from './marketplace.js';
import { buildSiweAuthMessage } from './payments.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

function ensureObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function ensureString(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new AppError(400, { error: `Missing required field: ${field}` });
  }
  return normalized;
}

function ensureWalletAddress(value) {
  const wallet = String(value || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/i.test(wallet)) {
    throw new AppError(400, {
      error: 'Invalid or missing wallet_address',
      code: 'invalid_wallet_address',
      flow_hint: 'Provide wallet_address as a valid 0x-prefixed 40-byte EVM address.'
    });
  }
  return wallet;
}

function parseSiweField(message, label) {
  const match = String(message || '').match(new RegExp(`^${label}:\\s*([^\\n\\r]+)`, 'm'));
  return match?.[1]?.trim() || null;
}

function mapCreatorActionToTool(action) {
  if (action === 'publish_listing') return 'publish_listing';
  if (action === 'list_my_published_listings') return 'list_my_published_listings';
  return 'list_my_published_listings';
}

function mapModeratorActionToTool(action) {
  if (action === 'remove_listing_visibility') return 'remove_listing_visibility';
  if (action === 'list_moderation_listings') return 'list_moderation_listings';
  return 'list_moderation_listings';
}

function buildAuthChallengePayload(args = {}) {
  const parsed = ensureObject(args);
  const flow = String(parsed.flow || '').trim().toLowerCase();
  if (!flow) {
    throw new AppError(400, {
      error: 'Missing required field: flow',
      code: 'missing_auth_challenge_flow',
      flow_hint: 'Set flow to one of: creator, moderator, session, redownload.'
    });
  }

  const wallet = ensureWalletAddress(parsed.wallet_address);
  const timestampMs = Date.now();
  const soulIdRaw = String(parsed.soul_id || '').trim();
  const soulId = soulIdRaw || '*';

  let action;
  let authMessage;
  let submitVia;

  if (flow === 'creator') {
    action = String(parsed.action || 'list_my_published_listings').trim() || 'list_my_published_listings';
    authMessage = buildCreatorAuthMessage({ wallet, action, timestamp: timestampMs });
    const toolName = mapCreatorActionToTool(action);
    submitVia = {
      endpoint: '/mcp',
      rpc_method: 'tools/call',
      tool_name: toolName,
      arguments_template:
        toolName === 'publish_listing'
          ? {
              wallet_address: wallet,
              auth_signature: '0x<signature_hex>',
              auth_timestamp: '<Date.parse(Issued At)>',
              listing: {
                name: '<name>',
                description: '<description>',
                price_usdc: 0.01,
                soul_markdown: '# SOUL\\n\\n...'
              }
            }
          : {
              wallet_address: wallet,
              auth_signature: '0x<signature_hex>',
              auth_timestamp: '<Date.parse(Issued At)>'
            }
    };
  } else if (flow === 'moderator') {
    action = String(parsed.action || 'list_moderation_listings').trim() || 'list_moderation_listings';
    authMessage = buildModeratorAuthMessage({ wallet, action, timestamp: timestampMs });
    const toolName = mapModeratorActionToTool(action);
    submitVia = {
      endpoint: '/mcp',
      rpc_method: 'tools/call',
      tool_name: toolName,
      arguments_template:
        toolName === 'remove_listing_visibility'
          ? {
              moderator_address: wallet,
              moderator_signature: '0x<signature_hex>',
              moderator_timestamp: '<Date.parse(Issued At)>',
              soul_id: '<soul_id>',
              reason: '<optional_reason>'
            }
          : {
              moderator_address: wallet,
              moderator_signature: '0x<signature_hex>',
              moderator_timestamp: '<Date.parse(Issued At)>'
            }
    };
  } else if (flow === 'session') {
    action = 'session';
    authMessage = buildSiweAuthMessage({ wallet, soulId: '*', action, timestamp: timestampMs });
    submitVia = {
      endpoint: '/api/auth/session',
      method: 'GET',
      required_headers: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP'],
      headers_template: {
        'X-WALLET-ADDRESS': wallet,
        'X-AUTH-SIGNATURE': '0x<signature_hex>',
        'X-AUTH-TIMESTAMP': '<Date.parse(Issued At)>'
      }
    };
  } else if (flow === 'redownload') {
    action = 'redownload';
    if (!soulIdRaw) {
      throw new AppError(400, {
        error: 'Missing required field: soul_id',
        code: 'missing_redownload_soul_id',
        flow_hint: 'flow=redownload requires soul_id.'
      });
    }
    authMessage = buildSiweAuthMessage({ wallet, soulId, action, timestamp: timestampMs });
    submitVia = {
      endpoint: `/api/souls/${encodeURIComponent(soulId)}/download`,
      method: 'GET',
      required_headers: [
        'X-CLIENT-MODE',
        'X-WALLET-ADDRESS',
        'X-PURCHASE-RECEIPT',
        'X-REDOWNLOAD-SIGNATURE',
        'X-REDOWNLOAD-TIMESTAMP'
      ],
      headers_template: {
        'X-CLIENT-MODE': 'agent',
        'X-WALLET-ADDRESS': wallet,
        'X-PURCHASE-RECEIPT': '<receipt_token>',
        'X-REDOWNLOAD-SIGNATURE': '0x<signature_hex>',
        'X-REDOWNLOAD-TIMESTAMP': '<Date.parse(Issued At)>'
      }
    };
  } else {
    throw new AppError(400, {
      error: 'Unsupported auth challenge flow',
      code: 'unsupported_auth_challenge_flow',
      flow,
      supported_flows: ['creator', 'moderator', 'session', 'redownload']
    });
  }

  const issuedAt = parseSiweField(authMessage, 'Issued At') || new Date(timestampMs).toISOString();
  const expiresAt = parseSiweField(authMessage, 'Expiration Time') || new Date(timestampMs + 300000).toISOString();
  const nonce = parseSiweField(authMessage, 'Nonce');
  const requestId = parseSiweField(authMessage, 'Request ID');
  const authTimestampMs = Date.parse(issuedAt);

  return {
    ok: true,
    auth_format: 'siwe_eip4361_message',
    flow,
    action,
    soul_id: flow === 'redownload' ? soulId : null,
    wallet_address: wallet,
    auth_message_template: authMessage,
    nonce,
    request_id: requestId,
    issued_at: issuedAt,
    expiration_time: expiresAt,
    auth_timestamp_ms: Number.isFinite(authTimestampMs) ? authTimestampMs : timestampMs,
    timestamp_requirement:
      'Use auth_timestamp = Date.parse(Issued At) from this same auth_message_template. Do not use Date.now().',
    common_mistakes: [
      'Do not reconstruct SIWE manually. Sign the exact template text.',
      'Do not use current time for auth_timestamp; use Date.parse(Issued At).',
      'Use lowercase wallet address in arguments/headers.'
    ],
    submit_via: submitVia
  };
}

function toolCallHeadersFromArgs(context, args, authShape = 'none') {
  const baseHeaders = {
    host: context?.headers?.host || 'soulstarter.vercel.app',
    'x-forwarded-host': context?.headers?.['x-forwarded-host'] || context?.headers?.host || 'soulstarter.vercel.app',
    'x-forwarded-proto': context?.headers?.['x-forwarded-proto'] || 'https'
  };
  const parsedArgs = ensureObject(args);

  if (authShape === 'creator') {
    baseHeaders['x-wallet-address'] = String(parsedArgs.wallet_address || '').trim();
    baseHeaders['x-auth-signature'] = String(parsedArgs.auth_signature || '').trim();
    baseHeaders['x-auth-timestamp'] = String(parsedArgs.auth_timestamp || '').trim();
  } else if (authShape === 'moderator') {
    baseHeaders['x-moderator-address'] = String(parsedArgs.moderator_address || '').trim();
    baseHeaders['x-moderator-signature'] = String(parsedArgs.moderator_signature || '').trim();
    baseHeaders['x-moderator-timestamp'] = String(parsedArgs.moderator_timestamp || '').trim();
  }

  return baseHeaders;
}

const MCP_TOOL_REGISTRY = [
  {
    name: 'list_souls',
    description: 'List available souls and pricing',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Optional category filter' }
      },
      additionalProperties: false
    },
    manifest: {
      endpoint: '/mcp',
      method: 'GET',
      parameters: {
        category: { type: 'string', required: false, description: 'Optional category filter' }
      },
      returns: { type: 'object', description: 'Soul list with metadata and pricing' }
    },
    async run(args) {
      const category = String(args?.category || '').trim();
      const souls = await listSoulsCatalog({ category: category || undefined });
      return buildMcpListSoulsResponse(souls);
    }
  },
  {
    name: 'get_soul_details',
    description: 'Get full metadata, auth message examples, and purchase endpoint for one soul',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Soul identifier' }
      },
      required: ['id'],
      additionalProperties: false
    },
    manifest: {
      endpoint: '/mcp',
      method: 'GET',
      parameters: {
        id: { type: 'string', required: true, description: 'Soul identifier' }
      },
      returns: { type: 'object', description: 'Soul details and x402 interaction contract' }
    },
    async run(args) {
      const details = await resolveSoulDetails(args?.id);
      return buildMcpSoulDetailsResponse(details);
    }
  },
  {
    name: 'check_entitlements',
    description: 'Verify receipt proofs for wallet re-download entitlement',
    inputSchema: {
      type: 'object',
      properties: {
        wallet_address: { type: 'string' },
        proofs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              soul_id: { type: 'string' },
              receipt: { type: 'string' }
            },
            required: ['soul_id', 'receipt'],
            additionalProperties: false
          }
        }
      },
      required: ['wallet_address', 'proofs'],
      additionalProperties: false
    },
    manifest: {
      endpoint: '/mcp',
      method: 'POST',
      parameters: {
        wallet_address: { type: 'string', required: true, description: 'Wallet to check' },
        proofs: { type: 'array', required: true, description: 'List of { soul_id, receipt } proofs' }
      },
      returns: { type: 'object', description: 'Per-proof entitlement status' }
    },
    async run(args) {
      return checkReceiptEntitlements({
        walletAddress: args?.wallet_address,
        proofs: args?.proofs
      });
    }
  },
  {
    name: 'get_auth_challenge',
    description: 'Get a SIWE auth challenge upfront for creator, moderator, session, or redownload flows',
    inputSchema: {
      type: 'object',
      properties: {
        flow: {
          type: 'string',
          description: 'One of: creator, moderator, session, redownload'
        },
        wallet_address: { type: 'string', description: 'Wallet address used to sign the challenge' },
        action: { type: 'string', description: 'Action name for creator/moderator flows' },
        soul_id: { type: 'string', description: 'Required when flow=redownload' }
      },
      required: ['flow', 'wallet_address'],
      additionalProperties: false
    },
    manifest: {
      endpoint: '/mcp',
      method: 'POST',
      parameters: {
        flow: { type: 'string', required: true, description: 'creator|moderator|session|redownload' },
        wallet_address: { type: 'string', required: true, description: 'Wallet used for SIWE signing' },
        action: { type: 'string', required: false, description: 'Action name (creator/moderator only)' },
        soul_id: { type: 'string', required: false, description: 'Required for redownload flow' }
      },
      returns: { type: 'object', description: 'SIWE challenge template + exact timestamp/signing guidance' }
    },
    async run(args) {
      return buildAuthChallengePayload(args);
    }
  },
  {
    name: 'get_listing_template',
    description: 'Get immediate publish payload template for creator soul listings',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    manifest: {
      endpoint: '/mcp',
      method: 'GET',
      parameters: {
        action: { type: 'string', required: true, description: 'Set action=get_listing_template' }
      },
      returns: { type: 'object', description: 'Template payload for immediate creator publish contract' }
    },
    async run(_args, context) {
      return executeCreatorMarketplaceAction({
        action: 'get_listing_template',
        method: 'GET',
        headers: toolCallHeadersFromArgs(context, {})
      });
    }
  },
  {
    name: 'publish_listing',
    description: 'Creator-auth immediate publish. Returns shareable soul URL and purchase endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        wallet_address: { type: 'string' },
        auth_signature: { type: 'string' },
        auth_timestamp: { type: ['number', 'string'] },
        listing: { type: 'object' }
      },
      required: ['wallet_address', 'auth_signature', 'auth_timestamp', 'listing'],
      additionalProperties: false
    },
    manifest: {
      endpoint: '/mcp',
      method: 'POST',
      parameters: {
        action: { type: 'string', required: true, description: 'Set action=publish_listing' },
        wallet_address: { type: 'string', required: true, description: 'Creator wallet address' },
        auth_signature: { type: 'string', required: true, description: 'Wallet signature over creator auth message' },
        auth_timestamp: {
          type: 'string',
          required: true,
          description: 'Timestamp from SIWE Issued At (accepts Unix ms or ISO-8601)'
        },
        listing: { type: 'object', required: true, description: 'Minimal publish payload: name, price_usdc, description, soul_markdown' }
      },
      returns: { type: 'object', description: 'Published listing summary + share_url + purchase endpoint' }
    },
    async run(args, context) {
      const parsed = ensureObject(args);
      return executeCreatorMarketplaceAction({
        action: 'publish_listing',
        method: 'POST',
        headers: toolCallHeadersFromArgs(context, parsed, 'creator'),
        body: {
          wallet_address: ensureString(parsed.wallet_address, 'wallet_address'),
          auth_signature: ensureString(parsed.auth_signature, 'auth_signature'),
          auth_timestamp: parsed.auth_timestamp,
          listing: ensureObject(parsed.listing)
        }
      });
    }
  },
  {
    name: 'list_my_published_listings',
    description: 'List creator-owned published listings (including hidden listings)',
    inputSchema: {
      type: 'object',
      properties: {
        wallet_address: { type: 'string' },
        auth_signature: { type: 'string' },
        auth_timestamp: { type: ['number', 'string'] }
      },
      required: ['wallet_address', 'auth_signature', 'auth_timestamp'],
      additionalProperties: false
    },
    manifest: {
      endpoint: '/mcp',
      method: 'GET',
      parameters: {
        action: { type: 'string', required: true, description: 'Set action=list_my_published_listings' }
      },
      auth_headers: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP'],
      auth_notes: ['X-AUTH-TIMESTAMP accepts Unix ms or ISO-8601 (must match SIWE Issued At)'],
      returns: { type: 'object', description: 'Wallet-scoped list of published listing summaries' }
    },
    async run(args, context) {
      const parsed = ensureObject(args);
      return executeCreatorMarketplaceAction({
        action: 'list_my_published_listings',
        method: 'GET',
        headers: toolCallHeadersFromArgs(context, parsed, 'creator')
      });
    }
  },
  {
    name: 'list_published_listings',
    description: 'Public list of currently visible published listings',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    manifest: {
      endpoint: '/mcp',
      method: 'GET',
      parameters: {
        action: { type: 'string', required: true, description: 'Set action=list_published_listings' }
      },
      returns: { type: 'object', description: 'Public listing summaries for discoverability and purchase' }
    },
    async run(_args, context) {
      return executeCreatorMarketplaceAction({
        action: 'list_published_listings',
        method: 'GET',
        headers: toolCallHeadersFromArgs(context, {})
      });
    }
  },
  {
    name: 'list_moderators',
    description: 'List allowlisted moderator wallet addresses',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    manifest: {
      endpoint: '/mcp',
      method: 'GET',
      parameters: {
        action: { type: 'string', required: true, description: 'Set action=list_moderators' }
      },
      returns: { type: 'object', description: 'Allowlisted moderator wallet addresses' }
    },
    async run(_args, context) {
      return executeCreatorMarketplaceAction({
        action: 'list_moderators',
        method: 'GET',
        headers: toolCallHeadersFromArgs(context, {})
      });
    }
  },
  {
    name: 'list_moderation_listings',
    description: 'Moderator-only list of visible and hidden listings',
    inputSchema: {
      type: 'object',
      properties: {
        moderator_address: { type: 'string' },
        moderator_signature: { type: 'string' },
        moderator_timestamp: { type: ['number', 'string'] }
      },
      required: ['moderator_address', 'moderator_signature', 'moderator_timestamp'],
      additionalProperties: false
    },
    manifest: {
      endpoint: '/mcp',
      method: 'GET',
      admin_only: true,
      auth_headers: ['X-MODERATOR-ADDRESS', 'X-MODERATOR-SIGNATURE', 'X-MODERATOR-TIMESTAMP'],
      auth_notes: ['X-MODERATOR-TIMESTAMP accepts Unix ms or ISO-8601 (must match SIWE Issued At)'],
      parameters: {
        action: { type: 'string', required: true, description: 'Set action=list_moderation_listings' }
      },
      returns: { type: 'object', description: 'Listing partitions for moderation visibility actions' }
    },
    async run(args, context) {
      const parsed = ensureObject(args);
      return executeCreatorMarketplaceAction({
        action: 'list_moderation_listings',
        method: 'GET',
        headers: toolCallHeadersFromArgs(context, parsed, 'moderator')
      });
    }
  },
  {
    name: 'remove_listing_visibility',
    description: 'Moderator-only action to remove a listing from public visibility',
    inputSchema: {
      type: 'object',
      properties: {
        moderator_address: { type: 'string' },
        moderator_signature: { type: 'string' },
        moderator_timestamp: { type: ['number', 'string'] },
        soul_id: { type: 'string' },
        reason: { type: 'string' }
      },
      required: ['moderator_address', 'moderator_signature', 'moderator_timestamp', 'soul_id'],
      additionalProperties: false
    },
    manifest: {
      endpoint: '/mcp',
      method: 'POST',
      admin_only: true,
      auth_headers: ['X-MODERATOR-ADDRESS', 'X-MODERATOR-SIGNATURE', 'X-MODERATOR-TIMESTAMP'],
      auth_notes: ['X-MODERATOR-TIMESTAMP accepts Unix ms or ISO-8601 (must match SIWE Issued At)'],
      parameters: {
        action: { type: 'string', required: true, description: 'Set action=remove_listing_visibility' },
        soul_id: { type: 'string', required: true, description: 'Published soul identifier to hide' },
        reason: { type: 'string', required: false, description: 'Optional moderation reason for audit trail' }
      },
      returns: { type: 'object', description: 'Updated listing visibility state' }
    },
    async run(args, context) {
      const parsed = ensureObject(args);
      return executeCreatorMarketplaceAction({
        action: 'remove_listing_visibility',
        method: 'POST',
        headers: toolCallHeadersFromArgs(context, parsed, 'moderator'),
        body: {
          soul_id: ensureString(parsed.soul_id, 'soul_id'),
          reason: typeof parsed.reason === 'string' ? parsed.reason : ''
        }
      });
    }
  }
];

export function getMcpToolRegistry() {
  return MCP_TOOL_REGISTRY;
}

export function getMcpToolsForManifest() {
  return MCP_TOOL_REGISTRY.map((tool) => ({
    name: tool.name,
    description: tool.description,
    endpoint: '/mcp',
    method: 'POST',
    rpc_method: 'tools/call',
    rpc_tool_name: tool.name,
    arguments_schema: tool.inputSchema || { type: 'object', properties: {} },
    ...(tool.manifest.auth_headers ? { auth_headers: tool.manifest.auth_headers } : {}),
    ...(tool.manifest.auth_notes ? { auth_notes: tool.manifest.auth_notes } : {}),
    ...(tool.manifest.admin_only ? { admin_only: true } : {}),
    ...(tool.manifest.returns ? { returns: tool.manifest.returns } : {})
  }));
}

export function getMcpToolsListResult() {
  return MCP_TOOL_REGISTRY.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema || { type: 'object', properties: {} }
  }));
}

export async function invokeMcpTool(name, args, context = {}) {
  const tool = MCP_TOOL_REGISTRY.find((entry) => entry.name === name);
  if (!tool) {
    throw new AppError(404, {
      error: 'Unknown MCP tool',
      code: 'mcp_tool_not_found',
      tool_name: String(name || '')
    });
  }
  return tool.run(args || {}, context);
}
