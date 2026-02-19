import {
  buildModeratorAuthMessage,
  buildCreatorAuthMessage,
  deletePublishedListingByModerator,
  getMarketplaceDraftTemplate,
  listModerationListingDetails,
  listModeratorWallets,
  listPublishedListingSummaries,
  publishCreatorListingDirect,
  setListingVisibility,
  updatePublishedListingByModerator,
  verifyCreatorAuth,
  verifyModeratorAuth
} from '../marketplace.js';
import { AppError } from '../errors.js';
import { getTelemetryDashboard, normalizeTelemetryWindowHours, recordTelemetryEvent } from '../telemetry.js';
import { resolveSiweIdentity, verifyRedownloadSessionToken } from '../payments.js';

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

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
  const host = String(headers['x-forwarded-host'] || headers.host || 'www.pull.md').trim();
  const proto = String(headers['x-forwarded-proto'] || 'https').trim();
  return `${proto}://${host}`;
}

function resolveSiweContext(headers = {}) {
  const host = String(headers['x-forwarded-host'] || headers.host || '').trim();
  const proto = String(headers['x-forwarded-proto'] || 'https').trim();
  return resolveSiweIdentity({ host, proto });
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

function creatorAuthError(action, auth, headers = {}) {
  const siwe = resolveSiweContext(headers);
  return {
    error: auth.error,
    ...(auth?.hint ? { hint: auth.hint } : {}),
    auth_message_template:
      auth.auth_message_template ||
      buildCreatorAuthMessage({
        wallet: '0x<your-wallet>',
        action,
        timestamp: Date.now(),
        domain: siwe.domain,
        uri: siwe.uri
      })
  };
}

function moderatorAuthError(action, auth, headers = {}) {
  const siwe = resolveSiweContext(headers);
  return {
    error: auth.error,
    ...(auth?.hint ? { hint: auth.hint } : {}),
    auth_message_template:
      auth.auth_message_template ||
      buildModeratorAuthMessage({
        wallet: '0x<your-wallet>',
        action,
        timestamp: Date.now(),
        domain: siwe.domain,
        uri: siwe.uri
      }),
    allowed_moderators: listModeratorWallets()
  };
}

function moderatorAuthFromRequest({ headers, body, action }) {
  const siwe = resolveSiweContext(headers);
  const wallet = String(headers['x-moderator-address'] || body?.moderator_address || '').trim().toLowerCase();
  const sessionToken = String(headers['x-redownload-session'] || body?.moderator_session_token || '').trim();
  if (sessionToken) {
    const allowlist = listModeratorWallets();
    if (allowlist.length === 0) {
      return { ok: false, error: 'Server configuration error: moderator allowlist is empty' };
    }
    if (!wallet) {
      return {
        ok: false,
        error: 'Missing moderator wallet for session authentication',
        hint: 'Include X-MODERATOR-ADDRESS with X-REDOWNLOAD-SESSION.'
      };
    }
    if (!ETH_ADDRESS_RE.test(wallet)) {
      return { ok: false, error: 'Invalid wallet address' };
    }
    if (!allowlist.includes(wallet)) {
      return { ok: false, error: 'Wallet is not an allowed moderator' };
    }
    const checked = verifyRedownloadSessionToken({ token: sessionToken, wallet });
    if (!checked.ok) {
      return {
        ok: false,
        error: `Moderator session invalid: ${checked.error || 'unknown error'}`,
        hint: 'Refresh moderator session by reconnecting wallet.'
      };
    }
    return { ok: true, wallet, auth_format: 'moderator_session' };
  }
  const signature = String(headers['x-moderator-signature'] || body?.moderator_signature || '').trim();
  const timestamp = headers['x-moderator-timestamp'] || body?.moderator_timestamp;
  return verifyModeratorAuth({ wallet, signature, timestamp, action, domain: siwe.domain, uri: siwe.uri });
}

function creatorAuthFromHeaders({ headers, body, action }) {
  const siwe = resolveSiweContext(headers);
  const wallet = String(headers['x-wallet-address'] || body?.wallet_address || '').trim();
  const signature = String(headers['x-auth-signature'] || body?.auth_signature || '').trim();
  const timestamp = headers['x-auth-timestamp'] || body?.auth_timestamp;
  return verifyCreatorAuth({ wallet, signature, timestamp, action, domain: siwe.domain, uri: siwe.uri });
}

function ensureAction(action) {
  const normalized = String(action || '').trim();
  if (!normalized) {
    throw new AppError(400, { error: 'Missing required action', endpoint: '/mcp', rpc_method: 'tools/call' });
  }
  return normalized;
}

const AUTO_GENERATED_FIELDS = ['asset_id', 'asset_type', 'file_name', 'share_path', 'seller_address'];
const CREATOR_PROVIDED_FIELDS = ['name', 'description', 'price_usdc', 'content_markdown'];
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_ROW_LIMIT = 10;

function recordMarketplaceTelemetry(event = {}) {
  void recordTelemetryEvent({
    source: event.source || 'marketplace',
    route: event.route || '/mcp',
    httpMethod: event.httpMethod || null,
    eventType: event.eventType || 'marketplace.action',
    action: event.action || null,
    walletAddress: event.walletAddress || null,
    assetId: event.assetId || null,
    assetType: event.assetType || null,
    success: typeof event.success === 'boolean' ? event.success : null,
    statusCode: event.statusCode ?? null,
    errorCode: event.errorCode || null,
    errorMessage: event.errorMessage || null,
    metadata: event.metadata || {}
  });
}

export function getCreatorMarketplaceSupportedActions() {
  return [
    'get_listing_template',
    'publish_listing',
    'list_my_published_listings',
    'list_published_listings',
    'list_moderators',
    'get_telemetry_dashboard',
    'list_moderation_listings',
    'remove_listing_visibility',
    'restore_listing_visibility',
    'update_listing',
    'delete_listing'
  ];
}

export async function executeCreatorMarketplaceAction({
  action,
  method,
  headers = {},
  body = {},
  telemetryContext = {}
}) {
  const normalizedAction = ensureAction(action);
  const normalizedMethod = String(method || '').toUpperCase();
  const requestBody = body && typeof body === 'object' ? body : {};
  const baseUrl = resolveBaseUrl(headers);
  const telemetrySource = String(telemetryContext.source || '').trim() || 'marketplace';
  const telemetryRoute = String(telemetryContext.route || '').trim() || '/mcp';
  const telemetryMethod =
    String(telemetryContext.httpMethod || normalizedMethod || '').trim().toUpperCase() || null;

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
        'Immediate publish workflow: name, price_usdc, description, content_markdown.',
        'No drafts, no approval queue, no publish state transitions.',
        'Successful publish returns a shareable asset page URL.'
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
      throw new AppError(401, creatorAuthError(normalizedAction, auth, headers));
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
      recordMarketplaceTelemetry({
        source: telemetrySource,
        route: telemetryRoute,
        httpMethod: telemetryMethod,
        eventType: 'creator.publish_dry_run',
        action: normalizedAction,
        walletAddress: auth.wallet,
        success: Boolean(result.ok),
        statusCode: result.ok ? 200 : 400,
        errorCode: result.ok ? null : result.code || 'validation_failed',
        metadata: {
          warning_count: Array.isArray(result.warnings) ? result.warnings.length : 0,
          field_error_count: Array.isArray(result.field_errors) ? result.field_errors.length : 0
        }
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
      recordMarketplaceTelemetry({
        source: telemetrySource,
        route: telemetryRoute,
        httpMethod: telemetryMethod,
        eventType: 'creator.publish_failed',
        action: normalizedAction,
        walletAddress: auth.wallet,
        success: false,
        statusCode: result.code === 'marketplace_persistence_unconfigured' ? 503 : 400,
        errorCode: result.code || 'publish_failed',
        errorMessage: Array.isArray(result.errors) && result.errors.length ? result.errors[0] : 'publish_failed'
      });
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
      asset_id: listing.asset_id,
      auto_generated: AUTO_GENERATED_FIELDS,
      creator_provided: CREATOR_PROVIDED_FIELDS
    };
    recordMarketplaceTelemetry({
      source: telemetrySource,
      route: telemetryRoute,
      httpMethod: telemetryMethod,
      eventType: 'creator.publish_success',
      action: normalizedAction,
      walletAddress: auth.wallet,
      assetId: listing.asset_id,
      assetType: listing.asset_type || null,
      success: true,
      statusCode: 200,
      metadata: {
        price_micro_usdc: listing.price_micro_usdc || null,
        visibility: listing.visibility || null
      }
    });
    return {
      ok: true,
      wallet_address: auth.wallet,
      listing,
      listing_created: listingCreated,
      auto_generated: AUTO_GENERATED_FIELDS,
      creator_provided: CREATOR_PROVIDED_FIELDS,
      share_url: listing.share_url,
      purchase_endpoint: `/api/assets/${listing.asset_id}/download`,
      warnings: result.warnings || [],
      storage_warning: marketplaceStorageWarning()
    };
  }

  if (normalizedAction === 'list_my_published_listings' && normalizedMethod === 'GET') {
    const auth = creatorAuthFromHeaders({ headers, body: requestBody, action: normalizedAction });
    if (!auth.ok) {
      throw new AppError(401, creatorAuthError(normalizedAction, auth, headers));
    }
    const listings = await listPublishedListingSummaries({ includeHidden: true, publishedBy: auth.wallet });
    recordMarketplaceTelemetry({
      source: telemetrySource,
      route: telemetryRoute,
      httpMethod: telemetryMethod,
      eventType: 'creator.list_my_published',
      action: normalizedAction,
      walletAddress: auth.wallet,
      success: true,
      statusCode: 200,
      metadata: { count: listings.length }
    });
    return {
      wallet_address: auth.wallet,
      count: listings.length,
      listings: listings.map((item) => withShareUrl(baseUrl, item)),
      storage_warning: marketplaceStorageWarning()
    };
  }

  if (normalizedAction === 'list_published_listings' && normalizedMethod === 'GET') {
    const listings = await listPublishedListingSummaries({ includeHidden: false });
    recordMarketplaceTelemetry({
      source: telemetrySource,
      route: telemetryRoute,
      httpMethod: telemetryMethod,
      eventType: 'marketplace.list_published',
      action: normalizedAction,
      success: true,
      statusCode: 200,
      metadata: { count: listings.length }
    });
    return {
      count: listings.length,
      listings: listings.map((item) => withShareUrl(baseUrl, item)),
      storage_warning: marketplaceStorageWarning()
    };
  }

  if (normalizedAction === 'get_telemetry_dashboard' && normalizedMethod === 'GET') {
    const moderator = moderatorAuthFromRequest({ headers, body: requestBody, action: normalizedAction });
    if (!moderator.ok) {
      throw new AppError(401, moderatorAuthError(normalizedAction, moderator, headers));
    }
    const windowHours = normalizeTelemetryWindowHours(requestBody.window_hours || requestBody.hours || DEFAULT_WINDOW_HOURS);
    const rowLimit = requestBody.row_limit || requestBody.limit || DEFAULT_ROW_LIMIT;
    const dashboard = await getTelemetryDashboard({
      windowHours,
      rowLimit
    });
    recordMarketplaceTelemetry({
      eventType: 'moderation.telemetry_dashboard',
      source: telemetrySource,
      route: telemetryRoute,
      httpMethod: telemetryMethod,
      action: normalizedAction,
      walletAddress: moderator.wallet,
      success: true,
      statusCode: 200,
      metadata: {
        window_hours: windowHours,
        row_limit: rowLimit
      }
    });
    return {
      moderator: moderator.wallet,
      ...dashboard
    };
  }

  if (normalizedAction === 'list_moderation_listings' && normalizedMethod === 'GET') {
    const moderator = moderatorAuthFromRequest({ headers, body: requestBody, action: normalizedAction });
    if (!moderator.ok) {
      throw new AppError(401, moderatorAuthError(normalizedAction, moderator, headers));
    }
    const listings = await listModerationListingDetails();
    const visible = listings
      .filter((item) => item.visibility !== 'hidden')
      .map((item) => withShareUrl(baseUrl, item));
    const hidden = listings
      .filter((item) => item.visibility === 'hidden')
      .map((item) => withShareUrl(baseUrl, item));
    recordMarketplaceTelemetry({
      eventType: 'moderation.action_success',
      source: telemetrySource,
      route: telemetryRoute,
      httpMethod: telemetryMethod,
      action: normalizedAction,
      walletAddress: moderator.wallet,
      success: true,
      statusCode: 200,
      metadata: {
        total_count: listings.length,
        visible_count: visible.length,
        hidden_count: hidden.length
      }
    });
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
      throw new AppError(401, moderatorAuthError(normalizedAction, moderator, headers));
    }
    const assetId = String(requestBody.asset_id || '').trim();
    const reason = typeof requestBody.reason === 'string' ? requestBody.reason : '';
    if (!assetId) throw new AppError(400, { error: 'Missing required field: asset_id' });

    const result = await setListingVisibility({
      assetId,
      visibility: 'hidden',
      moderator: moderator.wallet,
      reason
    });
    if (!result.ok) {
      const statusCode = /not found/i.test(result.error) ? 404 : 400;
      throw new AppError(statusCode, { ok: false, error: result.error });
    }
    recordMarketplaceTelemetry({
      eventType: 'moderation.action_success',
      source: telemetrySource,
      route: telemetryRoute,
      httpMethod: telemetryMethod,
      action: normalizedAction,
      walletAddress: moderator.wallet,
      assetId: result?.listing?.asset_id || assetId,
      success: true,
      statusCode: 200
    });
    return {
      ok: true,
      listing: withShareUrl(baseUrl, result.listing)
    };
  }

  if (normalizedAction === 'restore_listing_visibility' && normalizedMethod === 'POST') {
    const moderator = moderatorAuthFromRequest({ headers, body: requestBody, action: normalizedAction });
    if (!moderator.ok) {
      throw new AppError(401, moderatorAuthError(normalizedAction, moderator, headers));
    }
    const assetId = String(requestBody.asset_id || '').trim();
    const reason = typeof requestBody.reason === 'string' ? requestBody.reason : '';
    if (!assetId) throw new AppError(400, { error: 'Missing required field: asset_id' });

    const result = await setListingVisibility({
      assetId,
      visibility: 'public',
      moderator: moderator.wallet,
      reason
    });
    if (!result.ok) {
      const statusCode = /not found/i.test(result.error) ? 404 : 400;
      throw new AppError(statusCode, { ok: false, error: result.error });
    }
    recordMarketplaceTelemetry({
      eventType: 'moderation.action_success',
      source: telemetrySource,
      route: telemetryRoute,
      httpMethod: telemetryMethod,
      action: normalizedAction,
      walletAddress: moderator.wallet,
      assetId: result?.listing?.asset_id || assetId,
      success: true,
      statusCode: 200
    });
    return {
      ok: true,
      listing: withShareUrl(baseUrl, result.listing)
    };
  }

  if (normalizedAction === 'update_listing' && normalizedMethod === 'POST') {
    const moderator = moderatorAuthFromRequest({ headers, body: requestBody, action: normalizedAction });
    if (!moderator.ok) {
      throw new AppError(401, moderatorAuthError(normalizedAction, moderator, headers));
    }
    const assetId = String(requestBody.asset_id || '').trim();
    const listingPayload =
      requestBody.listing && typeof requestBody.listing === 'object'
        ? requestBody.listing
        : requestBody.update && typeof requestBody.update === 'object'
          ? requestBody.update
          : requestBody;
    if (!assetId) throw new AppError(400, { error: 'Missing required field: asset_id' });

    const result = await updatePublishedListingByModerator({
      assetId,
      updates: listingPayload,
      moderator: moderator.wallet
    });
    if (!result.ok) {
      const statusCode = /not found/i.test(String(result.error || '')) ? 404 : 400;
      throw new AppError(statusCode, {
        ok: false,
        code: result.code || 'update_failed',
        error: result.error || 'Update failed',
        errors: result.errors || [],
        field_errors: result.field_errors || [],
        warnings: result.warnings || []
      });
    }
    recordMarketplaceTelemetry({
      eventType: 'moderation.action_success',
      source: telemetrySource,
      route: telemetryRoute,
      httpMethod: telemetryMethod,
      action: normalizedAction,
      walletAddress: moderator.wallet,
      assetId: result?.listing?.asset_id || assetId,
      assetType: result?.listing?.asset_type || null,
      success: true,
      statusCode: 200
    });
    return {
      ok: true,
      listing: withShareUrl(baseUrl, result.listing),
      warnings: result.warnings || []
    };
  }

  if (normalizedAction === 'delete_listing' && normalizedMethod === 'POST') {
    const moderator = moderatorAuthFromRequest({ headers, body: requestBody, action: normalizedAction });
    if (!moderator.ok) {
      throw new AppError(401, moderatorAuthError(normalizedAction, moderator, headers));
    }
    const assetId = String(requestBody.asset_id || '').trim();
    const reason = typeof requestBody.reason === 'string' ? requestBody.reason : '';
    if (!assetId) throw new AppError(400, { error: 'Missing required field: asset_id' });

    const result = await deletePublishedListingByModerator({
      assetId,
      moderator: moderator.wallet,
      reason
    });
    if (!result.ok) {
      const statusCode = /not found/i.test(result.error) ? 404 : 400;
      throw new AppError(statusCode, { ok: false, error: result.error });
    }
    recordMarketplaceTelemetry({
      eventType: 'moderation.action_success',
      source: telemetrySource,
      route: telemetryRoute,
      httpMethod: telemetryMethod,
      action: normalizedAction,
      walletAddress: moderator.wallet,
      assetId: result?.listing?.asset_id || assetId,
      success: true,
      statusCode: 200
    });
    return {
      ok: true,
      deleted: true,
      listing: withShareUrl(baseUrl, result.listing)
    };
  }

  throw new AppError(405, {
    error: 'Unsupported method/action combination',
    action: normalizedAction,
    method: normalizedMethod
  });
}
