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
    hydrateAssetDetailPage,
    loadAssets,
    updateAssetPagePurchaseState,
    initEmblemAuth
  } = {}) {
    onReady(async () => {
      if (typeof initProviderDiscovery === 'function') initProviderDiscovery();
      if (typeof initMobileNav === 'function') initMobileNav();
      if (typeof bindWalletOptions === 'function') bindWalletOptions();
      if (typeof updateWalletUI === 'function') updateWalletUI();
      if (typeof loadAssets === 'function') await loadAssets();
      if (typeof updateAssetPagePurchaseState === 'function') updateAssetPagePurchaseState();

      const backgroundTasks = [];
      if (typeof loadModeratorAllowlist === 'function') {
        backgroundTasks.push(Promise.resolve().then(() => loadModeratorAllowlist()));
      }
      if (typeof restoreWalletSession === 'function') {
        backgroundTasks.push(Promise.resolve().then(() => restoreWalletSession()));
      }
      if (typeof initEmblemAuth === 'function') {
        backgroundTasks.push(Promise.resolve().then(() => initEmblemAuth()));
      }
      if (typeof refreshEntitlements === 'function') {
        backgroundTasks.push(Promise.resolve().then(() => refreshEntitlements()));
      }
      if (typeof refreshCreatedSouls === 'function') {
        backgroundTasks.push(Promise.resolve().then(() => refreshCreatedSouls()));
      }
      if (typeof hydrateAssetDetailPage === 'function') {
        backgroundTasks.push(Promise.resolve().then(() => hydrateAssetDetailPage()));
      }

      if (backgroundTasks.length > 0) {
        void Promise.allSettled(backgroundTasks).then(() => {
          if (typeof updateAssetPagePurchaseState === 'function') updateAssetPagePurchaseState();
        });
      }
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
