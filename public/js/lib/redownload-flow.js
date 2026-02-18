(function attachSoulStarterRedownloadFlow(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  async function ensureRedownloadSession({
    wallet,
    signer,
    apiBase = '/api',
    fetchWithTimeout,
    readError,
    buildSiweAuthMessage,
    getStoredSession,
    storeSession
  } = {}) {
    if (!wallet || !signer) throw new Error('Connect your wallet first');
    if (typeof fetchWithTimeout !== 'function' || typeof readError !== 'function') {
      throw new Error('Network helpers are required');
    }
    if (typeof buildSiweAuthMessage !== 'function') {
      throw new Error('SIWE message builder is required');
    }

    const existing = typeof getStoredSession === 'function' ? getStoredSession(wallet) : null;
    if (existing) return existing;

    const requestTimestamp = Date.now();
    const siwePayload = await buildSiweAuthMessage({
      wallet,
      soulId: '*',
      action: 'session',
      timestamp: requestTimestamp
    });
    const siwe =
      typeof siwePayload === 'string'
        ? siwePayload
        : String(siwePayload?.message || '').trim();
    const timestamp = Number.isFinite(Number(siwePayload?.timestamp))
      ? Number(siwePayload.timestamp)
      : requestTimestamp;
    if (!siwe || !Number.isFinite(timestamp)) {
      throw new Error('Failed to build wallet session challenge');
    }
    const signature = await signer.signMessage(siwe);
    const response = await fetchWithTimeout(`${apiBase}/auth/session`, {
      method: 'GET',
      headers: {
        'X-WALLET-ADDRESS': wallet,
        'X-AUTH-SIGNATURE': signature,
        'X-AUTH-TIMESTAMP': String(timestamp),
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      const error = await readError(response);
      throw new Error(error || 'Session authentication failed');
    }

    const body = await response.json().catch(() => ({}));
    const token = response.headers.get('X-REDOWNLOAD-SESSION') || body?.token || null;
    const expiresAtMs = Number(body?.expires_at_ms || Date.now() + 10 * 60 * 1000);
    if (token && typeof storeSession === 'function') {
      storeSession(wallet, token, expiresAtMs);
    }
    return { token, expiresAtMs };
  }

  async function attemptRedownload({
    soulId,
    wallet,
    signer,
    apiBase = '/api',
    fetchWithTimeout,
    readError,
    getStoredReceipt,
    storeReceipt,
    hasCreatorAccess = false,
    getStoredSession,
    storeSession,
    buildSiweAuthMessage,
    readSettlementTx,
    onSuccess
  } = {}) {
    if (!wallet || !signer) return { ok: false, requiresPayment: true };

    const receipt = typeof getStoredReceipt === 'function' ? getStoredReceipt(soulId, wallet) : null;
    const createdAccess = typeof hasCreatorAccess === 'function' ? hasCreatorAccess(soulId) : Boolean(hasCreatorAccess);
    if (!receipt && !createdAccess) return { ok: false, requiresPayment: true };

    const activeSession = typeof getStoredSession === 'function' ? getStoredSession(wallet) : null;
    const passiveHeaders = {
      'X-WALLET-ADDRESS': wallet,
      Accept: 'text/markdown'
    };
    if (receipt) passiveHeaders['X-PURCHASE-RECEIPT'] = receipt;
    if (activeSession?.token) passiveHeaders['X-REDOWNLOAD-SESSION'] = activeSession.token;

    const passive = await fetchWithTimeout(`${apiBase}/assets/${encodeURIComponent(soulId)}/download`, {
      method: 'GET',
      headers: passiveHeaders
    });

    if (passive.ok) {
      const content = await passive.text();
      const tx = typeof readSettlementTx === 'function' ? readSettlementTx(passive) : null;
      const refreshedReceipt = passive.headers.get('X-PURCHASE-RECEIPT');
      if (refreshedReceipt && typeof storeReceipt === 'function') {
        storeReceipt(soulId, wallet, refreshedReceipt);
      }
      if (typeof onSuccess === 'function') {
        onSuccess({ content, tx, soulId, restored: true });
      }
      return { ok: true };
    }

    if (passive.status !== 401 && passive.status !== 402) {
      const error = await readError(passive);
      throw new Error(error || 'Re-download failed');
    }

    await ensureRedownloadSession({
      wallet,
      signer,
      apiBase,
      fetchWithTimeout,
      readError,
      buildSiweAuthMessage,
      getStoredSession,
      storeSession
    });

    const refreshedSession = typeof getStoredSession === 'function' ? getStoredSession(wallet) : null;
    const retryHeaders = {
      'X-WALLET-ADDRESS': wallet,
      Accept: 'text/markdown'
    };
    if (receipt) retryHeaders['X-PURCHASE-RECEIPT'] = receipt;
    if (refreshedSession?.token) retryHeaders['X-REDOWNLOAD-SESSION'] = refreshedSession.token;

    const signed = await fetchWithTimeout(`${apiBase}/assets/${encodeURIComponent(soulId)}/download`, {
      method: 'GET',
      headers: retryHeaders
    });

    if (signed.ok) {
      const content = await signed.text();
      const tx = typeof readSettlementTx === 'function' ? readSettlementTx(signed) : null;
      const refreshedReceipt = signed.headers.get('X-PURCHASE-RECEIPT');
      if (refreshedReceipt && typeof storeReceipt === 'function') {
        storeReceipt(soulId, wallet, refreshedReceipt);
      }
      if (typeof onSuccess === 'function') {
        onSuccess({ content, tx, soulId, restored: true });
      }
      return { ok: true };
    }

    if (signed.status === 401 || signed.status === 402) {
      return { ok: false, requiresPayment: true };
    }
    const error = await readError(signed);
    throw new Error(error || 'Re-download failed');
  }

  globalScope.SoulStarterRedownloadFlow = {
    ensureRedownloadSession,
    attemptRedownload
  };
})(typeof window !== 'undefined' ? window : globalThis);
