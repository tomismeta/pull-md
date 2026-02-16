import { listSoulsResolved } from '../_lib/catalog.js';
import { setCors } from '../_lib/payments.js';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { category } = req.query || {};
    const souls = await listSoulsResolved();
    const filtered = category ? souls.filter((soul) => soul.category === category) : souls;
    return res.status(200).json({
      souls: filtered,
      count: filtered.length,
      meta: {
        discovery: 'public_catalog',
        mcp_manifest: '/api/mcp/manifest',
        mcp_list_endpoint: '/api/mcp/tools/list_souls',
        purchase_flow: 'GET /api/souls/{id}/download -> 402 PAYMENT-REQUIRED -> retry with PAYMENT-SIGNATURE'
      }
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Unable to load soul catalog',
      details: error?.message || 'unknown_error'
    });
  }
}
