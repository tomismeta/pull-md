import {
  buildMcpListSoulsResponse,
  buildMcpSoulDetailsResponse,
  checkReceiptEntitlements,
  listSoulsCatalog,
  resolveSoulDetails
} from './services/souls.js';
import { executeCreatorMarketplaceAction } from './services/creator_marketplace.js';
import { AppError } from './errors.js';

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
      endpoint: '/api/mcp/tools/list_souls',
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
      endpoint: '/api/mcp/tools/get_soul_details',
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
      endpoint: '/api/mcp/tools/check_entitlements',
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
    name: 'get_listing_template',
    description: 'Get immediate publish payload template for creator soul listings',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    manifest: {
      endpoint: '/api/mcp/tools/creator_marketplace',
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
      endpoint: '/api/mcp/tools/creator_marketplace',
      method: 'POST',
      parameters: {
        action: { type: 'string', required: true, description: 'Set action=publish_listing' },
        wallet_address: { type: 'string', required: true, description: 'Creator wallet address' },
        auth_signature: { type: 'string', required: true, description: 'Wallet signature over creator auth message' },
        auth_timestamp: { type: 'number', required: true, description: 'Unix ms timestamp used in auth message' },
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
      endpoint: '/api/mcp/tools/creator_marketplace',
      method: 'GET',
      parameters: {
        action: { type: 'string', required: true, description: 'Set action=list_my_published_listings' }
      },
      auth_headers: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP'],
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
      endpoint: '/api/mcp/tools/creator_marketplace',
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
      endpoint: '/api/mcp/tools/creator_marketplace',
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
      endpoint: '/api/mcp/tools/creator_marketplace',
      method: 'GET',
      admin_only: true,
      auth_headers: ['X-MODERATOR-ADDRESS', 'X-MODERATOR-SIGNATURE', 'X-MODERATOR-TIMESTAMP'],
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
      endpoint: '/api/mcp/tools/creator_marketplace',
      method: 'POST',
      admin_only: true,
      auth_headers: ['X-MODERATOR-ADDRESS', 'X-MODERATOR-SIGNATURE', 'X-MODERATOR-TIMESTAMP'],
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
    endpoint: tool.manifest.endpoint,
    method: tool.manifest.method,
    ...(tool.manifest.parameters ? { parameters: tool.manifest.parameters } : {}),
    ...(tool.manifest.auth_headers ? { auth_headers: tool.manifest.auth_headers } : {}),
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

