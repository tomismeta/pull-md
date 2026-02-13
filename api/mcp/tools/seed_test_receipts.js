import { getSoul, listSouls } from '../../_lib/catalog.js';
import { createPurchaseReceipt, setCors } from '../../_lib/payments.js';

export default function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expectedSecret = String(process.env.TEST_RECEIPT_SEED_SECRET || '').trim();
  if (!expectedSecret) {
    return res.status(403).json({
      error: 'Test receipt seeding is disabled',
      message: 'Set TEST_RECEIPT_SEED_SECRET to enable this temporary tool'
    });
  }

  const payload = req.body || {};
  const providedSecret = String(payload.seed_secret || '').trim();
  if (!providedSecret || providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Invalid seed_secret' });
  }

  const walletAddress = String(payload.wallet_address || '')
    .trim()
    .toLowerCase();
  if (!/^0x[a-f0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Invalid or missing wallet_address' });
  }

  const requestedSoulIds = Array.isArray(payload.soul_ids) ? payload.soul_ids.map((id) => String(id || '')) : [];
  const soulIds = requestedSoulIds.length > 0 ? requestedSoulIds : listSouls().slice(0, 2).map((s) => s.id);

  const seeded = [];
  const skipped = [];
  for (const soulId of soulIds) {
    const soul = getSoul(soulId);
    if (!soul) {
      skipped.push({ soul_id: soulId, reason: 'Unknown soul' });
      continue;
    }
    const receipt = createPurchaseReceipt({
      wallet: walletAddress,
      soulId,
      transaction: `test-seed-${Date.now()}-${soulId}`
    });
    seeded.push({
      soul_id: soulId,
      receipt
    });
  }

  return res.status(200).json({
    wallet_address: walletAddress,
    seeded_receipts: seeded,
    skipped,
    warning: 'Temporary testing helper. Remove before production launch.'
  });
}
