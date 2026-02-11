import { setCors } from '../_lib/payments.js';
import { ensureFacilitatorReachable, getFacilitatorHealth } from '../_lib/x402.js';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const force = String(req.query?.force || '') === '1';
    await ensureFacilitatorReachable(force);
    return res.status(200).json({
      ok: true,
      facilitator: getFacilitatorHealth()
    });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      facilitator: getFacilitatorHealth()
    });
  }
}
