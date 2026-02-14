import { setCors } from '../../_lib/payments.js';
import {
  buildCreatorAuthMessage,
  upsertCreatorDraft,
  validateMarketplaceDraft,
  verifyCreatorAuth
} from '../../_lib/marketplace.js';

const ACTION = 'save_listing_draft';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const wallet = String(body.wallet_address || '').trim();
  const signature = String(body.auth_signature || '').trim();
  const timestamp = body.auth_timestamp;

  const auth = verifyCreatorAuth({ wallet, signature, timestamp, action: ACTION });
  if (!auth.ok) {
    return res.status(401).json({
      error: auth.error,
      auth_message_template:
        auth.auth_message_template ||
        buildCreatorAuthMessage({ wallet: '0x<your-wallet>', action: ACTION, timestamp: Date.now() })
    });
  }

  const draftPayload = body.draft && typeof body.draft === 'object' ? body.draft : { listing: body.listing, assets: body.assets };
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
