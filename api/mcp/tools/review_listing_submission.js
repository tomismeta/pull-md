import { setCors } from '../../_lib/payments.js';
import { reviewCreatorDraft, verifyReviewAdminToken } from '../../_lib/marketplace.js';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const adminToken = req.headers['x-admin-token'] || req.body?.admin_token;
  const admin = verifyReviewAdminToken(adminToken);
  if (!admin.ok) {
    const code = /configuration/i.test(admin.error) ? 500 : 401;
    return res.status(code).json({ error: admin.error });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const walletAddress = String(body.wallet_address || '').trim();
  const draftId = String(body.draft_id || '').trim();
  const decision = String(body.decision || '').trim().toLowerCase();
  const reviewer = String(body.reviewer || req.headers['x-reviewer'] || 'admin').trim();
  const notes = typeof body.notes === 'string' ? body.notes : '';

  if (!walletAddress) return res.status(400).json({ error: 'Missing required field: wallet_address' });
  if (!draftId) return res.status(400).json({ error: 'Missing required field: draft_id' });
  if (!decision) return res.status(400).json({ error: 'Missing required field: decision' });

  const result = await reviewCreatorDraft({
    walletAddress,
    draftId,
    decision,
    reviewer,
    notes
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
    draft: {
      draft_id: result.draft.draft_id,
      status: result.draft.status,
      moderation: result.draft.moderation,
      wallet_address: walletAddress.toLowerCase(),
      soul_id: result.draft.normalized?.listing?.soul_id || null,
      name: result.draft.normalized?.listing?.name || null
    }
  });
}
