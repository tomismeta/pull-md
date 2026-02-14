import { getMarketplaceDraftTemplate } from '../../_lib/marketplace.js';
import { setCors } from '../../_lib/payments.js';

export default function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  return res.status(200).json({
    template: getMarketplaceDraftTemplate(),
    notes: [
      'This endpoint validates contract shape only; no on-chain listing is created yet.',
      'Use validate_listing_draft before any creator onboarding workflow.'
    ]
  });
}
