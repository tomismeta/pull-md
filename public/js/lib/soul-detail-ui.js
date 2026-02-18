(function attachSoulStarterSoulDetailUi(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  function soulIdFromLocation(locationLike = globalScope.location) {
    const search = String(locationLike?.search || '');
    const params = new URLSearchParams(search);
    return params.get('id') || '';
  }

  function soulListingHref(soulId) {
    return `/asset.html?id=${encodeURIComponent(String(soulId || ''))}`;
  }

  function formatCreatorLabel(raw, shortenAddress = (value) => String(value || '-')) {
    const text = String(raw || '').trim();
    if (!text) return 'Creator -';
    const match = text.match(/0x[a-fA-F0-9]{40}/);
    if (match) {
      return `Creator ${shortenAddress(match[0])}`;
    }
    if (/^0x[a-fA-F0-9]{40}$/.test(text)) {
      return `Creator ${shortenAddress(text)}`;
    }
    return text;
  }

  function hashToneClass(seed) {
    const value = String(seed || 'asset');
    const tones = ['hash-tone-blue', 'hash-tone-orange', 'hash-tone-green', 'hash-tone-purple', 'hash-tone-yellow'];
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash * 31 + value.charCodeAt(i)) | 0;
    }
    return tones[Math.abs(hash) % tones.length];
  }

  function updateSoulDetailMetadata({
    soul,
    escapeHtml,
    getSoulGlyph,
    shortenAddress,
    formatCreatorLabelFn = formatCreatorLabel
  } = {}) {
    if (!soul) return;
    const safeEscape = typeof escapeHtml === 'function' ? escapeHtml : (value) => String(value || '');
    const glyphForSoul = typeof getSoulGlyph === 'function' ? getSoulGlyph : () => 'SS';
    const safeShorten = typeof shortenAddress === 'function' ? shortenAddress : (value) => String(value || '-');
    const formatCreator = typeof formatCreatorLabelFn === 'function' ? formatCreatorLabelFn : formatCreatorLabel;

    const hash = document.getElementById('soulDetailHash');
    if (hash) {
      hash.className = `title-hash ${hashToneClass(String(soul.id || soul.name || 'asset'))}`;
      hash.textContent = '#';
    }

    const heading = document.getElementById('soulDetailName');
    if (heading) heading.textContent = String(soul.name || soul.id || 'Asset');

    const subtitle = document.getElementById('soulDetailDescription');
    if (subtitle) subtitle.textContent = String(soul.description || 'No description available.');

    const preview = document.getElementById('soulDetailPreview');
    if (preview) preview.textContent = String(soul.preview?.excerpt || soul.description || 'No preview available.');

    const lineage = document.getElementById('soulDetailLineage');
    if (lineage) {
      const creatorHint = soul.provenance?.raised_by || soul.creator_address || soul.wallet_address || soul.seller_address || '';
      lineage.textContent = formatCreator(String(creatorHint));
    }

    const typeBadge = document.getElementById('soulDetailType');
    if (typeBadge) {
      const type = String((soul.asset_type || soul.provenance?.type || 'hybrid')).toLowerCase();
      typeBadge.className = `badge badge-${safeEscape(type)}`;
      typeBadge.textContent = type;
    }

    const tagsWrap = document.getElementById('soulDetailTags');
    if (tagsWrap) {
      const values = Array.isArray(soul.tags) ? soul.tags.filter(Boolean).slice(0, 6) : [];
      tagsWrap.innerHTML = values.length
        ? values.map((tag) => `<span class="tag">${safeEscape(String(tag))}</span>`).join('')
        : '<span class="tag">untagged</span>';
    }

    const price = document.getElementById('soulDetailPrice');
    if (price) {
      const display = String(soul.price?.display || '').replace(/\s*USDC$/i, '');
      price.textContent = display || '$0.00';
    }

    const note = document.getElementById('soulDetailPurchaseNote');
    if (note) {
      const seller = soul.seller_address ? safeShorten(soul.seller_address) : 'seller wallet';
      note.textContent = `Paid access via x402. Settlement recipient: ${seller}.`;
    }

    const fileNameEl = document.getElementById('assetDetailFileName');
    if (fileNameEl) {
      const fileName = String(soul?.delivery?.file_name || soul?.file_name || 'ASSET.md').trim();
      fileNameEl.textContent = fileName || 'ASSET.md';
    }
  }

  function updateSoulPagePurchaseState({
    walletAddress,
    currentSoulDetailId,
    soulCatalogCache = [],
    isSoulAccessible,
    buyButtonId = 'buyBtn',
    onPurchaseClick
  } = {}) {
    const btn = document.getElementById(buyButtonId);
    if (!btn) return;
    const soulId = String(btn.dataset.soulId || '').trim();
    if (!soulId) {
      const onclick = String(btn.getAttribute('onclick') || '');
      const match = onclick.match(/purchaseSoul\(['"]([^'"]+)['"]\)/);
      if (!match?.[1]) return;
      btn.dataset.soulId = match[1];
    }
    const resolvedSoulId = String(btn.dataset.soulId || '').trim();
    if (!resolvedSoulId) return;
    if (typeof onPurchaseClick === 'function') {
      btn.onclick = () => onPurchaseClick(resolvedSoulId, btn.dataset.fileName || 'ASSET.md');
      btn.removeAttribute('onclick');
    }
    const matching = Array.isArray(soulCatalogCache)
      ? soulCatalogCache.find((item) => String(item?.id || '') === resolvedSoulId)
      : null;
    const fileName = String(matching?.delivery?.file_name || matching?.file_name || 'ASSET.md').trim() || 'ASSET.md';
    btn.dataset.fileName = fileName;
    const accessible =
      typeof isSoulAccessible === 'function' ? Boolean(isSoulAccessible(resolvedSoulId)) : Boolean(walletAddress);
    btn.textContent = accessible ? `Download ${fileName}` : `Purchase ${fileName}`;
    btn.className = accessible ? 'btn btn-ghost btn-lg btn-full' : 'btn btn-primary btn-lg btn-full';
  }

  globalScope.SoulStarterSoulDetailUi = {
    soulIdFromLocation,
    soulListingHref,
    formatCreatorLabel,
    updateSoulDetailMetadata,
    updateSoulPagePurchaseState
  };
})(typeof window !== 'undefined' ? window : globalThis);
