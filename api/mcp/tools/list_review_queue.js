import { setCors } from '../../_lib/payments.js';
import { listDraftsByStatus, verifyReviewAdminToken } from '../../_lib/marketplace.js';

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const adminToken = req.headers['x-admin-token'] || req.query?.admin_token;
  const admin = verifyReviewAdminToken(adminToken);
  if (!admin.ok) {
    const code = /configuration/i.test(admin.error) ? 500 : 401;
    return res.status(code).json({ error: admin.error });
  }

  const queue = await listDraftsByStatus(['submitted_for_review']);
  return res.status(200).json({
    count: queue.length,
    queue
  });
}
