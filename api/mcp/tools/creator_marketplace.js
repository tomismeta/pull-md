import { setCors } from '../../_lib/payments.js';
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
} from '../../_lib/marketplace.js';

const DEPRECATED_ACTIONS = new Set([
  'validate_listing_draft',
  'save_listing_draft',
  'list_my_listing_drafts',
  'get_my_listing_draft',
  'submit_listing_for_review',
  'review_listing_submission',
  'list_review_queue'
]);

function getAction(req) {
  const fromQuery = req.query?.action;
  const fromBody = req.body?.action;
  return String(fromQuery || fromBody || '').trim();
}

function creatorAuthError(action, auth) {
  return {
    error: auth.error,
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

function moderatorAuthFromRequest(req, action) {
  const wallet = String(req.headers['x-moderator-address'] || req.body?.moderator_address || '').trim();
  const signature = String(req.headers['x-moderator-signature'] || req.body?.moderator_signature || '').trim();
  const timestamp = req.headers['x-moderator-timestamp'] || req.body?.moderator_timestamp;
  return verifyModeratorAuth({ wallet, signature, timestamp, action });
}

function creatorAuthFromHeaders(req, action) {
  const wallet = String(req.headers['x-wallet-address'] || '').trim();
  const signature = String(req.headers['x-auth-signature'] || '').trim();
  const timestamp = req.headers['x-auth-timestamp'];
  return verifyCreatorAuth({ wallet, signature, timestamp, action });
}

function resolveBaseUrl(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'soulstarter.vercel.app').trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'https').trim();
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

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const action = getAction(req);
    if (!action) {
      return res.status(400).json({ error: 'Missing required action', endpoint: '/api/mcp/tools/creator_marketplace' });
    }

    const baseUrl = resolveBaseUrl(req);

    if (DEPRECATED_ACTIONS.has(action)) {
      return res.status(410).json({
        error: 'Deprecated creator workflow action',
        code: 'creator_workflow_simplified',
        flow_hint:
          'Draft and approval actions were removed. Use publish_listing for immediate publish, then moderate with remove_listing_visibility if needed.',
        supported_actions: [
          'get_listing_template',
          'publish_listing',
          'list_my_published_listings',
          'list_published_listings',
          'list_moderators',
          'list_moderation_listings',
          'remove_listing_visibility'
        ]
      });
    }

    if (action === 'get_listing_template' && req.method === 'GET') {
      return res.status(200).json({
        template: getMarketplaceDraftTemplate(),
        notes: [
          'Immediate publish workflow: name, price_usdc, description, soul_markdown.',
          'No drafts, no approval queue, no publish state transitions.',
          'Successful publish returns a shareable soul page URL.'
        ]
      });
    }

    if (action === 'list_moderators' && req.method === 'GET') {
      const moderators = listModeratorWallets();
      return res.status(200).json({ count: moderators.length, moderators });
    }

    if (action === 'publish_listing' && req.method === 'GET') {
      return res.status(405).json({
        error: 'Method not allowed for publish_listing',
        code: 'publish_listing_requires_post',
        flow_hint:
          'Use POST /api/mcp/tools/creator_marketplace?action=publish_listing with wallet auth fields and listing payload.',
        required_method: 'POST'
      });
    }

    if (action === 'publish_listing' && req.method === 'POST') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const wallet = String(body.wallet_address || '').trim();
      const signature = String(body.auth_signature || '').trim();
      const timestamp = body.auth_timestamp;
      const auth = verifyCreatorAuth({ wallet, signature, timestamp, action });
      if (!auth.ok) return res.status(401).json(creatorAuthError(action, auth));

      const listingPayload =
        body.listing && typeof body.listing === 'object'
          ? body.listing
          : body.publish && typeof body.publish === 'object'
            ? body.publish
            : body;
      const result = await publishCreatorListingDirect({
        walletAddress: auth.wallet,
        payload: listingPayload
      });
      if (!result.ok) {
        const statusCode = result.code === 'marketplace_persistence_unconfigured' ? 503 : 400;
        return res.status(statusCode).json({
          code: result.code || 'publish_failed',
          ok: false,
          errors: result.errors,
          warnings: result.warnings,
          draft_id: result.draft_id
        });
      }

      const listing = withShareUrl(baseUrl, result.listing);
      return res.status(200).json({
        ok: true,
        wallet_address: auth.wallet,
        listing,
        share_url: listing.share_url,
        purchase_endpoint: `/api/souls/${listing.soul_id}/download`,
        warnings: result.warnings || [],
        storage_warning: marketplaceStorageWarning()
      });
    }

    if (action === 'list_my_published_listings' && req.method === 'GET') {
      const auth = creatorAuthFromHeaders(req, action);
      if (!auth.ok) return res.status(401).json(creatorAuthError(action, auth));
      const listings = await listPublishedListingSummaries({ includeHidden: true, publishedBy: auth.wallet });
      return res.status(200).json({
        wallet_address: auth.wallet,
        count: listings.length,
        listings: listings.map((item) => withShareUrl(baseUrl, item)),
        storage_warning: marketplaceStorageWarning()
      });
    }

    if (action === 'list_published_listings' && req.method === 'GET') {
      const listings = await listPublishedListingSummaries({ includeHidden: false });
      return res.status(200).json({
        count: listings.length,
        listings: listings.map((item) => withShareUrl(baseUrl, item)),
        storage_warning: marketplaceStorageWarning()
      });
    }

    if (action === 'list_moderation_listings' && req.method === 'GET') {
      const moderator = moderatorAuthFromRequest(req, action);
      if (!moderator.ok) return res.status(401).json(moderatorAuthError(action, moderator));
      const listings = await listPublishedListingSummaries({ includeHidden: true });
      const visible = listings.filter((item) => item.visibility !== 'hidden').map((item) => withShareUrl(baseUrl, item));
      const hidden = listings.filter((item) => item.visibility === 'hidden').map((item) => withShareUrl(baseUrl, item));
      return res.status(200).json({
        moderator: moderator.wallet,
        count: listings.length,
        visible,
        hidden
      });
    }

    if (action === 'remove_listing_visibility' && req.method === 'POST') {
      const moderator = moderatorAuthFromRequest(req, action);
      if (!moderator.ok) return res.status(401).json(moderatorAuthError(action, moderator));
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const soulId = String(body.soul_id || '').trim();
      const reason = typeof body.reason === 'string' ? body.reason : '';
      if (!soulId) return res.status(400).json({ error: 'Missing required field: soul_id' });

      const result = await setListingVisibility({
        soulId,
        visibility: 'hidden',
        moderator: moderator.wallet,
        reason
      });
      if (!result.ok) {
        const statusCode = /not found/i.test(result.error) ? 404 : 400;
        return res.status(statusCode).json({ ok: false, error: result.error });
      }
      return res.status(200).json({
        ok: true,
        listing: withShareUrl(baseUrl, result.listing)
      });
    }

    return res.status(405).json({ error: 'Unsupported method/action combination', action, method: req.method });
  } catch (error) {
    console.error('creator_marketplace handler failed:', error);
    return res.status(500).json({
      error: 'creator_marketplace_internal_error',
      action: getAction(req),
      method: req.method
    });
  }
}
