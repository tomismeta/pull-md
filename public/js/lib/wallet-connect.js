(function attachPullMdWalletConnect(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  async function connectWithProviderInternal({
    rawProvider,
    walletType,
    silent = false,
    closeModal,
    ensureNetwork,
    onState,
    afterConnected
  } = {}) {
    if (!rawProvider) throw new Error('Wallet provider not found');
    if (typeof closeModal === 'function') closeModal();

    const browserProvider = new ethers.BrowserProvider(rawProvider, 'any');
    if (silent) {
      const accounts = await browserProvider.send('eth_accounts', []);
      const first = Array.isArray(accounts) && accounts[0] ? String(accounts[0]) : '';
      if (!first) throw new Error('No existing wallet authorization found');
    } else {
      await browserProvider.send('eth_requestAccounts', []);
    }

    const connectedSigner = await browserProvider.getSigner();
    const connectedWallet = String(await connectedSigner.getAddress()).toLowerCase();
    const normalizedWalletType = String(walletType || '').toLowerCase();

    if (typeof onState === 'function') {
      onState({
        provider: browserProvider,
        signer: connectedSigner,
        wallet: connectedWallet,
        walletType: normalizedWalletType
      });
    }

    if (typeof ensureNetwork === 'function') {
      await ensureNetwork(browserProvider);
    }

    if (typeof afterConnected === 'function') {
      await afterConnected({
        provider: browserProvider,
        signer: connectedSigner,
        wallet: connectedWallet,
        walletType: normalizedWalletType,
        silent: Boolean(silent)
      });
    }

    return {
      provider: browserProvider,
      signer: connectedSigner,
      wallet: connectedWallet,
      walletType: normalizedWalletType
    };
  }

  async function connectWithPreferredKind({
    kind,
    walletType,
    connectInternal,
    findProviderByKind,
    fallbackInjectedProvider,
    notify,
    missingProviderMessage = 'Wallet provider not found',
    fallbackNotice = '',
    throwOnMissingProvider = false
  } = {}) {
    if (typeof connectInternal !== 'function') {
      throw new Error('connectInternal callback is required');
    }

    const preferredProvider = typeof findProviderByKind === 'function' ? findProviderByKind(kind) : null;
    if (preferredProvider) {
      return connectInternal(preferredProvider, walletType || kind, false);
    }

    const fallback = typeof fallbackInjectedProvider === 'function' ? fallbackInjectedProvider() : null;
    if (!fallback) {
      if (throwOnMissingProvider) {
        throw new Error(String(missingProviderMessage || 'Wallet provider not found'));
      }
      if (typeof notify === 'function') {
        notify(String(missingProviderMessage || 'Wallet provider not found'), 'error');
      }
      return null;
    }

    if (fallbackNotice && typeof notify === 'function') {
      notify(String(fallbackNotice), 'warning');
    }

    return connectInternal(fallback, walletType || kind, false);
  }

  globalScope.PullMdWalletConnect = {
    connectWithProviderInternal,
    connectWithPreferredKind
  };
})(typeof window !== 'undefined' ? window : globalThis);
