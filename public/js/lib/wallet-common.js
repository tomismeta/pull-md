(function attachSoulStarterWalletCommon(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  const DEFAULT_SESSION_KEY = 'soulstarter_wallet_session_v1';

  async function ensureBaseNetwork(provider, config = {}) {
    if (!provider) return;

    const chainIdDec = Number(config.chainIdDec ?? 8453);
    const chainIdHex = String(config.chainIdHex || '0x2105');
    const chainParams = config.chainParams && typeof config.chainParams === 'object'
      ? config.chainParams
      : {
          chainId: chainIdHex,
          chainName: 'Base',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://mainnet.base.org'],
          blockExplorerUrls: ['https://basescan.org']
        };

    const network = await provider.getNetwork();
    if (Number(network.chainId) === chainIdDec) return;

    try {
      await provider.send('wallet_switchEthereumChain', [{ chainId: chainIdHex }]);
    } catch (error) {
      if (error?.code === 4902) {
        await provider.send('wallet_addEthereumChain', [chainParams]);
        return;
      }
      throw error;
    }
  }

  function saveWalletSession({ wallet, walletType, key = DEFAULT_SESSION_KEY } = {}) {
    if (!wallet || !walletType) return;
    try {
      localStorage.setItem(
        key,
        JSON.stringify({
          wallet: String(wallet || '').toLowerCase(),
          walletType: String(walletType || '').toLowerCase()
        })
      );
    } catch (_) {}
  }

  function clearWalletSession({ key = DEFAULT_SESSION_KEY } = {}) {
    try {
      localStorage.removeItem(key);
    } catch (_) {}
  }

  function readWalletSession({ key = DEFAULT_SESSION_KEY } = {}) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const wallet = String(parsed?.wallet || '').toLowerCase();
      const walletType = String(parsed?.walletType || '').toLowerCase();
      if (!wallet || !walletType) return null;
      return { wallet, walletType };
    } catch (_) {
      return null;
    }
  }

  async function sha256Hex(input) {
    const enc = new TextEncoder().encode(String(input));
    const digest = await crypto.subtle.digest('SHA-256', enc);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  globalScope.SoulStarterWalletCommon = {
    ensureBaseNetwork,
    saveWalletSession,
    clearWalletSession,
    readWalletSession,
    sha256Hex
  };
})(typeof window !== 'undefined' ? window : globalThis);
