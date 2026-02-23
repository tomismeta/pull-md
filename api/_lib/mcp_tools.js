import {
  buildMcpAssetDetailsResponse,
  buildMcpListAssetsResponse,
  checkReceiptEntitlements,
  listAssetsCatalog,
  resolveAssetDetails
} from './services/assets.js';
import { executeCreatorMarketplaceAction } from './services/creator_marketplace.js';
import { AppError } from './errors.js';
import { buildCreatorAuthMessage, buildModeratorAuthMessage, getMarketplaceDraftTemplate } from './marketplace.js';
import { buildSiweAuthMessage, resolveSiweIdentity } from './payments.js';

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
  return 'publish_listing';
}

function normalizeCreatorAction(action) {
  const normalized = String(action || '').trim();
  if (!normalized) return 'publish_listing';
  if (normalized === 'publish_listing') return normalized;
  if (normalized === 'list_my_published_listings') return normalized;
  throw new AppError(400, {
    error: 'Unsupported creator action for get_auth_challenge',
    code: 'unsupported_creator_auth_action',
    action: normalized,
    supported_actions: ['publish_listing', 'list_my_published_listings'],
    flow_hint: 'Set action to publish_listing (default) or list_my_published_listings.'
  });
}

function normalizeModeratorAction(action) {
  if (action === 'get_telemetry_dashboard') return 'get_telemetry_dashboard';
  if (action === 'rescan_listing') return 'rescan_listing';
  if (action === 'remove_listing_visibility') return 'remove_listing_visibility';
  if (action === 'restore_listing_visibility') return 'restore_listing_visibility';
  if (action === 'update_listing') return 'update_listing';
  if (action === 'delete_listing') return 'delete_listing';
  if (action === 'list_moderation_listings') return 'list_moderation_listings';
  return 'list_moderation_listings';
}

function buildAuthChallengePayload(args = {}, context = {}) {
  const parsed = ensureObject(args);
  const host = String(context?.headers?.['x-forwarded-host'] || context?.headers?.host || 'www.pull.md').trim();
  const proto = String(context?.headers?.['x-forwarded-proto'] || 'https').trim();
  const siweIdentity = resolveSiweIdentity({ host, proto });
  const siweDomain = siweIdentity.domain;
  const siweUri = siweIdentity.uri;
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
  const assetIdRaw = String(parsed.asset_id || '').trim();
  const assetId = assetIdRaw || '*';

  let action;
  let authMessage;
  let submitVia;
  let suggestedListing = null;

  if (flow === 'creator') {
    action = normalizeCreatorAction(parsed.action);
    authMessage = buildCreatorAuthMessage({ wallet, action, timestamp: timestampMs, domain: siweDomain, uri: siweUri });
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
                content_markdown: '# ASSET\\n\\n...'
              }
            }
          : {
              wallet_address: wallet,
              auth_signature: '0x<signature_hex>',
              auth_timestamp: '<Date.parse(Issued At)>'
            }
    };
    if (mapCreatorActionToTool(action) === 'publish_listing') {
      suggestedListing = getMarketplaceDraftTemplate();
    }
  } else if (flow === 'moderator') {
    action = normalizeModeratorAction(String(parsed.action || 'list_moderation_listings').trim() || 'list_moderation_listings');
    authMessage = buildModeratorAuthMessage({ wallet, action, timestamp: timestampMs, domain: siweDomain, uri: siweUri });
    const commonHeaders = {
      moderator_address: wallet,
      moderator_signature: '0x<signature_hex>',
      moderator_timestamp: '<Date.parse(Issued At)>'
    };
    const moderationEndpoint = `/api/moderation?action=${encodeURIComponent(action)}`;
    submitVia = {
      endpoint: moderationEndpoint,
      method: action === 'list_moderation_listings' || action === 'get_telemetry_dashboard' ? 'GET' : 'POST',
      headers_template: commonHeaders,
      body_template:
        action === 'get_telemetry_dashboard'
          ? {
              window_hours: 24,
              row_limit: 10
            }
          : action === 'remove_listing_visibility'
          ? {
              asset_id: '<asset_id>',
              reason: '<optional_reason>'
            }
          : action === 'restore_listing_visibility'
            ? {
                asset_id: '<asset_id>',
                reason: '<optional_reason>'
              }
            : action === 'rescan_listing'
              ? {
                  asset_id: '<asset_id>'
                }
            : action === 'update_listing'
              ? {
                asset_id: '<asset_id>',
                listing: {
                  name: '<updated_name>',
                    description: '<updated_description>',
                    price_usdc: 0.01,
                    content_markdown: '# ASSET\\n\\nUpdated content.'
                  }
                }
              : action === 'delete_listing'
                ? {
                    asset_id: '<asset_id>',
                    reason: '<optional_reason>'
                  }
                : null
    };
  } else if (flow === 'session') {
    action = 'session';
    authMessage = buildSiweAuthMessage({ wallet, soulId: '*', action, timestamp: timestampMs, domain: siweDomain, uri: siweUri });
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
    if (!assetIdRaw) {
      throw new AppError(400, {
        error: 'Missing required field: asset_id',
        code: 'missing_redownload_asset_id',
        flow_hint: 'flow=redownload requires asset_id.'
      });
    }
    authMessage = buildSiweAuthMessage({ wallet, soulId: assetId, action, timestamp: timestampMs, domain: siweDomain, uri: siweUri });
    submitVia = {
      endpoint: `/api/assets/${encodeURIComponent(assetId)}/download`,
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
    asset_id: flow === 'redownload' ? assetId : null,
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
    ...(suggestedListing ? { suggested_listing: suggestedListing } : {}),
    submit_via: submitVia
  };
}

function toolCallHeadersFromArgs(context, args, authShape = 'none') {
  const baseHeaders = {
    host: context?.headers?.host || 'www.pull.md',
    'x-forwarded-host': context?.headers?.['x-forwarded-host'] || context?.headers?.host || 'www.pull.md',
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

function toolTelemetryContext(context = {}) {
  const route = String(context?.route || '/mcp').trim() || '/mcp';
  const source = String(context?.source || 'mcp').trim() || 'mcp';
  const httpMethod = String(context?.httpMethod || 'POST').trim().toUpperCase() || 'POST';
  return { source, route, httpMethod };
}

const MCP_TOOL_REGISTRY = [
  {
    name: 'list_assets',
    description: 'List available markdown assets and pricing',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Optional category filter' },
        asset_type: { type: 'string', description: 'Optional asset type filter (soul, skill)' }
      },
      additionalProperties: false
    },
    manifest: {
      endpoint: '/mcp',
      method: 'GET',
      parameters: {
        category: { type: 'string', required: false, description: 'Optional category filter' },
        asset_type: { type: 'string', required: false, description: 'Optional asset type filter' }
      },
      returns: { type: 'object', description: 'Markdown asset list with metadata and pricing' }
    },
    async run(args) {
      const category = String(args?.category || '').trim();
      const assetType = String(args?.asset_type || '').trim();
      const assets = await listAssetsCatalog({
        category: category || undefined,
        assetType: assetType || undefined
      });
      return buildMcpListAssetsResponse(assets);
    }
  },
  {
    name: 'get_asset_details',
    description: 'Get full metadata, auth message examples, and purchase endpoint for one markdown asset',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Asset identifier' }
      },
      required: ['id'],
      additionalProperties: false
    },
    manifest: {
      endpoint: '/mcp',
      method: 'GET',
      parameters: {
        id: { type: 'string', required: true, description: 'Asset identifier' }
      },
      returns: { type: 'object', description: 'Asset details and x402 interaction contract' }
    },
    async run(args) {
      const details = await resolveAssetDetails(args?.id);
      return buildMcpAssetDetailsResponse(details);
    }
  },
  {
    name: 'check_entitlements',
    description: 'Verify receipt proofs for wallet re-download entitlement (receipt values are sensitive; do not log/share them)',
    inputSchema: {
      type: 'object',
      properties: {
        wallet_address: { type: 'string' },
        proofs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              asset_id: { type: 'string' },
              receipt: { type: 'string' }
            },
            required: ['receipt'],
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
        proofs: {
          type: 'array',
          required: true,
          description: 'List of { asset_id, receipt } proofs (treat receipt as wallet-scoped secret)'
        }
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
        action: {
          type: 'string',
          description: 'Action name for creator/moderator flows. For flow=creator, defaults to publish_listing.'
        },
        asset_id: { type: 'string', description: 'Required when flow=redownload' }
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
        action: {
          type: 'string',
          required: false,
          description: 'Action name (creator/moderator only). For flow=creator, defaults to publish_listing.'
        },
        asset_id: { type: 'string', required: false, description: 'Required for redownload flow' }
      },
      returns: { type: 'object', description: 'SIWE challenge template + exact timestamp/signing guidance' }
    },
    async run(args, context) {
      return buildAuthChallengePayload(args, context);
    }
  },
  {
    name: 'get_listing_template',
    description: 'Get immediate publish payload template for creator markdown asset listings',
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
        headers: toolCallHeadersFromArgs(context, {}),
        telemetryContext: toolTelemetryContext(context)
      });
    }
  },
  {
    name: 'publish_listing',
    description: 'Creator-auth immediate publish. Returns shareable asset URL and purchase endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        wallet_address: { type: 'string' },
        auth_signature: { type: 'string' },
        auth_timestamp: { type: ['number', 'string'] },
        dry_run: {
          type: 'boolean',
          description: 'Validate listing payload without persisting a new published listing.'
        },
        listing: {
          type: 'object',
          description: 'Creator listing payload. Use get_listing_template for canonical structure.',
          properties: {
            name: { type: 'string', minLength: 3, maxLength: 80 },
            description: { type: 'string', minLength: 12, maxLength: 240 },
            price_usdc: { type: 'number', minimum: 0.000001 },
            content_markdown: { type: 'string', minLength: 1, maxLength: 65536 }
          },
          required: ['name', 'description', 'price_usdc', 'content_markdown'],
          additionalProperties: true
        }
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
        dry_run: {
          type: 'boolean',
          required: false,
          description: 'When true, validates payload and returns structured validation result without publishing.'
        },
        listing: { type: 'object', required: true, description: 'Minimal publish payload: name, price_usdc, description, content_markdown' }
      },
      returns: { type: 'object', description: 'Published listing summary + share_url + purchase endpoint' }
    },
    async run(args, context) {
      const parsed = ensureObject(args);
      return executeCreatorMarketplaceAction({
        action: 'publish_listing',
        method: 'POST',
        headers: toolCallHeadersFromArgs(context, parsed, 'creator'),
        telemetryContext: toolTelemetryContext(context),
        body: {
          wallet_address: ensureString(parsed.wallet_address, 'wallet_address'),
          auth_signature: ensureString(parsed.auth_signature, 'auth_signature'),
          auth_timestamp: parsed.auth_timestamp,
          dry_run: parsed.dry_run === true,
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
        headers: toolCallHeadersFromArgs(context, parsed, 'creator'),
        telemetryContext: toolTelemetryContext(context)
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
        headers: toolCallHeadersFromArgs(context, {}),
        telemetryContext: toolTelemetryContext(context)
      });
    }
  },
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

export async function invokeToolRegistry(name, args, context = {}) {
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
