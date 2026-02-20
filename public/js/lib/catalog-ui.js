(function attachPullMdCatalogUi(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  function normalizeSearchText(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function filterSoulsByQuery(souls = [], searchQuery = '') {
    const normalized = normalizeSearchText(searchQuery);
    if (!normalized) return Array.isArray(souls) ? souls : [];
    const terms = normalized.split(/\s+/).filter(Boolean);
    if (!terms.length) return Array.isArray(souls) ? souls : [];

    return (Array.isArray(souls) ? souls : []).filter((soul) => {
      const haystack = normalizeSearchText(
        [
          soul?.id,
          soul?.name,
          soul?.description,
          soul?.asset_type,
          soul?.file_name,
          soul?.creator_address,
          soul?.wallet_address,
          soul?.seller_address,
          ...(Array.isArray(soul?.tags) ? soul.tags : [])
        ]
          .filter(Boolean)
          .join(' ')
      );
      return terms.every((term) => haystack.includes(term));
    });
  }

  function renderCatalogGrid({
    grid,
    souls = [],
    searchQuery = '',
    soulCardsHelper,
    isSoulAccessible,
    listingHrefBuilder,
    lineageLabelForSoul
  } = {}) {
    if (!grid) return [];
    const filtered = filterSoulsByQuery(souls, searchQuery);
    if (!filtered.length) {
      const hasQuery = String(searchQuery || '').trim().length > 0;
      grid.innerHTML = hasQuery
        ? '<p class="admin-empty">No listings match your search. Try fewer or broader keywords.</p>'
        : '<p class="admin-empty">No public assets are listed yet. Use <a href="/create.html">Create</a> to publish the first listing.</p>';
      return filtered;
    }
    grid.innerHTML = soulCardsHelper.buildCatalogSoulCardsHtml({
      souls: filtered,
      isAccessible: isSoulAccessible,
      listingHrefBuilder,
      lineageLabelForSoul
    });
    return filtered;
  }

  function updateAssetPagePurchaseState({
    assetDetailUiHelper,
    walletAddress,
    currentAssetDetailId,
    soulCatalogCache,
    isSoulAccessible,
    onPurchaseClick,
    buyButtonId = 'buyBtn'
  } = {}) {
    if (!assetDetailUiHelper || typeof assetDetailUiHelper.updateAssetPagePurchaseState !== 'function') return;
    assetDetailUiHelper.updateAssetPagePurchaseState({
      walletAddress,
      currentAssetDetailId,
      soulCatalogCache,
      isSoulAccessible,
      buyButtonId,
      onPurchaseClick
    });
  }

  function updateAssetDetailMetadata({
    soul,
    assetDetailUiHelper,
    escapeHtml,
    getSoulGlyph,
    shortenAddress,
    formatCreatorLabelFn,
    buyButtonId = 'buyBtn'
  } = {}) {
    if (!assetDetailUiHelper || typeof assetDetailUiHelper.updateAssetDetailMetadata !== 'function') {
      return null;
    }

    assetDetailUiHelper.updateAssetDetailMetadata({
      soul,
      escapeHtml,
      getSoulGlyph,
      shortenAddress,
      formatCreatorLabelFn
    });

    if (!soul?.id) return null;
    const currentAssetDetailId = String(soul.id);
    const btn = document.getElementById(buyButtonId);
    if (btn) btn.dataset.soulId = currentAssetDetailId;
    document.title = `${String(soul.name || soul.id)} — PULL.md`;
    const descMeta = document.querySelector('meta[name="description"]');
    if (descMeta) descMeta.setAttribute('content', String(soul.description || 'PULL.md listing details.'));
    return currentAssetDetailId;
  }

async function hydrateAssetDetailPage({
    assetDetailUiHelper,
    toolCall,
    currentAssetDetailId = null,
    soulCatalogCache = [],
    setSoulCatalogCache,
    updateAssetDetailMetadata,
    updateAssetPagePurchaseState,
    showToast,
    pageRootId = 'assetDetailPage',
    buyButtonId = 'buyBtn'
  } = {}) {
    const pageRoot = document.getElementById(pageRootId);
    if (!pageRoot) {
      return { hydrated: false, currentAssetDetailId };
    }
    if (!assetDetailUiHelper || typeof assetDetailUiHelper.assetIdFromLocation !== 'function') {
      return { hydrated: false, currentAssetDetailId };
    }

    const assetId = assetDetailUiHelper.assetIdFromLocation(window.location);
    const btn = document.getElementById(buyButtonId);
    if (btn) {
      btn.textContent = 'Loading...';
      btn.disabled = true;
    }
    if (!assetId) {
      if (typeof showToast === 'function') showToast('Missing asset id in URL', 'error');
      if (btn) btn.textContent = 'Unavailable';
      return { hydrated: true, currentAssetDetailId };
    }

    try {
      const payload = await toolCall('get_asset_details', { id: assetId });
      const soul = payload?.asset || payload?.soul || null;
      if (!soul) throw new Error('Asset metadata unavailable');
      const mergedCatalog = [
        soul,
        ...(Array.isArray(soulCatalogCache) ? soulCatalogCache.filter((item) => item.id !== soul.id) : [])
      ];
      if (typeof setSoulCatalogCache === 'function') {
        setSoulCatalogCache(mergedCatalog);
      }
      const nextAssetDetailId = typeof updateAssetDetailMetadata === 'function'
        ? updateAssetDetailMetadata(soul)
        : currentAssetDetailId;
      if (typeof updateAssetPagePurchaseState === 'function') updateAssetPagePurchaseState();
      if (btn) btn.disabled = false;
      return { hydrated: true, currentAssetDetailId: nextAssetDetailId || currentAssetDetailId };
    } catch (error) {
      if (typeof showToast === 'function') showToast(error?.message || 'Unable to load asset details', 'error');
      const name = document.getElementById('assetDetailName');
      if (name) name.textContent = 'Asset unavailable';
      const description = document.getElementById('assetDetailDescription');
      if (description) description.textContent = 'This listing could not be loaded.';
      if (btn) {
        btn.textContent = 'Unavailable';
        btn.disabled = true;
      }
      return { hydrated: true, currentAssetDetailId };
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
      grid.innerHTML = '<p class="admin-empty">Connect your wallet to view your purchased and created assets.</p>';
      return;
    }

    const owned = typeof ownedSoulSetForCurrentWallet === 'function' ? ownedSoulSetForCurrentWallet() : new Set();
    const created = typeof createdSoulSetForCurrentWallet === 'function' ? createdSoulSetForCurrentWallet() : new Set();
    const allSoulIds = new Set([...owned, ...created]);
    if (!allSoulIds.size) {
      grid.innerHTML = '<p class="admin-empty">No purchased or created assets found for this wallet yet.</p>';
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
    soulsGridId = 'soulsGrid',
    assetType = 'all',
    searchQuery = ''
  } = {}) {
    const grid = document.getElementById(soulsGridId);
    if (!grid) {
      if (typeof renderOwnedSouls === 'function') renderOwnedSouls();
      return { souls: Array.isArray(soulCatalogCache) ? soulCatalogCache : [], loaded: false };
    }

    try {
      const normalizedType = String(assetType || 'all').trim().toLowerCase();
      const query = normalizedType && normalizedType !== 'all'
        ? `?asset_type=${encodeURIComponent(normalizedType)}`
        : '';
      const response = await fetchWithTimeout(`/api/assets${query}`);
      if (!response.ok) throw new Error('Failed to load asset catalog');
      const payload = await response.json();
      const souls = payload.assets || payload.souls || [];
      if (typeof setSoulCatalogCache === 'function') {
        setSoulCatalogCache(souls);
      }
      const visible = renderCatalogGrid({
        grid,
        souls,
        searchQuery,
        soulCardsHelper,
        isSoulAccessible,
        listingHrefBuilder,
        lineageLabelForSoul
      });
      if (typeof renderInventorySummary === 'function') {
        renderInventorySummary(visible, '');
      }
      if (typeof renderOwnedSouls === 'function') renderOwnedSouls();
      return { souls, loaded: true };
    } catch (error) {
      console.error('Catalog load failed:', error);
      grid.innerHTML = '<p>Assets are temporarily unavailable. Please try again.</p>';
      if (typeof renderInventorySummary === 'function') {
        renderInventorySummary([], 'Assets are temporarily unavailable.');
      }
      if (typeof renderOwnedSouls === 'function') renderOwnedSouls();
      return { souls: [], loaded: true, error };
    }
  }

  globalScope.PullMdCatalogUi = {
    updateAssetPagePurchaseState,
    updateAssetDetailMetadata,
    hydrateAssetDetailPage,
    renderOwnedSouls,
    loadSouls,
    filterSoulsByQuery,
    renderCatalogGrid
  };
})(typeof window !== 'undefined' ? window : globalThis);
