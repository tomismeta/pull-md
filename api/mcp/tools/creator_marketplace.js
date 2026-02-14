import { setCors } from '../../_lib/payments.js';
import {
  buildCreatorAuthMessage,
  getCreatorDraft,
  getMarketplaceDraftTemplate,
  listCreatorDrafts,
  listDraftsByStatus,
  publishCreatorDraft,
  reviewCreatorDraft,
  submitCreatorDraftForReview,
  upsertCreatorDraft,
  validateMarketplaceDraft,
  verifyCreatorAuth,
  verifyReviewAdminToken
} from '../../_lib/marketplace.js';

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

function adminToken(req) {
  return req.headers['x-admin-token'] || req.body?.admin_token || req.query?.admin_token;
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = getAction(req);
  if (!action) {
    return res.status(400).json({ error: 'Missing required action', endpoint: '/api/mcp/tools/creator_marketplace' });
  }

  if (action === 'get_listing_template' && req.method === 'GET') {
    return res.status(200).json({
      template: getMarketplaceDraftTemplate(),
      notes: [
        'This endpoint validates contract shape only; no on-chain listing is created yet.',
        'Use validate_listing_draft before any creator onboarding workflow.'
      ]
    });
  }

  if (action === 'validate_listing_draft' && req.method === 'POST') {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const draftPayload =
      payload.draft && typeof payload.draft === 'object' ? payload.draft : { listing: payload.listing, assets: payload.assets };
    const result = validateMarketplaceDraft(draftPayload);
    return res.status(result.ok ? 200 : 400).json({
      ok: result.ok,
      draft_id: result.draft_id,
      errors: result.errors,
      warnings: result.warnings,
      normalized: result.normalized
    });
  }

  if (action === 'save_listing_draft' && req.method === 'POST') {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const wallet = String(body.wallet_address || '').trim();
    const signature = String(body.auth_signature || '').trim();
    const timestamp = body.auth_timestamp;

    const auth = verifyCreatorAuth({ wallet, signature, timestamp, action });
    if (!auth.ok) return res.status(401).json(creatorAuthError(action, auth));

    const draftPayload =
      body.draft && typeof body.draft === 'object' ? body.draft : { listing: body.listing, assets: body.assets };
    const result = validateMarketplaceDraft(draftPayload);
    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        draft_id: result.draft_id,
        errors: result.errors,
        warnings: result.warnings
      });
    }

    const record = await upsertCreatorDraft({
      walletAddress: auth.wallet,
      normalizedDraft: result.normalized,
      draftId: result.draft_id
    });
    return res.status(200).json({
      ok: true,
      wallet_address: auth.wallet,
      draft: {
        draft_id: record.draft_id,
        status: record.status,
        created_at: record.created_at,
        updated_at: record.updated_at,
        soul_id: record.normalized?.listing?.soul_id || null,
        name: record.normalized?.listing?.name || null
      },
      warnings: result.warnings
    });
  }

  if (action === 'list_my_listing_drafts' && req.method === 'GET') {
    const wallet = String(req.headers['x-wallet-address'] || '').trim();
    const signature = String(req.headers['x-auth-signature'] || '').trim();
    const timestamp = req.headers['x-auth-timestamp'];
    const auth = verifyCreatorAuth({ wallet, signature, timestamp, action });
    if (!auth.ok) return res.status(401).json(creatorAuthError(action, auth));
    const drafts = await listCreatorDrafts(auth.wallet);
    return res.status(200).json({ wallet_address: auth.wallet, count: drafts.length, drafts });
  }

  if (action === 'get_my_listing_draft' && req.method === 'GET') {
    const wallet = String(req.headers['x-wallet-address'] || '').trim();
    const signature = String(req.headers['x-auth-signature'] || '').trim();
    const timestamp = req.headers['x-auth-timestamp'];
    const draftId = String(req.query?.draft_id || '').trim();
    if (!draftId) return res.status(400).json({ error: 'Missing required query parameter: draft_id' });
    const auth = verifyCreatorAuth({ wallet, signature, timestamp, action });
    if (!auth.ok) return res.status(401).json(creatorAuthError(action, auth));
    const draft = await getCreatorDraft(auth.wallet, draftId);
    if (!draft) return res.status(404).json({ error: 'Draft not found', draft_id: draftId });
    return res.status(200).json({ wallet_address: auth.wallet, draft });
  }

  if (action === 'submit_listing_for_review' && req.method === 'POST') {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const wallet = String(body.wallet_address || '').trim();
    const signature = String(body.auth_signature || '').trim();
    const timestamp = body.auth_timestamp;
    const draftId = String(body.draft_id || '').trim();
    if (!draftId) return res.status(400).json({ error: 'Missing required field: draft_id' });

    const auth = verifyCreatorAuth({ wallet, signature, timestamp, action });
    if (!auth.ok) return res.status(401).json(creatorAuthError(action, auth));

    const result = await submitCreatorDraftForReview({ walletAddress: auth.wallet, draftId });
    if (!result.ok) {
      const statusCode = /not found/i.test(result.error) ? 404 : 409;
      return res.status(statusCode).json({ ok: false, error: result.error, draft: result.draft || null });
    }
    return res.status(200).json({
      ok: true,
      wallet_address: auth.wallet,
      draft: {
        draft_id: result.draft.draft_id,
        status: result.draft.status,
        moderation: result.draft.moderation,
        updated_at: result.draft.updated_at
      }
    });
  }

  if (action === 'review_listing_submission' && req.method === 'POST') {
    const admin = verifyReviewAdminToken(adminToken(req));
    if (!admin.ok) {
      const code = /configuration/i.test(admin.error) ? 500 : 401;
      return res.status(code).json({ error: admin.error });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await reviewCreatorDraft({
      walletAddress: String(body.wallet_address || '').trim(),
      draftId: String(body.draft_id || '').trim(),
      decision: String(body.decision || '').trim().toLowerCase(),
      reviewer: String(body.reviewer || req.headers['x-reviewer'] || 'admin').trim(),
      notes: typeof body.notes === 'string' ? body.notes : ''
    });
    if (!result.ok) {
      const statusCode = /not found/i.test(result.error) ? 404 : 409;
      return res.status(statusCode).json({ ok: false, error: result.error, draft: result.draft || null });
    }
    return res.status(200).json({ ok: true, draft: result.draft });
  }

  if (action === 'list_review_queue' && req.method === 'GET') {
    const admin = verifyReviewAdminToken(adminToken(req));
    if (!admin.ok) {
      const code = /configuration/i.test(admin.error) ? 500 : 401;
      return res.status(code).json({ error: admin.error });
    }
    const queue = await listDraftsByStatus(['submitted_for_review']);
    return res.status(200).json({ count: queue.length, queue });
  }

  if (action === 'publish_listing' && req.method === 'POST') {
    const admin = verifyReviewAdminToken(adminToken(req));
    if (!admin.ok) {
      const code = /configuration/i.test(admin.error) ? 500 : 401;
      return res.status(code).json({ error: admin.error });
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = await publishCreatorDraft({
      walletAddress: String(body.wallet_address || '').trim(),
      draftId: String(body.draft_id || '').trim(),
      reviewer: String(body.reviewer || req.headers['x-reviewer'] || 'admin').trim(),
      notes: typeof body.notes === 'string' ? body.notes : ''
    });
    if (!result.ok) {
      const statusCode = /not found/i.test(result.error) ? 404 : 409;
      return res.status(statusCode).json({ ok: false, error: result.error, draft: result.draft || null });
    }
    return res.status(200).json({ ok: true, draft: result.draft });
  }

  if (action === 'list_published_listings' && req.method === 'GET') {
    const listings = await listDraftsByStatus(['published']);
    return res.status(200).json({ count: listings.length, listings });
  }

  return res.status(405).json({ error: 'Unsupported method/action combination', action, method: req.method });
}
