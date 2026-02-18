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
    cache,
    fetchSoulDetails
  } = {}) {
    if (cache && typeof cache.get === 'function' && cache.has(soulId)) {
      return cache.get(soulId);
    }

    try {
      const payload = typeof fetchSoulDetails === 'function' ? await fetchSoulDetails(soulId) : null;
      const seller =
        payload?.asset?.seller_address ||
        payload?.asset?.sellerAddress ||
        payload?.asset?.creator_address ||
        payload?.asset?.wallet_address ||
        payload?.soul?.seller_address ||
        payload?.soul?.sellerAddress ||
        payload?.soul?.creator_address ||
        payload?.soul?.wallet_address;
      const normalized = normalizeAddress(seller);
      if (!normalized) throw new Error('invalid seller');
      if (cache && typeof cache.set === 'function') {
        cache.set(soulId, normalized);
      }
      return normalized;
    } catch (_) {
      return null;
    }
  }

  globalScope.SoulStarterSellerGuard = {
    normalizeAddress,
    resolveExpectedSellerAddress
  };
})(typeof window !== 'undefined' ? window : globalThis);
