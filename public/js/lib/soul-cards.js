(function attachSoulStarterSoulCards(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  function escapeHtml(text) {
    if (typeof text !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatCardDescription(value, fallback) {
    const raw = String(value || '').replace(/\r?\n+/g, ' ').trim();
    if (!raw) return fallback;
    const cleaned = raw
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/[*_`~>#]+/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([:;,.!?])/g, '$1')
      .trim();
    return cleaned || fallback;
  }

  function formatSoulPriceLabel(asset) {
    const numericAmount = Number(asset?.price?.amount);
    if (Number.isFinite(numericAmount) && numericAmount >= 0) {
      return `$${numericAmount.toFixed(2)}`;
    }
    const fallback = String(asset?.price?.display || asset?.priceDisplay || '').replace(/\s*USDC$/i, '').trim();
    return fallback || '$0.00';
  }

  function getSoulGlyph(asset) {
    const name = String(asset?.name || asset?.id || 'Asset').trim();
    const clean = name.replace(/[^a-zA-Z0-9 ]/g, '');
    const parts = clean.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    if (parts.length === 1 && parts[0].length >= 2) {
      return parts[0].slice(0, 2).toUpperCase();
    }
    if (parts.length === 1 && parts[0].length === 1) {
      return `${parts[0].toUpperCase()}S`;
    }
    return 'MD';
  }

  function fileNameForAsset(asset) {
    const value = String(asset?.delivery?.file_name || asset?.file_name || '').trim();
    if (value && /\.md$/i.test(value)) return value;
    return 'ASSET.md';
  }

  function renderInventorySummary({ souls, errorMessage = '', containerId = 'liveInventorySummary' } = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const copy = container.querySelector('.hero-inventory-copy span');
    if (!copy) return;
    if (errorMessage) {
      copy.textContent = errorMessage;
      return;
    }
    if (!Array.isArray(souls) || souls.length === 0) {
      copy.textContent = 'No public markdown assets listed yet.';
      return;
    }
    const topNames = souls
      .slice(0, 3)
      .map((soul) => String(soul?.name || '').trim())
      .filter(Boolean)
      .join(', ');
    const minPrice = souls.reduce((min, soul) => {
      const amount = Number(soul?.price?.amount);
      if (!Number.isFinite(amount)) return min;
      return Math.min(min, amount);
    }, Number.POSITIVE_INFINITY);
    const minPriceLabel = Number.isFinite(minPrice) ? `$${minPrice.toFixed(2)}` : null;
    copy.textContent = `${souls.length} public asset${souls.length === 1 ? '' : 's'}${minPriceLabel ? ` · from ${minPriceLabel} USDC` : ''}${topNames ? ` · ${topNames}` : ''}`;
  }

  function buildOwnedSoulCardsHtml({
    soulIds = [],
    ownedSet = new Set(),
    createdSet = new Set(),
    soulsById = new Map(),
    listingHrefBuilder
  } = {}) {
    const ids = Array.from(soulIds);
    return ids
      .map((soulId) => {
        const soul = soulsById.get(soulId) || { id: soulId, name: soulId, description: 'Asset access available' };
        const cardDescription = formatCardDescription(soul.description, 'Asset access available');
        const fileName = fileNameForAsset(soul);
        const isOwned = ownedSet.has(soulId);
        const isCreated = createdSet.has(soulId);
        const sourceLabel = isOwned && isCreated ? 'Purchased and created' : isCreated ? 'Creator access' : 'Wallet entitlement';
        const listingHref =
          typeof listingHrefBuilder === 'function' ? String(listingHrefBuilder(soul.id || soulId) || '#') : '#';
        return `
      <article class="soul-card" data-owned-soul-id="${escapeHtml(String(soul.id || soulId))}">
        <div class="soul-card-glyph">${escapeHtml(getSoulGlyph(soul))}</div>
        <h3>${escapeHtml(String(soul.name || soul.id || soulId))}</h3>
        <p>${escapeHtml(cardDescription)}</p>
        <div class="soul-card-meta">
          <div class="soul-lineage">
            ${isOwned ? '<span class="badge badge-organic">Owned</span>' : ''}
            ${isCreated ? '<span class="badge badge-synthetic">Created</span>' : ''}
            <span style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(sourceLabel)}</span>
          </div>
        </div>
        <div class="soul-card-actions">
          <a class="btn btn-ghost" href="${escapeHtml(listingHref)}">View Listing</a>
          <button class="btn btn-primary" onclick="downloadOwnedSoul('${escapeHtml(String(soul.id || soulId))}', '${escapeHtml(fileName)}')">Download ${escapeHtml(fileName)}</button>
        </div>
      </article>
    `;
      })
      .join('');
  }

  function buildCatalogSoulCardsHtml({
    souls = [],
    isAccessible,
    listingHrefBuilder,
    lineageLabelForSoul
  } = {}) {
    return (Array.isArray(souls) ? souls : [])
      .map((soul) => {
        const soulId = String(soul?.id || '').trim();
        const fileName = fileNameForAsset(soul);
        const owned = typeof isAccessible === 'function' ? Boolean(isAccessible(soulId)) : false;
        const cta = owned ? `Download ${fileName}` : `Purchase ${fileName}`;
        const lineageLabel = typeof lineageLabelForSoul === 'function' ? String(lineageLabelForSoul(soul) || '') : '';
        const type = String(soul?.asset_type || soul?.provenance?.type || 'hybrid').toLowerCase();
        const cardDescription = formatCardDescription(soul?.description, 'Markdown listing available.');
        const priceLabel = formatSoulPriceLabel(soul);
        const listingHref = typeof listingHrefBuilder === 'function' ? String(listingHrefBuilder(soulId) || '#') : '#';
        const fallbackCreator = String(soul?.creator_address || soul?.wallet_address || soul?.seller_address || '-').trim();
        return `
      <article class="soul-card" data-soul-id="${escapeHtml(soulId)}">
        <div class="soul-card-glyph">${escapeHtml(getSoulGlyph(soul))}</div>
        <h3>${escapeHtml(String(soul?.name || soulId))}</h3>
        <p>${escapeHtml(cardDescription)}</p>
        ${
          soul?.source_url
            ? `<a class="soul-source-link" href="${escapeHtml(String(soul.source_url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(
                String(soul?.source_label || 'Source')
              )}</a>`
            : ''
        }
        <div class="soul-card-meta">
          <div class="soul-lineage">
            <span class="badge badge-${escapeHtml(type)}">${escapeHtml(type)}</span>
            <span class="lineage-mini">${escapeHtml(lineageLabel || `Creator ${fallbackCreator}`)}</span>
          </div>
          <div>
            <span class="price">${escapeHtml(priceLabel)}</span>
            <span class="currency">USDC</span>
          </div>
        </div>
        <div class="soul-card-actions">
          <a class="btn btn-ghost" href="${escapeHtml(listingHref)}">View Listing</a>
          <button class="btn btn-primary" onclick="${owned ? `downloadOwnedSoul('${escapeHtml(soulId)}', '${escapeHtml(fileName)}')` : `purchaseSoul('${escapeHtml(soulId)}', '${escapeHtml(fileName)}')`}">${escapeHtml(cta)}</button>
        </div>
      </article>
    `;
      })
      .join('');
  }

  globalScope.SoulStarterSoulCards = {
    escapeHtml,
    formatCardDescription,
    formatSoulPriceLabel,
    getSoulGlyph,
    renderInventorySummary,
    buildOwnedSoulCardsHtml,
    buildCatalogSoulCardsHtml
  };
})(typeof window !== 'undefined' ? window : globalThis);
