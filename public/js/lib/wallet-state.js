(function attachSoulStarterWalletState(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  function normalizeWallet(wallet) {
    const raw = String(wallet || '').trim();
    if (!raw) return null;
    return raw.toLowerCase();
  }

  function updateWalletUI({
    walletAddress,
    buttonId = 'walletBtn',
    labelId = 'walletText',
    onDisconnect,
    onConnect
  } = {}) {
    const btn = document.getElementById(buttonId);
    const text = document.getElementById(labelId);
    if (!btn || !text) return;

    if (walletAddress) {
      text.textContent = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
      btn.classList.add('connected');
      btn.onclick = typeof onDisconnect === 'function' ? onDisconnect : null;
      return;
    }

    text.textContent = 'Connect Wallet';
    btn.classList.remove('connected');
    btn.onclick = typeof onConnect === 'function' ? onConnect : null;
  }

  function updateModeratorNavLinks({
    walletAddress,
    moderatorAllowlist = new Set(),
    selector = '.moderator-nav-link'
  } = {}) {
    const navLinks = document.querySelectorAll(selector);
    if (!navLinks.length) return;
    const show = Boolean(walletAddress && moderatorAllowlist.has(walletAddress));
    navLinks.forEach((el) => {
      el.style.display = show ? '' : 'none';
    });
  }

  function ownedSoulSetForWallet({ walletAddress, entitlementCacheByWallet } = {}) {
    const wallet = normalizeWallet(walletAddress);
    if (!wallet || !(entitlementCacheByWallet instanceof Map)) return new Set();
    return entitlementCacheByWallet.get(wallet) || new Set();
  }

  function createdSoulSetForWallet({ walletAddress, createdSoulCacheByWallet } = {}) {
    const wallet = normalizeWallet(walletAddress);
    if (!wallet || !(createdSoulCacheByWallet instanceof Map)) return new Set();
    return createdSoulCacheByWallet.get(wallet) || new Set();
  }

  function isSoulCreated({ walletAddress, soulId, createdSoulCacheByWallet } = {}) {
    if (!soulId) return false;
    const created = createdSoulSetForWallet({ walletAddress, createdSoulCacheByWallet });
    return created.has(soulId);
  }

  function isSoulAccessible({
    walletAddress,
    soulId,
    entitlementCacheByWallet,
    createdSoulCacheByWallet
  } = {}) {
    if (!soulId) return false;
    const owned = ownedSoulSetForWallet({ walletAddress, entitlementCacheByWallet });
    if (owned.has(soulId)) return true;
    const created = createdSoulSetForWallet({ walletAddress, createdSoulCacheByWallet });
    return created.has(soulId);
  }

  function collectStoredProofs({ wallet, storageHelper, receiptPrefix } = {}) {
    if (!wallet || !storageHelper || typeof storageHelper.collectStoredProofs !== 'function') return [];
    return storageHelper.collectStoredProofs(wallet, { receiptPrefix });
  }

  async function refreshEntitlementsForWallet({
    wallet,
    toolCall,
    storageHelper,
    receiptPrefix,
    entitlementCacheByWallet,
    onStateChanged
  } = {}) {
    const normalizedWallet = normalizeWallet(wallet);
    if (!normalizedWallet || !(entitlementCacheByWallet instanceof Map)) return new Set();

    const proofs = collectStoredProofs({
      wallet: normalizedWallet,
      storageHelper,
      receiptPrefix
    });

    if (proofs.length === 0) {
      const empty = new Set();
      entitlementCacheByWallet.set(normalizedWallet, empty);
      if (typeof onStateChanged === 'function') onStateChanged(empty);
      return empty;
    }

    let owned;
    try {
      const payload = await toolCall('check_entitlements', {
        wallet_address: normalizedWallet,
        proofs
      });
      owned = new Set(
        (Array.isArray(payload?.entitlements) ? payload.entitlements : [])
          .filter((entry) => entry?.entitled && entry?.soul_id)
          .map((entry) => String(entry.soul_id))
      );
    } catch (_) {
      owned = new Set(proofs.map((proof) => String(proof.soul_id)));
    }

    entitlementCacheByWallet.set(normalizedWallet, owned);
    if (typeof onStateChanged === 'function') onStateChanged(owned);
    return owned;
  }

  async function refreshCreatedSoulsForWallet({
    wallet,
    toolCall,
    createdSoulCacheByWallet,
    onStateChanged
  } = {}) {
    const normalizedWallet = normalizeWallet(wallet);
    if (!normalizedWallet || !(createdSoulCacheByWallet instanceof Map)) return new Set();

    let created;
    try {
      const payload = await toolCall('list_published_listings', {});
      created = new Set(
        (Array.isArray(payload?.listings) ? payload.listings : [])
          .filter((entry) => String(entry?.wallet_address || '').toLowerCase() === normalizedWallet)
          .map((entry) => String(entry?.soul_id || '').trim())
          .filter(Boolean)
      );
    } catch (_) {
      created = new Set();
    }

    createdSoulCacheByWallet.set(normalizedWallet, created);
    if (typeof onStateChanged === 'function') onStateChanged(created);
    return created;
  }

  async function loadModeratorAllowlist({
    onAllowlistLoaded
  } = {}) {
    let allowlist;
    try {
      const response = await fetch('/api/moderation?action=list_moderators', {
        method: 'GET',
        headers: { Accept: 'application/json' }
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(payload?.error || 'Failed to load moderators'));
      allowlist = new Set(
        (Array.isArray(payload?.moderators) ? payload.moderators : [])
          .map((wallet) => String(wallet || '').toLowerCase())
          .filter((wallet) => /^0x[a-f0-9]{40}$/i.test(wallet))
      );
    } catch (_) {
      allowlist = new Set();
    }

    if (typeof onAllowlistLoaded === 'function') {
      onAllowlistLoaded(allowlist);
    }
    return allowlist;
  }

  globalScope.SoulStarterWalletState = {
    updateWalletUI,
    updateModeratorNavLinks,
    ownedSoulSetForWallet,
    createdSoulSetForWallet,
    isSoulCreated,
    isSoulAccessible,
    collectStoredProofs,
    refreshEntitlementsForWallet,
    refreshCreatedSoulsForWallet,
    loadModeratorAllowlist
  };
})(typeof window !== 'undefined' ? window : globalThis);
