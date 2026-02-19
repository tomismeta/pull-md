(function attachPullMdWalletProviders(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  const providerMetadata = new WeakMap();
  let providerDiscoveryInitialized = false;

  function getProviderMetadata(rawProvider) {
    return providerMetadata.get(rawProvider) || { name: '', rdns: '' };
  }

  function initDiscovery() {
    if (providerDiscoveryInitialized || typeof window === 'undefined') return;
    providerDiscoveryInitialized = true;

    window.addEventListener('eip6963:announceProvider', (event) => {
      const detail = event?.detail;
      if (!detail || typeof detail !== 'object') return;
      const announcedProvider = detail.provider;
      if (!announcedProvider || typeof announcedProvider !== 'object') return;
      providerMetadata.set(announcedProvider, {
        name: String(detail?.info?.name || ''),
        rdns: String(detail?.info?.rdns || '')
      });
    });

    window.dispatchEvent(new Event('eip6963:requestProvider'));
  }

  function getInjectedProviders() {
    const providers = [];
    if (Array.isArray(window?.ethereum?.providers)) {
      for (const candidate of window.ethereum.providers) {
        if (candidate && typeof candidate === 'object' && !providers.includes(candidate)) {
          providers.push(candidate);
        }
      }
    }
    if (window?.ethereum && typeof window.ethereum === 'object' && !providers.includes(window.ethereum)) {
      providers.push(window.ethereum);
    }
    return providers;
  }

  function isBankrProvider(rawProvider) {
    if (!rawProvider || typeof rawProvider !== 'object') return false;
    const meta = getProviderMetadata(rawProvider);
    return Boolean(
      rawProvider.isImpersonator ||
        /bankr/i.test(String(meta.name || '')) ||
        /bankr/i.test(String(meta.rdns || ''))
    );
  }

  function isRabbyProvider(rawProvider) {
    if (!rawProvider || typeof rawProvider !== 'object') return false;
    const meta = getProviderMetadata(rawProvider);
    return Boolean(rawProvider.isRabby || /rabby/i.test(String(meta.name || '')) || /rabby/i.test(String(meta.rdns || '')));
  }

  function isMetaMaskProvider(rawProvider) {
    if (!rawProvider || typeof rawProvider !== 'object') return false;
    return Boolean(rawProvider.isMetaMask && !isRabbyProvider(rawProvider) && !isBankrProvider(rawProvider));
  }

  function findProviderByKind(kind) {
    initDiscovery();
    const providers = getInjectedProviders();
    const predicate =
      kind === 'bankr'
        ? isBankrProvider
        : kind === 'rabby'
          ? isRabbyProvider
          : kind === 'metamask'
            ? isMetaMaskProvider
            : null;
    if (!predicate) return null;
    return providers.find((candidate) => predicate(candidate)) || null;
  }

  function fallbackInjectedProvider() {
    return window?.ethereum && typeof window.ethereum === 'object' ? window.ethereum : null;
  }

  globalScope.PullMdWalletProviders = {
    initDiscovery,
    findProviderByKind,
    fallbackInjectedProvider
  };
})(typeof window !== 'undefined' ? window : globalThis);
