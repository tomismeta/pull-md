import { setCors } from '../../_lib/payments.js';
import { validateMarketplaceDraft } from '../../_lib/marketplace.js';

export default function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const result = validateMarketplaceDraft(payload);

  return res.status(result.ok ? 200 : 400).json({
    ok: result.ok,
    draft_id: result.draft_id,
    errors: result.errors,
    warnings: result.warnings,
    normalized: result.normalized,
    next_steps: result.ok
      ? [
          'Persist this normalized draft in your creator workflow.',
          'Review pricing/fee split policy before publishing.',
          'Publishing endpoint is intentionally not enabled in this phase.'
        ]
      : ['Fix errors and retry validation.']
  });
}
