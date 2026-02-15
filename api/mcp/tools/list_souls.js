import { listSoulsResolved } from '../../_lib/catalog.js';
import { setCors } from '../../_lib/payments.js';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { category } = req.query;
  const souls = await listSoulsResolved();
  const filtered = category ? souls.filter((soul) => soul.category === category) : souls;

  return res.status(200).json({
    souls: filtered,
    count: filtered.length,
    meta: {
      agent_friendly: true,
      access_type: 'x402_paywall',
      flow: 'GET /api/souls/{id}/download -> 402 PAYMENT-REQUIRED -> GET with PAYMENT-SIGNATURE',
      reauth_flow:
        'Strict headless agent: X-CLIENT-MODE: agent + X-WALLET-ADDRESS + X-PURCHASE-RECEIPT only. Human recovery: X-WALLET-ADDRESS + X-REDOWNLOAD-SESSION (or signed fallback).'
    }
  });
}
