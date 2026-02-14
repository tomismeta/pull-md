import { setCors } from '../../_lib/payments.js';
import {
  buildCreatorAuthMessage,
  submitCreatorDraftForReview,
  verifyCreatorAuth
} from '../../_lib/marketplace.js';

const ACTION = 'submit_listing_for_review';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const wallet = String(body.wallet_address || '').trim();
  const signature = String(body.auth_signature || '').trim();
  const timestamp = body.auth_timestamp;
  const draftId = String(body.draft_id || '').trim();

  if (!draftId) {
    return res.status(400).json({ error: 'Missing required field: draft_id' });
  }

  const auth = verifyCreatorAuth({ wallet, signature, timestamp, action: ACTION });
  if (!auth.ok) {
    return res.status(401).json({
      error: auth.error,
      auth_message_template:
        auth.auth_message_template ||
        buildCreatorAuthMessage({ wallet: '0x<your-wallet>', action: ACTION, timestamp: Date.now() })
    });
  }

  const result = await submitCreatorDraftForReview({
    walletAddress: auth.wallet,
    draftId
  });

  if (!result.ok) {
    const statusCode = /not found/i.test(result.error) ? 404 : 409;
    return res.status(statusCode).json({
      ok: false,
      error: result.error,
      draft: result.draft || null
    });
  }

  return res.status(200).json({
    ok: true,
    wallet_address: auth.wallet,
    draft: {
      draft_id: result.draft.draft_id,
      status: result.draft.status,
      moderation: result.draft.moderation,
      updated_at: result.draft.updated_at,
      soul_id: result.draft.normalized?.listing?.soul_id || null,
      name: result.draft.normalized?.listing?.name || null
    },
    review_flow: {
      state: 'pending',
      note: 'This phase creates submission metadata only. Admin review/publish endpoints are intentionally not enabled yet.'
    }
  });
}
