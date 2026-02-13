import { getSoul, listSouls } from '../../_lib/catalog.js';
import { createPurchaseReceipt, inspectPurchaseReceipt, setCors } from '../../_lib/payments.js';

export default function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const payload = req.body || {};
  const walletAddress = String(payload.wallet_address || '')
    .trim()
    .toLowerCase();
  if (!/^0x[a-f0-9]{40}$/i.test(walletAddress)) {
    return res.status(400).json({ error: 'Invalid or missing wallet_address' });
  }

  const receipts = Array.isArray(payload.receipts) ? payload.receipts : [];
  const seededReceipts = [];
  const seedSecret = String(payload.seed_secret || '').trim();
  const expectedSeedSecret = String(process.env.TEST_RECEIPT_SEED_SECRET || '').trim();
  if (seedSecret && expectedSeedSecret && seedSecret === expectedSeedSecret) {
    const requestedSoulIds = Array.isArray(payload.seed_soul_ids) ? payload.seed_soul_ids.map((id) => String(id || '')) : [];
    const seedSoulIds = requestedSoulIds.length > 0 ? requestedSoulIds : listSouls().slice(0, 2).map((s) => s.id);
    for (const soulId of seedSoulIds) {
      const soul = getSoul(soulId);
      if (!soul) continue;
      const receipt = createPurchaseReceipt({
        wallet: walletAddress,
        soulId,
        transaction: `test-seed-${Date.now()}-${soulId}`
      });
      seededReceipts.push({ soul_id: soulId, receipt });
      receipts.push(receipt);
    }
  }

  const invalidReceipts = [];
  const ownedBySoulId = new Map();

  for (let i = 0; i < receipts.length; i += 1) {
    const receipt = String(receipts[i] || '');
    const inspected = inspectPurchaseReceipt({ receipt });
    if (!inspected.ok) {
      invalidReceipts.push({ index: i, entitled: false, reason: inspected.error || 'Invalid receipt' });
      continue;
    }

    if (inspected.wallet !== walletAddress) {
      invalidReceipts.push({ index: i, entitled: false, reason: 'Purchase receipt wallet mismatch' });
      continue;
    }

    const soul = getSoul(inspected.soulId);
    if (!soul) {
      invalidReceipts.push({ index: i, entitled: false, reason: 'Unknown soul' });
      continue;
    }

    const current = ownedBySoulId.get(soul.id);
    const currentIat = Number(current?.receipt_issued_at || 0);
    const nextIat = Number(inspected.iat || 0);
    if (!current || nextIat >= currentIat) {
      ownedBySoulId.set(soul.id, {
        soul_id: soul.id,
        name: soul.name,
        icon: soul.icon,
        category: soul.category,
        description: soul.description,
        price_display: soul.priceDisplay,
        provenance: soul.provenance,
        compatibility: soul.compatibility,
        source_label: soul.sourceLabel || null,
        source_url: soul.sourceUrl || null,
        transaction: inspected.transaction || null,
        receipt_issued_at: inspected.iat || null,
        redownload_endpoint: `/api/souls/${soul.id}/download`
      });
    }
  }

  const ownedSouls = Array.from(ownedBySoulId.values()).sort((a, b) => a.name.localeCompare(b.name));

  return res.status(200).json({
    wallet_address: walletAddress,
    owned_souls: ownedSouls,
    total_owned: ownedSouls.length,
    seeded_receipts: seededReceipts,
    seeded_receipts_count: seededReceipts.length,
    invalid_receipts: invalidReceipts,
    invalid_receipts_count: invalidReceipts.length
  });
}
