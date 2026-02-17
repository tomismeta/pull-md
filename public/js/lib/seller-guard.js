(function attachSoulStarterSellerGuard(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  function normalizeAddress(address) {
    try {
      return ethers.getAddress(String(address || '').trim());
    } catch (_) {
      return null;
    }
  }

  async function resolveExpectedSellerAddress({
    soulId,
    defaultSellerAddress,
    cache,
    fetchSoulDetails
  } = {}) {
    if (cache && typeof cache.get === 'function' && cache.has(soulId)) {
      return cache.get(soulId);
    }

    try {
      const payload = typeof fetchSoulDetails === 'function' ? await fetchSoulDetails(soulId) : null;
      const seller = payload?.soul?.seller_address;
      const normalized = normalizeAddress(seller || defaultSellerAddress);
      if (!normalized) throw new Error('invalid seller');
      if (cache && typeof cache.set === 'function') {
        cache.set(soulId, normalized);
      }
      return normalized;
    } catch (_) {
      return normalizeAddress(defaultSellerAddress);
    }
  }

  globalScope.SoulStarterSellerGuard = {
    normalizeAddress,
    resolveExpectedSellerAddress
  };
})(typeof window !== 'undefined' ? window : globalThis);
