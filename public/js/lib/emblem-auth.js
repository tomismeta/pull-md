(function attachPullMdEmblemAuth(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  let sdk = null;
  let currentSession = null;
  let sessionChangeCallback = null;

  function init(config) {
    const appId = String((config && config.emblemAppId) || '').trim();
    if (!appId) return;

    if (typeof config.onSessionChange === 'function') {
      sessionChangeCallback = config.onSessionChange;
    }

    const EmblemAuth = globalScope.EmblemAuth;
    if (!EmblemAuth || typeof EmblemAuth.EmblemAuthSDK !== 'function') return;

    sdk = new EmblemAuth.EmblemAuthSDK({
      appId: appId,
      persistSession: true,
      onSuccess: function (session) {
        currentSession = session || null;
        notifySessionChange(currentSession);
      },
      onError: function () {
        currentSession = null;
      },
      onCancel: function () {}
    });

    sdk.on('session', function (session) {
      currentSession = session || null;
      notifySessionChange(currentSession);
    });

    sdk.on('sessionExpired', function () {
      currentSession = null;
      notifySessionChange(null);
    });

    sdk.on('sessionRefreshed', function (session) {
      currentSession = session || null;
    });

    currentSession = sdk.getSession() || null;
  }

  function notifySessionChange(session) {
    if (!session) {
      if (typeof sessionChangeCallback === 'function') {
        sessionChangeCallback({ session: null, evmAddress: null });
      }
      return;
    }
    var directAddress = session.user ? String(session.user.evmAddress || '').trim().toLowerCase() : '';
    if (directAddress) {
      if (typeof sessionChangeCallback === 'function') {
        sessionChangeCallback({ session: session, evmAddress: directAddress });
      }
      return;
    }
    // Fallback: fetch vault info for guest/OAuth/email auth
    if (sdk && typeof sdk.getVaultInfo === 'function') {
      sdk.getVaultInfo().then(function (vault) {
        var addr = vault ? String(vault.evmAddress || '').trim().toLowerCase() : '';
        if (typeof sessionChangeCallback === 'function') {
          sessionChangeCallback({ session: session, evmAddress: addr || null });
        }
      }).catch(function () {
        if (typeof sessionChangeCallback === 'function') {
          sessionChangeCallback({ session: session, evmAddress: null });
        }
      });
    } else if (typeof sessionChangeCallback === 'function') {
      sessionChangeCallback({ session: session, evmAddress: null });
    }
  }

  function login() {
    if (!sdk || typeof sdk.openAuthModal !== 'function') {
      console.warn('[EmblemAuth] SDK not initialized. Check EMBLEM_APP_ID env var.');
      return false;
    }
    sdk.openAuthModal();
    return true;
  }

  function logout() {
    if (!sdk || typeof sdk.logout !== 'function') return;
    sdk.logout();
    currentSession = null;
    notifySessionChange(null);
  }

  function getSession() {
    if (sdk && typeof sdk.getSession === 'function') {
      currentSession = sdk.getSession() || null;
    }
    return currentSession;
  }

  function isAuthenticated() {
    return getSession() !== null;
  }

  function getEvmAddress() {
    var session = getSession();
    if (!session || !session.user) return null;
    var address = String(session.user.evmAddress || '').trim();
    return address ? address.toLowerCase() : null;
  }

  function getVaultInfo() {
    if (!sdk || typeof sdk.getVaultInfo !== 'function') return Promise.resolve(null);
    return sdk.getVaultInfo();
  }

  function getEthersSigner() {
    if (!sdk || typeof sdk.toEthersWallet !== 'function') return Promise.resolve(null);
    return sdk.toEthersWallet().catch(function () { return null; });
  }

  function destroy() {
    if (sdk && typeof sdk.destroy === 'function') {
      sdk.destroy();
    }
    sdk = null;
    currentSession = null;
  }

  globalScope.PullMdEmblemAuth = {
    init: init,
    login: login,
    logout: logout,
    getSession: getSession,
    isAuthenticated: isAuthenticated,
    getEvmAddress: getEvmAddress,
    getVaultInfo: getVaultInfo,
    getEthersSigner: getEthersSigner,
    destroy: destroy
  };
})(typeof window !== 'undefined' ? window : globalThis);
