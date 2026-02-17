(function attachSoulStarterCatalogUi(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  function updateSoulPagePurchaseState({
    soulDetailUiHelper,
    walletAddress,
    currentSoulDetailId,
    soulCatalogCache,
    isSoulAccessible,
    onPurchaseClick,
    buyButtonId = 'buyBtn'
  } = {}) {
    if (!soulDetailUiHelper || typeof soulDetailUiHelper.updateSoulPagePurchaseState !== 'function') return;
    soulDetailUiHelper.updateSoulPagePurchaseState({
      walletAddress,
      currentSoulDetailId,
      soulCatalogCache,
      isSoulAccessible,
      buyButtonId,
      onPurchaseClick
    });
  }

  function updateSoulDetailMetadata({
    soul,
    soulDetailUiHelper,
    escapeHtml,
    getSoulGlyph,
    shortenAddress,
    formatCreatorLabelFn,
    buyButtonId = 'buyBtn'
  } = {}) {
    if (!soulDetailUiHelper || typeof soulDetailUiHelper.updateSoulDetailMetadata !== 'function') {
      return null;
    }

    soulDetailUiHelper.updateSoulDetailMetadata({
      soul,
      escapeHtml,
      getSoulGlyph,
      shortenAddress,
      formatCreatorLabelFn
    });

    if (!soul?.id) return null;
    const currentSoulDetailId = String(soul.id);
    const btn = document.getElementById(buyButtonId);
    if (btn) btn.dataset.soulId = currentSoulDetailId;
    document.title = `${String(soul.name || soul.id)} — SoulStarter`;
    const descMeta = document.querySelector('meta[name="description"]');
    if (descMeta) descMeta.setAttribute('content', String(soul.description || 'SoulStarter listing details.'));
    return currentSoulDetailId;
  }

  async function hydrateSoulDetailPage({
    soulDetailUiHelper,
    mcpToolCall,
    currentSoulDetailId = null,
    soulCatalogCache = [],
    setSoulCatalogCache,
    updateSoulDetailMetadata,
    updateSoulPagePurchaseState,
    showToast,
    pageRootId = 'soulDetailPage',
    buyButtonId = 'buyBtn'
  } = {}) {
    const pageRoot = document.getElementById(pageRootId);
    if (!pageRoot) {
      return { hydrated: false, currentSoulDetailId };
    }
    if (!soulDetailUiHelper || typeof soulDetailUiHelper.soulIdFromLocation !== 'function') {
      return { hydrated: false, currentSoulDetailId };
    }

    const soulId = soulDetailUiHelper.soulIdFromLocation(window.location);
    const btn = document.getElementById(buyButtonId);
    if (btn) {
      btn.textContent = 'Loading...';
      btn.disabled = true;
    }
    if (!soulId) {
      if (typeof showToast === 'function') showToast('Missing soul id in URL', 'error');
      if (btn) btn.textContent = 'Unavailable';
      return { hydrated: true, currentSoulDetailId };
    }

    try {
      const payload = await mcpToolCall('get_soul_details', { id: soulId });
      const soul = payload?.soul || null;
      if (!soul) throw new Error('Soul metadata unavailable');
      const mergedCatalog = [
        soul,
        ...(Array.isArray(soulCatalogCache) ? soulCatalogCache.filter((item) => item.id !== soul.id) : [])
      ];
      if (typeof setSoulCatalogCache === 'function') {
        setSoulCatalogCache(mergedCatalog);
      }
      const nextSoulDetailId = typeof updateSoulDetailMetadata === 'function'
        ? updateSoulDetailMetadata(soul)
        : currentSoulDetailId;
      if (typeof updateSoulPagePurchaseState === 'function') updateSoulPagePurchaseState();
      if (btn) btn.disabled = false;
      return { hydrated: true, currentSoulDetailId: nextSoulDetailId || currentSoulDetailId };
    } catch (error) {
      if (typeof showToast === 'function') showToast(error?.message || 'Unable to load soul details', 'error');
      const name = document.getElementById('soulDetailName');
      if (name) name.textContent = 'Soul unavailable';
      const description = document.getElementById('soulDetailDescription');
      if (description) description.textContent = 'This listing could not be loaded.';
      if (btn) {
        btn.textContent = 'Unavailable';
        btn.disabled = true;
      }
      return { hydrated: true, currentSoulDetailId };
    }
  }

  function renderOwnedSouls({
    walletAddress,
    soulCatalogCache = [],
    ownedSoulSetForCurrentWallet,
    createdSoulSetForCurrentWallet,
    soulCardsHelper,
    listingHrefBuilder,
    containerId = 'ownedSoulsGrid'
  } = {}) {
    const grid = document.getElementById(containerId);
    if (!grid) return;

    if (!walletAddress) {
      grid.innerHTML = '<p class="admin-empty">Connect your wallet to view your purchased and created souls.</p>';
      return;
    }

    const owned = typeof ownedSoulSetForCurrentWallet === 'function' ? ownedSoulSetForCurrentWallet() : new Set();
    const created = typeof createdSoulSetForCurrentWallet === 'function' ? createdSoulSetForCurrentWallet() : new Set();
    const allSoulIds = new Set([...owned, ...created]);
    if (!allSoulIds.size) {
      grid.innerHTML = '<p class="admin-empty">No purchased or created souls found for this wallet yet.</p>';
      return;
    }

    const byId = new Map((Array.isArray(soulCatalogCache) ? soulCatalogCache : []).map((soul) => [soul.id, soul]));
    grid.innerHTML = soulCardsHelper.buildOwnedSoulCardsHtml({
      soulIds: [...allSoulIds],
      ownedSet: owned,
      createdSet: created,
      soulsById: byId,
      listingHrefBuilder
    });
  }

  async function loadSouls({
    fetchWithTimeout,
    soulCardsHelper,
    soulCatalogCache = [],
    setSoulCatalogCache,
    renderInventorySummary,
    renderOwnedSouls,
    isSoulAccessible,
    listingHrefBuilder,
    lineageLabelForSoul,
    soulsGridId = 'soulsGrid'
  } = {}) {
    const grid = document.getElementById(soulsGridId);
    if (!grid) {
      if (typeof renderOwnedSouls === 'function') renderOwnedSouls();
      return { souls: Array.isArray(soulCatalogCache) ? soulCatalogCache : [], loaded: false };
    }

    try {
      const response = await fetchWithTimeout('/api/souls');
      if (!response.ok) throw new Error('Failed to load soul catalog');
      const payload = await response.json();
      const souls = payload.souls || [];
      if (typeof setSoulCatalogCache === 'function') {
        setSoulCatalogCache(souls);
      }
      if (typeof renderInventorySummary === 'function') {
        renderInventorySummary(souls);
      }

      if (!souls.length) {
        grid.innerHTML =
          '<p class="admin-empty">No public souls are listed yet. Use <a href="/create.html">Create</a> to publish the first listing.</p>';
        if (typeof renderOwnedSouls === 'function') renderOwnedSouls();
        return { souls, loaded: true };
      }

      grid.innerHTML = soulCardsHelper.buildCatalogSoulCardsHtml({
        souls,
        isAccessible: isSoulAccessible,
        listingHrefBuilder,
        lineageLabelForSoul
      });
      if (typeof renderOwnedSouls === 'function') renderOwnedSouls();
      return { souls, loaded: true };
    } catch (error) {
      console.error('Catalog load failed:', error);
      grid.innerHTML = '<p>Souls are temporarily unavailable. Please try again.</p>';
      if (typeof renderInventorySummary === 'function') {
        renderInventorySummary([], 'Souls are temporarily unavailable.');
      }
      if (typeof renderOwnedSouls === 'function') renderOwnedSouls();
      return { souls: [], loaded: true, error };
    }
  }

  globalScope.SoulStarterCatalogUi = {
    updateSoulPagePurchaseState,
    updateSoulDetailMetadata,
    hydrateSoulDetailPage,
    renderOwnedSouls,
    loadSouls
  };
})(typeof window !== 'undefined' ? window : globalThis);
