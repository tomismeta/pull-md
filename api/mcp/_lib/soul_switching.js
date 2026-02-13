import { getSoul } from '../../_lib/catalog.js';
import { buildAuthMessage, verifyPurchaseReceipt } from '../../_lib/payments.js';

export function validateWalletAddress(walletAddress) {
  const wallet = String(walletAddress || '')
    .trim()
    .toLowerCase();
  if (!/^0x[a-f0-9]{40}$/i.test(wallet)) {
    return { ok: false, error: 'Invalid or missing wallet_address' };
  }
  return { ok: true, wallet };
}

export function verifySoulOwnership({ wallet, soulId, receipt }) {
  const soul = getSoul(soulId);
  if (!soul) {
    return { ok: false, error: 'Unknown soul' };
  }
  const check = verifyPurchaseReceipt({ receipt: String(receipt || ''), wallet, soulId });
  if (!check.ok) {
    return { ok: false, error: check.error };
  }
  return { ok: true, soul, transaction: check.transaction || null };
}

export function buildSoulSummary(soul, transaction) {
  return {
    soul_id: soul.id,
    name: soul.name,
    icon: soul.icon,
    category: soul.category,
    description: soul.description,
    transaction: transaction || null,
    redownload_endpoint: `/api/souls/${soul.id}/download`
  };
}

export function buildRedownloadContract({ wallet, soulId }) {
  return {
    endpoint: `/api/souls/${soulId}/download`,
    method: 'GET',
    headers_required: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP', 'X-PURCHASE-RECEIPT'],
    auth_message_template: buildAuthMessage({
      wallet,
      soulId,
      action: 'redownload',
      timestamp: Date.now()
    })
  };
}
