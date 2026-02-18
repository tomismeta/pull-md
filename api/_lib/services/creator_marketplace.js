import {
  buildModeratorAuthMessage,
  buildCreatorAuthMessage,
  getMarketplaceDraftTemplate,
  listModeratorWallets,
  listPublishedListingSummaries,
  publishCreatorListingDirect,
  setListingVisibility,
  verifyCreatorAuth,
  verifyModeratorAuth
} from '../marketplace.js';
import { AppError } from '../errors.js';

const DEPRECATED_ACTIONS = new Set([
  'validate_listing_draft',
  'save_listing_draft',
  'list_my_listing_drafts',
  'get_my_listing_draft',
  'submit_listing_for_review',
  'review_listing_submission',
  'list_review_queue'
]);

function resolveBaseUrl(headers = {}) {
  const host = String(headers['x-forwarded-host'] || headers.host || 'soulstarter.vercel.app').trim();
  const proto = String(headers['x-forwarded-proto'] || 'https').trim();
  return `${proto}://${host}`;
}

function marketplaceStorageWarning() {
  const hasDb = ['MARKETPLACE_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_URL'].some((key) =>
    Boolean(String(process.env[key] || '').trim())
  );
  if (process.env.VERCEL && !hasDb) {
    return 'Persistent creator catalog is not configured. Set MARKETPLACE_DATABASE_URL (or DATABASE_URL/POSTGRES_URL) to enable durable publish/list/download for creator listings.';
  }
  return null;
}

function withShareUrl(baseUrl, listing) {
  const item = listing && typeof listing === 'object' ? listing : {};
  const sharePath = String(item.share_path || '').trim();
  const normalizedPath = sharePath.startsWith('/') ? sharePath : '';
  return {
    ...item,
    share_path: normalizedPath,
    share_url: normalizedPath ? `${baseUrl}${normalizedPath}` : null
  };
}

function creatorAuthError(action, auth) {
  return {
    error: auth.error,
    ...(auth?.hint ? { hint: auth.hint } : {}),
    auth_message_template:
      auth.auth_message_template ||
      buildCreatorAuthMessage({
        wallet: '0x<your-wallet>',
        action,
        timestamp: Date.now()
      })
  };
}

function moderatorAuthError(action, auth) {
  return {
    error: auth.error,
    ...(auth?.hint ? { hint: auth.hint } : {}),
    auth_message_template:
      auth.auth_message_template ||
      buildModeratorAuthMessage({
        wallet: '0x<your-wallet>',
        action,
        timestamp: Date.now()
      }),
    allowed_moderators: listModeratorWallets()
  };
}

function moderatorAuthFromRequest({ headers, body, action }) {
  const wallet = String(headers['x-moderator-address'] || body?.moderator_address || '').trim();
  const signature = String(headers['x-moderator-signature'] || body?.moderator_signature || '').trim();
  const timestamp = headers['x-moderator-timestamp'] || body?.moderator_timestamp;
  return verifyModeratorAuth({ wallet, signature, timestamp, action });
}

function creatorAuthFromHeaders({ headers, body, action }) {
  const wallet = String(headers['x-wallet-address'] || body?.wallet_address || '').trim();
  const signature = String(headers['x-auth-signature'] || body?.auth_signature || '').trim();
  const timestamp = headers['x-auth-timestamp'] || body?.auth_timestamp;
  return verifyCreatorAuth({ wallet, signature, timestamp, action });
}

function ensureAction(action) {
  const normalized = String(action || '').trim();
  if (!normalized) {
    throw new AppError(400, { error: 'Missing required action', endpoint: '/mcp', rpc_method: 'tools/call' });
  }
  return normalized;
}

const AUTO_GENERATED_FIELDS = ['soul_id', 'share_path', 'seller_address'];
const CREATOR_PROVIDED_FIELDS = ['name', 'description', 'price_usdc', 'soul_markdown'];

export function getCreatorMarketplaceSupportedActions() {
  return [
    'get_listing_template',
    'publish_listing',
    'list_my_published_listings',
    'list_published_listings',
    'list_moderators',
    'list_moderation_listings',
    'remove_listing_visibility'
  ];
}

export async function executeCreatorMarketplaceAction({ action, method, headers = {}, body = {} }) {
  const normalizedAction = ensureAction(action);
  const normalizedMethod = String(method || '').toUpperCase();
  const requestBody = body && typeof body === 'object' ? body : {};
  const baseUrl = resolveBaseUrl(headers);

  if (DEPRECATED_ACTIONS.has(normalizedAction)) {
    throw new AppError(410, {
      error: 'Deprecated creator workflow action',
      code: 'creator_workflow_simplified',
      flow_hint:
        'Draft and approval actions were removed. Use publish_listing for immediate publish, then moderate with remove_listing_visibility if needed.',
      supported_actions: getCreatorMarketplaceSupportedActions()
    });
  }

  if (normalizedAction === 'get_listing_template' && normalizedMethod === 'GET') {
    return {
      template: getMarketplaceDraftTemplate(),
      notes: [
        'Immediate publish workflow: name, price_usdc, description, soul_markdown.',
        'No drafts, no approval queue, no publish state transitions.',
        'Successful publish returns a shareable soul page URL.'
      ]
    };
  }

  if (normalizedAction === 'list_moderators' && normalizedMethod === 'GET') {
    const moderators = listModeratorWallets();
    return { count: moderators.length, moderators };
  }

  if (normalizedAction === 'publish_listing' && normalizedMethod === 'GET') {
    throw new AppError(405, {
      error: 'Method not allowed for publish_listing',
      code: 'publish_listing_requires_post',
      flow_hint:
        'Use POST /mcp with JSON-RPC method tools/call and name=publish_listing.',
      required_method: 'POST'
    });
  }

  if (normalizedAction === 'publish_listing' && normalizedMethod === 'POST') {
    const auth = creatorAuthFromHeaders({ headers, body: requestBody, action: normalizedAction });
    if (!auth.ok) {
      throw new AppError(401, creatorAuthError(normalizedAction, auth));
    }

    const listingPayload =
      requestBody.listing && typeof requestBody.listing === 'object'
        ? requestBody.listing
        : requestBody.publish && typeof requestBody.publish === 'object'
          ? requestBody.publish
          : requestBody;
    const dryRun = requestBody.dry_run === true;

    if (dryRun) {
      const result = await publishCreatorListingDirect({
        walletAddress: auth.wallet,
        payload: listingPayload,
        dryRun: true
      });
      return {
        ok: result.ok,
        dry_run: true,
        code: result.code || (result.ok ? 'validated' : 'validation_failed'),
        wallet_address: auth.wallet,
        errors: result.errors || [],
        field_errors: result.field_errors || [],
        warnings: result.warnings || [],
        draft_id: result.draft_id || null,
        ...(result.normalized ? { normalized: result.normalized } : {}),
        auto_generated: AUTO_GENERATED_FIELDS,
        creator_provided: CREATOR_PROVIDED_FIELDS
      };
    }

    const result = await publishCreatorListingDirect({
      walletAddress: auth.wallet,
      payload: listingPayload
    });
    if (!result.ok) {
      const statusCode = result.code === 'marketplace_persistence_unconfigured' ? 503 : 400;
      throw new AppError(statusCode, {
        code: result.code || 'publish_failed',
        ok: false,
        errors: result.errors,
        field_errors: result.field_errors || [],
        warnings: result.warnings,
        draft_id: result.draft_id
      });
    }

    const listing = withShareUrl(baseUrl, result.listing);
    const listingCreated = {
      soul_id: listing.soul_id,
      auto_generated: AUTO_GENERATED_FIELDS,
      creator_provided: CREATOR_PROVIDED_FIELDS
    };
    return {
      ok: true,
      wallet_address: auth.wallet,
      listing,
      listing_created: listingCreated,
      auto_generated: AUTO_GENERATED_FIELDS,
      creator_provided: CREATOR_PROVIDED_FIELDS,
      share_url: listing.share_url,
      purchase_endpoint: `/api/souls/${listing.soul_id}/download`,
      warnings: result.warnings || [],
      storage_warning: marketplaceStorageWarning()
    };
  }

  if (normalizedAction === 'list_my_published_listings' && normalizedMethod === 'GET') {
    const auth = creatorAuthFromHeaders({ headers, body: requestBody, action: normalizedAction });
    if (!auth.ok) {
      throw new AppError(401, creatorAuthError(normalizedAction, auth));
    }
    const listings = await listPublishedListingSummaries({ includeHidden: true, publishedBy: auth.wallet });
    return {
      wallet_address: auth.wallet,
      count: listings.length,
      listings: listings.map((item) => withShareUrl(baseUrl, item)),
      storage_warning: marketplaceStorageWarning()
    };
  }

  if (normalizedAction === 'list_published_listings' && normalizedMethod === 'GET') {
    const listings = await listPublishedListingSummaries({ includeHidden: false });
    return {
      count: listings.length,
      listings: listings.map((item) => withShareUrl(baseUrl, item)),
      storage_warning: marketplaceStorageWarning()
    };
  }

  if (normalizedAction === 'list_moderation_listings' && normalizedMethod === 'GET') {
    const moderator = moderatorAuthFromRequest({ headers, body: requestBody, action: normalizedAction });
    if (!moderator.ok) {
      throw new AppError(401, moderatorAuthError(normalizedAction, moderator));
    }
    const listings = await listPublishedListingSummaries({ includeHidden: true });
    const visible = listings
      .filter((item) => item.visibility !== 'hidden')
      .map((item) => withShareUrl(baseUrl, item));
    const hidden = listings
      .filter((item) => item.visibility === 'hidden')
      .map((item) => withShareUrl(baseUrl, item));
    return {
      moderator: moderator.wallet,
      count: listings.length,
      visible,
      hidden
    };
  }

  if (normalizedAction === 'remove_listing_visibility' && normalizedMethod === 'POST') {
    const moderator = moderatorAuthFromRequest({ headers, body: requestBody, action: normalizedAction });
    if (!moderator.ok) {
      throw new AppError(401, moderatorAuthError(normalizedAction, moderator));
    }
    const soulId = String(requestBody.soul_id || '').trim();
    const reason = typeof requestBody.reason === 'string' ? requestBody.reason : '';
    if (!soulId) throw new AppError(400, { error: 'Missing required field: soul_id' });

    const result = await setListingVisibility({
      soulId,
      visibility: 'hidden',
      moderator: moderator.wallet,
      reason
    });
    if (!result.ok) {
      const statusCode = /not found/i.test(result.error) ? 404 : 400;
      throw new AppError(statusCode, { ok: false, error: result.error });
    }
    return {
      ok: true,
      listing: withShareUrl(baseUrl, result.listing)
    };
  }

  throw new AppError(405, {
    error: 'Unsupported method/action combination',
    action: normalizedAction,
    method: normalizedMethod
  });
}
