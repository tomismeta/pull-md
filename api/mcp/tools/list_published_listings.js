import { setCors } from '../../_lib/payments.js';
import { listDraftsByStatus } from '../../_lib/marketplace.js';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const rows = await listDraftsByStatus(['published']);
  return res.status(200).json({
    count: rows.length,
    listings: rows
  });
}
