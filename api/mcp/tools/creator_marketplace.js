import { setCors } from '../../_lib/payments.js';
import { isAppError } from '../../_lib/errors.js';
import { executeCreatorMarketplaceAction } from '../../_lib/services/creator_marketplace.js';

function getAction(req) {
  const fromQuery = req.query?.action;
  const fromBody = req.body?.action;
  return String(fromQuery || fromBody || '').trim();
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const action = getAction(req);
    const payload = await executeCreatorMarketplaceAction({
      action,
      method: req.method,
      headers: req.headers,
      body: req.body
    });
    return res.status(200).json(payload);
  } catch (error) {
    if (isAppError(error)) {
      return res.status(error.status).json(error.payload);
    }
    console.error('creator_marketplace handler failed:', error);
    return res.status(500).json({
      error: 'creator_marketplace_internal_error',
      action: getAction(req),
      method: req.method
    });
  }
}
