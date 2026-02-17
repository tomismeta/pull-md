(function attachSoulStarterStorage(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  const DEFAULT_RECEIPT_PREFIX = 'soulstarter.receipt.';
  const DEFAULT_REDOWNLOAD_SESSION_PREFIX = 'soulstarter.redownload.session.';

  function receiptStorageKey(wallet, soulId, { receiptPrefix = DEFAULT_RECEIPT_PREFIX } = {}) {
    const normalizedWallet = String(wallet || '').toLowerCase().trim();
    const normalizedSoulId = String(soulId || '').trim();
    if (!normalizedWallet || !normalizedSoulId) return '';
    return `${receiptPrefix}${normalizedWallet}.${normalizedSoulId}`;
  }

  function parseSoulIdFromReceiptKey(key, wallet, { receiptPrefix = DEFAULT_RECEIPT_PREFIX } = {}) {
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
        const soulId = parseSoulIdFromReceiptKey(key, normalizedWallet, { receiptPrefix });
        if (!soulId) continue;
        const receipt = localStorage.getItem(String(key || ''));
        if (!receipt) continue;
        proofs.push({ soul_id: soulId, receipt });
      }
    } catch (_) {}
    return proofs;
  }

  function getStoredReceipt(soulId, wallet, { receiptPrefix = DEFAULT_RECEIPT_PREFIX } = {}) {
    try {
      const key = receiptStorageKey(wallet, soulId, { receiptPrefix });
      if (!key) return null;
      return localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function storeReceipt(soulId, wallet, receipt, { receiptPrefix = DEFAULT_RECEIPT_PREFIX } = {}) {
    try {
      const key = receiptStorageKey(wallet, soulId, { receiptPrefix });
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

  globalScope.SoulStarterStorage = {
    receiptStorageKey,
    parseSoulIdFromReceiptKey,
    collectStoredProofs,
    getStoredReceipt,
    storeReceipt,
    redownloadSessionStorageKey,
    getStoredRedownloadSession,
    storeRedownloadSession,
    clearRedownloadSession
  };
})(typeof window !== 'undefined' ? window : globalThis);
