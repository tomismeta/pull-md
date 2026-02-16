const WEBMCP_BASE_CHAIN_HEX = '0x2105';
const WEBMCP_BASE_CHAIN_DEC = 8453;
const WEBMCP_WALLET_SESSION_KEY = 'soulstarter_wallet_session_v1';
const webmcpProviderMetadata = new WeakMap();
let webmcpProviderDiscoveryInitialized = false;
const WEBMCP_STATE = {
  provider: null,
  signer: null,
  wallet: null,
  walletType: null
};

function webmcpToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const item = document.createElement('div');
  item.className = `toast toast-${type}`;
  item.textContent = message;
  container.appendChild(item);
  requestAnimationFrame(() => item.classList.add('show'));
  setTimeout(() => {
    item.classList.remove('show');
    setTimeout(() => item.remove(), 200);
  }, 2800);
}

function initWebmcpProviderDiscovery() {
  if (webmcpProviderDiscoveryInitialized || typeof window === 'undefined') return;
  webmcpProviderDiscoveryInitialized = true;
  window.addEventListener('eip6963:announceProvider', (event) => {
    const detail = event?.detail;
    if (!detail || typeof detail !== 'object' || !detail.provider || typeof detail.provider !== 'object') return;
    webmcpProviderMetadata.set(detail.provider, {
      name: String(detail?.info?.name || ''),
      rdns: String(detail?.info?.rdns || '')
    });
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

function getWebmcpInjectedProviders() {
  const providers = [];
  if (Array.isArray(window?.ethereum?.providers)) {
    for (const candidate of window.ethereum.providers) {
      if (candidate && typeof candidate === 'object' && !providers.includes(candidate)) providers.push(candidate);
    }
  }
  if (window?.ethereum && typeof window.ethereum === 'object' && !providers.includes(window.ethereum)) {
    providers.push(window.ethereum);
  }
  return providers;
}

function getWebmcpProviderMetadata(rawProvider) {
  return webmcpProviderMetadata.get(rawProvider) || { name: '', rdns: '' };
}

function isWebmcpBankrProvider(rawProvider) {
  if (!rawProvider || typeof rawProvider !== 'object') return false;
  const meta = getWebmcpProviderMetadata(rawProvider);
  return Boolean(
    rawProvider.isImpersonator ||
      /bankr/i.test(String(meta.name || '')) ||
      /bankr/i.test(String(meta.rdns || ''))
  );
}

function isWebmcpRabbyProvider(rawProvider) {
  if (!rawProvider || typeof rawProvider !== 'object') return false;
  const meta = getWebmcpProviderMetadata(rawProvider);
  return Boolean(rawProvider.isRabby || /rabby/i.test(String(meta.name || '')) || /rabby/i.test(String(meta.rdns || '')));
}

function isWebmcpMetaMaskProvider(rawProvider) {
  if (!rawProvider || typeof rawProvider !== 'object') return false;
  return Boolean(rawProvider.isMetaMask && !isWebmcpRabbyProvider(rawProvider) && !isWebmcpBankrProvider(rawProvider));
}

function findWebmcpProviderByKind(kind) {
  initWebmcpProviderDiscovery();
  const providers = getWebmcpInjectedProviders();
  const predicate =
    kind === 'bankr'
      ? isWebmcpBankrProvider
      : kind === 'rabby'
        ? isWebmcpRabbyProvider
        : kind === 'metamask'
          ? isWebmcpMetaMaskProvider
          : null;
  if (!predicate) return null;
  return providers.find((candidate) => predicate(candidate)) || null;
}

function fallbackWebmcpProvider() {
  return window?.ethereum && typeof window.ethereum === 'object' ? window.ethereum : null;
}

function openWalletModal() {
  const modal = document.getElementById('walletModal');
  if (modal) modal.style.display = 'flex';
}

function closeWalletModal() {
  const modal = document.getElementById('walletModal');
  if (modal) modal.style.display = 'none';
}

async function ensureWebmcpBaseNetwork(provider) {
  const network = await provider.getNetwork();
  if (Number(network.chainId) === WEBMCP_BASE_CHAIN_DEC) return;
  try {
    await provider.send('wallet_switchEthereumChain', [{ chainId: WEBMCP_BASE_CHAIN_HEX }]);
  } catch (error) {
    if (error.code === 4902) {
      await provider.send('wallet_addEthereumChain', [
        {
          chainId: WEBMCP_BASE_CHAIN_HEX,
          chainName: 'Base',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: ['https://mainnet.base.org'],
          blockExplorerUrls: ['https://basescan.org']
        }
      ]);
      return;
    }
    throw error;
  }
}

function setWebmcpWalletButton() {
  const btn = document.getElementById('walletBtn');
  if (!btn) return;
  if (WEBMCP_STATE.wallet) {
    btn.textContent = `${WEBMCP_STATE.wallet.slice(0, 6)}...${WEBMCP_STATE.wallet.slice(-4)}`;
    btn.classList.add('connected');
  } else {
    btn.textContent = 'Connect Wallet';
    btn.classList.remove('connected');
  }
}

function saveWebmcpWalletSession() {
  if (!WEBMCP_STATE.wallet || !WEBMCP_STATE.walletType) return;
  try {
    localStorage.setItem(
      WEBMCP_WALLET_SESSION_KEY,
      JSON.stringify({
        wallet: WEBMCP_STATE.wallet,
        walletType: WEBMCP_STATE.walletType
      })
    );
  } catch (_) {}
}

function clearWebmcpWalletSession() {
  try {
    localStorage.removeItem(WEBMCP_WALLET_SESSION_KEY);
  } catch (_) {}
}

function readWebmcpWalletSession() {
  try {
    const raw = localStorage.getItem(WEBMCP_WALLET_SESSION_KEY);
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

async function connectWebmcpWithProvider(rawProvider, walletType, silent) {
  if (!rawProvider) throw new Error('Wallet provider not found');
  closeWalletModal();
  WEBMCP_STATE.provider = new ethers.BrowserProvider(rawProvider, 'any');
  if (silent) {
    const accounts = await WEBMCP_STATE.provider.send('eth_accounts', []);
    const first = Array.isArray(accounts) && accounts[0] ? String(accounts[0]) : '';
    if (!first) throw new Error('No existing wallet authorization found');
  } else {
    await WEBMCP_STATE.provider.send('eth_requestAccounts', []);
  }
  WEBMCP_STATE.signer = await WEBMCP_STATE.provider.getSigner();
  WEBMCP_STATE.wallet = (await WEBMCP_STATE.signer.getAddress()).toLowerCase();
  WEBMCP_STATE.walletType = walletType;
  await ensureWebmcpBaseNetwork(WEBMCP_STATE.provider);
  saveWebmcpWalletSession();
  setWebmcpWalletButton();
}

async function connectWebmcpByKind(kind) {
  const picked = findWebmcpProviderByKind(kind);
  if (picked) return connectWebmcpWithProvider(picked, kind, false);
  const fallback = fallbackWebmcpProvider();
  if (!fallback) throw new Error(`${kind} wallet not found`);
  return connectWebmcpWithProvider(fallback, kind, false);
}

function disconnectWebmcpWallet() {
  WEBMCP_STATE.provider = null;
  WEBMCP_STATE.signer = null;
  WEBMCP_STATE.wallet = null;
  WEBMCP_STATE.walletType = null;
  clearWebmcpWalletSession();
  setWebmcpWalletButton();
  webmcpToast('Wallet disconnected', 'info');
}

async function restoreWebmcpWalletSession() {
  const session = readWebmcpWalletSession();
  if (!session) return;
  const providerCandidate = findWebmcpProviderByKind(session.walletType) || fallbackWebmcpProvider();
  if (!providerCandidate) {
    clearWebmcpWalletSession();
    return;
  }
  try {
    await connectWebmcpWithProvider(providerCandidate, session.walletType, true);
    if (WEBMCP_STATE.wallet !== session.wallet) clearWebmcpWalletSession();
  } catch (_) {
    clearWebmcpWalletSession();
  }
}

function bindWebmcpWalletEvents() {
  const walletBtn = document.getElementById('walletBtn');
  if (walletBtn) {
    walletBtn.addEventListener('click', async () => {
      try {
        if (WEBMCP_STATE.wallet) disconnectWebmcpWallet();
        else openWalletModal();
      } catch (error) {
        webmcpToast(error.message, 'error');
      }
    });
  }

  document.querySelectorAll('.wallet-option').forEach((button) => {
    button.addEventListener('click', async () => {
      const kind = String(button.getAttribute('data-wallet-kind') || '').toLowerCase();
      if (!kind) return;
      try {
        await connectWebmcpByKind(kind);
        webmcpToast('Wallet connected', 'success');
      } catch (error) {
        webmcpToast(error.message, 'error');
      }
    });
  });
}

window.closeWalletModal = closeWalletModal;

async function initWebmcpWalletWidget() {
  initWebmcpProviderDiscovery();
  bindWebmcpWalletEvents();
  await restoreWebmcpWalletSession();
  setWebmcpWalletButton();
}

initWebmcpWalletWidget().catch((error) => {
  webmcpToast(error.message, 'error');
});
