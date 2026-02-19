(function attachPullMdStorage(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  const DEFAULT_RECEIPT_PREFIX = 'pullmd.receipt.';
  const DEFAULT_REDOWNLOAD_SESSION_PREFIX = 'pullmd.redownload.session.';

  function receiptStorageKey(wallet, assetId, { receiptPrefix = DEFAULT_RECEIPT_PREFIX } = {}) {
    const normalizedWallet = String(wallet || '').toLowerCase().trim();
    const normalizedAssetId = String(assetId || '').trim();
    if (!normalizedWallet || !normalizedAssetId) return '';
    return `${receiptPrefix}${normalizedWallet}.${normalizedAssetId}`;
  }

  function parseAssetIdFromReceiptKey(key, wallet, { receiptPrefix = DEFAULT_RECEIPT_PREFIX } = {}) {
    const prefix = `${receiptPrefix}${String(wallet || '').toLowerCase().trim()}.`;
    if (!prefix || !String(key || '').startsWith(prefix)) return null;
    return String(key).slice(prefix.length);
  }

  function collectStoredProofs(wallet, { receiptPrefix = DEFAULT_RECEIPT_PREFIX } = {}) {
    const proofs = [];
    try {
      const normalizedWallet = String(wallet || '').toLowerCase().trim();
      if (!normalizedWallet) return proofs;
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        const assetId = parseAssetIdFromReceiptKey(key, normalizedWallet, { receiptPrefix });
        if (!assetId) continue;
        const receipt = localStorage.getItem(String(key || ''));
        if (!receipt) continue;
        proofs.push({ asset_id: assetId, receipt });
      }
    } catch (_) {}
    return proofs;
  }

  function getStoredReceipt(assetId, wallet, { receiptPrefix = DEFAULT_RECEIPT_PREFIX } = {}) {
    try {
      const key = receiptStorageKey(wallet, assetId, { receiptPrefix });
      if (!key) return null;
      return localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function storeReceipt(assetId, wallet, receipt, { receiptPrefix = DEFAULT_RECEIPT_PREFIX } = {}) {
    try {
      const key = receiptStorageKey(wallet, assetId, { receiptPrefix });
      if (!key) return false;
      localStorage.setItem(key, String(receipt || ''));
      return true;
    } catch (_) {
      return false;
    }
  }

  function redownloadSessionStorageKey(wallet, { redownloadSessionPrefix = DEFAULT_REDOWNLOAD_SESSION_PREFIX } = {}) {
    return `${redownloadSessionPrefix}${String(wallet || '').toLowerCase().trim()}`;
  }

  function getStoredRedownloadSession(wallet, { redownloadSessionPrefix = DEFAULT_REDOWNLOAD_SESSION_PREFIX } = {}) {
    try {
      const raw = localStorage.getItem(redownloadSessionStorageKey(wallet, { redownloadSessionPrefix }));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const token = String(parsed.token || '');
      const expiresAtMs = Number(parsed.expiresAtMs || 0);
      if (!token || !Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs) return null;
      return { token, expiresAtMs };
    } catch (_) {
      return null;
    }
  }

  function storeRedownloadSession(
    wallet,
    token,
    expiresAtMs,
    { redownloadSessionPrefix = DEFAULT_REDOWNLOAD_SESSION_PREFIX } = {}
  ) {
    try {
      localStorage.setItem(
        redownloadSessionStorageKey(wallet, { redownloadSessionPrefix }),
        JSON.stringify({
          token: String(token || ''),
          expiresAtMs: Number(expiresAtMs || 0)
        })
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  function clearRedownloadSession(wallet, { redownloadSessionPrefix = DEFAULT_REDOWNLOAD_SESSION_PREFIX } = {}) {
    try {
      localStorage.removeItem(redownloadSessionStorageKey(wallet, { redownloadSessionPrefix }));
      return true;
    } catch (_) {
      return false;
    }
  }

  globalScope.PullMdStorage = {
    receiptStorageKey,
    parseAssetIdFromReceiptKey,
    collectStoredProofs,
    getStoredReceipt,
    storeReceipt,
    redownloadSessionStorageKey,
    getStoredRedownloadSession,
    storeRedownloadSession,
    clearRedownloadSession
  };
})(typeof window !== 'undefined' ? window : globalThis);
