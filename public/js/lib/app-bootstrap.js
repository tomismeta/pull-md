(function attachPullMdAppBootstrap(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  function bindWalletOptionHandlers({
    selector = '.wallet-option[data-wallet-kind]',
    connectByKind,
    onError
  } = {}) {
    const options = document.querySelectorAll(String(selector || '.wallet-option[data-wallet-kind]'));
    options.forEach((option) => {
      option.addEventListener('click', async () => {
        const kind = String(option.getAttribute('data-wallet-kind') || '').trim().toLowerCase();
        if (!kind || typeof connectByKind !== 'function') return;
        try {
          await connectByKind(kind);
        } catch (error) {
          if (typeof onError === 'function') {
            onError(error);
          }
        }
      });
    });
  }

  function onReady(handler) {
    if (typeof handler !== 'function') return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', handler, { once: true });
      return;
    }
    queueMicrotask(handler);
  }

  function runStartup({
    initProviderDiscovery,
    initMobileNav,
    loadModeratorAllowlist,
    bindWalletOptions,
    updateWalletUI,
    restoreWalletSession,
    refreshEntitlements,
    refreshCreatedSouls,
    hydrateSoulDetailPage,
    loadSouls,
    updateSoulPagePurchaseState
  } = {}) {
    onReady(async () => {
      if (typeof initProviderDiscovery === 'function') initProviderDiscovery();
      if (typeof initMobileNav === 'function') initMobileNav();
      if (typeof loadModeratorAllowlist === 'function') await loadModeratorAllowlist();
      if (typeof bindWalletOptions === 'function') bindWalletOptions();
      if (typeof updateWalletUI === 'function') updateWalletUI();
      if (typeof restoreWalletSession === 'function') await restoreWalletSession();
      if (typeof refreshEntitlements === 'function') await refreshEntitlements();
      if (typeof refreshCreatedSouls === 'function') await refreshCreatedSouls();
      if (typeof hydrateSoulDetailPage === 'function') await hydrateSoulDetailPage();
      if (typeof loadSouls === 'function') await loadSouls();
      if (typeof updateSoulPagePurchaseState === 'function') updateSoulPagePurchaseState();
    });
  }

  function bindBeforeUnload(callback) {
    if (typeof callback !== 'function') return;
    globalScope.addEventListener('beforeunload', callback);
  }

  globalScope.PullMdAppBootstrap = {
    bindWalletOptionHandlers,
    runStartup,
    bindBeforeUnload
  };
})(typeof window !== 'undefined' ? window : globalThis);
