import { setCors } from '../../_lib/payments.js';
import { buildCreatorAuthMessage, getCreatorDraft, verifyCreatorAuth } from '../../_lib/marketplace.js';

const ACTION = 'get_my_listing_draft';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const wallet = String(req.headers['x-wallet-address'] || '').trim();
  const signature = String(req.headers['x-auth-signature'] || '').trim();
  const timestamp = req.headers['x-auth-timestamp'];
  const draftId = String(req.query?.draft_id || '').trim();

  if (!draftId) {
    return res.status(400).json({ error: 'Missing required query parameter: draft_id' });
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

  const draft = await getCreatorDraft(auth.wallet, draftId);
  if (!draft) {
    return res.status(404).json({ error: 'Draft not found', draft_id: draftId });
  }

  return res.status(200).json({
    wallet_address: auth.wallet,
    draft
  });
}
