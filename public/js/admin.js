const API_BASE = '/api/mcp/tools/creator_marketplace';
const BASE_CHAIN_HEX = '0x2105';
const BASE_CHAIN_DEC = 8453;
const SIWE_DOMAIN = 'soulstarter.vercel.app';
const SIWE_URI = 'https://soulstarter.vercel.app';
const WALLET_SESSION_KEY = 'soulstarter_wallet_session_v1';
const providerMetadata = new WeakMap();
let providerDiscoveryInitialized = false;
const state = {
  provider: null,
  signer: null,
  wallet: null,
  walletType: null,
  moderators: [],
  connecting: false
};

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 200);
  }, 2800);
}

function initProviderDiscovery() {
  if (providerDiscoveryInitialized || typeof window === 'undefined') return;
  providerDiscoveryInitialized = true;
  window.addEventListener('eip6963:announceProvider', (event) => {
    const detail = event?.detail;
    if (!detail || typeof detail !== 'object' || !detail.provider || typeof detail.provider !== 'object') return;
    providerMetadata.set(detail.provider, {
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
      if (candidate && typeof candidate === 'object' && !providers.includes(candidate)) providers.push(candidate);
    }
  }
  if (window?.ethereum && typeof window.ethereum === 'object' && !providers.includes(window.ethereum)) {
    providers.push(window.ethereum);
  }
  return providers;
}

function getProviderMetadata(rawProvider) {
  return providerMetadata.get(rawProvider) || { name: '', rdns: '' };
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
  initProviderDiscovery();
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

function normalizeAddress(value) {
  try {
    return ethers.getAddress(String(value || '').trim()).toLowerCase();
  } catch (_) {
    return null;
  }
}

function isAllowedModerator(wallet) {
  const normalized = normalizeAddress(wallet);
  return Boolean(normalized && state.moderators.includes(normalized));
}

function setStatus(text) {
  const el = document.getElementById('tokenStatus');
  if (el) el.textContent = text;
}

function setConnectButton() {
  const walletButtons = [document.getElementById('connectWalletBtn'), document.getElementById('walletBtn')].filter(Boolean);
  if (!walletButtons.length) return;
  for (const btn of walletButtons) {
    if (state.wallet) {
      const suffix = btn.id === 'connectWalletBtn' ? ' (disconnect)' : '';
      btn.textContent = `${state.wallet.slice(0, 6)}...${state.wallet.slice(-4)}${suffix}`;
      btn.classList.add('connected');
    } else {
      btn.textContent = btn.id === 'connectWalletBtn' ? 'connect moderator wallet' : 'Connect Wallet';
      btn.classList.remove('connected');
    }
  }
}

function renderEmpty(containerId, text) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<p class="admin-empty">${text}</p>`;
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value || '');
  return div.innerHTML;
}

function openWalletModal() {
  const modal = document.getElementById('walletModal');
  if (modal) modal.style.display = 'flex';
}

function closeWalletModal() {
  const modal = document.getElementById('walletModal');
  if (modal) modal.style.display = 'none';
}

function setWalletOptionsDisabled(disabled) {
  document.querySelectorAll('.wallet-option').forEach((option) => {
    if (!(option instanceof HTMLButtonElement)) return;
    option.disabled = disabled;
  });
}

async function ensureBaseNetwork(provider) {
  const network = await provider.getNetwork();
  if (Number(network.chainId) === BASE_CHAIN_DEC) return;
  try {
    await provider.send('wallet_switchEthereumChain', [{ chainId: BASE_CHAIN_HEX }]);
  } catch (error) {
    if (error.code === 4902) {
      await provider.send('wallet_addEthereumChain', [
        {
          chainId: BASE_CHAIN_HEX,
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

function saveWalletSession() {
  if (!state.wallet || !state.walletType) return;
  try {
    localStorage.setItem(
      WALLET_SESSION_KEY,
      JSON.stringify({
        wallet: state.wallet,
        walletType: state.walletType
      })
    );
  } catch (_) {}
}

function clearWalletSession() {
  try {
    localStorage.removeItem(WALLET_SESSION_KEY);
  } catch (_) {}
}

function readWalletSession() {
  try {
    const raw = localStorage.getItem(WALLET_SESSION_KEY);
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

async function connectWithProviderInternal(rawProvider, walletType, silent) {
  if (!rawProvider) throw new Error('Wallet provider not found');
  closeWalletModal();
  state.provider = new ethers.BrowserProvider(rawProvider, 'any');
  if (silent) {
    const accounts = await state.provider.send('eth_accounts', []);
    const first = Array.isArray(accounts) && accounts[0] ? String(accounts[0]) : '';
    if (!first) throw new Error('No existing wallet authorization found');
  } else {
    await state.provider.send('eth_requestAccounts', []);
  }
  state.signer = await state.provider.getSigner();
  state.wallet = (await state.signer.getAddress()).toLowerCase();
  state.walletType = walletType;
  await ensureBaseNetwork(state.provider);
  saveWalletSession();
  setConnectButton();
}

async function connectMetaMaskProvider() {
  const metamaskProvider = findProviderByKind('metamask');
  if (metamaskProvider) return connectWithProviderInternal(metamaskProvider, 'metamask', false);
  const fallback = fallbackInjectedProvider();
  if (!fallback) throw new Error('MetaMask not found');
  return connectWithProviderInternal(fallback, 'metamask', false);
}

async function connectRabbyProvider() {
  const rabbyProvider = findProviderByKind('rabby');
  if (rabbyProvider) return connectWithProviderInternal(rabbyProvider, 'rabby', false);
  const fallback = fallbackInjectedProvider();
  if (!fallback) throw new Error('Rabby wallet not found');
  return connectWithProviderInternal(fallback, 'rabby', false);
}

async function connectBankrProvider() {
  const bankrProvider = findProviderByKind('bankr');
  if (bankrProvider) return connectWithProviderInternal(bankrProvider, 'bankr', false);
  const fallback = fallbackInjectedProvider();
  if (!fallback) throw new Error('Bankr Wallet not found');
  return connectWithProviderInternal(fallback, 'bankr', false);
}

async function sha256Hex(input) {
  const enc = new TextEncoder().encode(String(input));
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function moderatorSiweMessage(action, timestamp) {
  const ts = Number(timestamp);
  const nonceSeed = `moderator|${String(action || '')}|${String(ts)}`;
  const nonce = (await sha256Hex(nonceSeed)).slice(0, 16);
  return [
    `${SIWE_DOMAIN} wants you to sign in with your Ethereum account:`,
    String(state.wallet || '').toLowerCase(),
    '',
    'Authenticate wallet ownership for SoulStarter. No token transfer or approval.',
    '',
    `URI: ${SIWE_URI}`,
    'Version: 1',
    `Chain ID: ${BASE_CHAIN_DEC}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date(ts).toISOString()}`,
    `Expiration Time: ${new Date(ts + 5 * 60 * 1000).toISOString()}`,
    `Request ID: ${String(action || 'moderator')}:moderator`,
    'Resources:',
    `- urn:soulstarter:action:${String(action || '')}`,
    '- urn:soulstarter:scope:moderator'
  ].join('\n');
}

async function signModeratorHeaders(action) {
  if (!state.wallet || !state.signer) throw new Error('Connect wallet first');
  if (!isAllowedModerator(state.wallet)) throw new Error('Connected wallet is not allowlisted for moderation');
  const timestamp = Date.now();
  const signature = await state.signer.signMessage(await moderatorSiweMessage(action, timestamp));
  return {
    'X-MODERATOR-ADDRESS': state.wallet,
    'X-MODERATOR-SIGNATURE': signature,
    'X-MODERATOR-TIMESTAMP': String(timestamp)
  };
}

async function apiCall(action, { method = 'GET', body, moderatorAuth = false } = {}) {
  const headers = moderatorAuth ? await signModeratorHeaders(action) : {};
  const response = await fetch(`${API_BASE}?action=${encodeURIComponent(action)}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function renderModeratorList() {
  const container = document.getElementById('moderatorList');
  if (!container) return;
  if (!state.moderators.length) {
    container.innerHTML = '<p class="admin-empty">No moderator wallets configured.</p>';
    return;
  }
  container.innerHTML = state.moderators.map((wallet) => `<p class="admin-line"><code>${wallet}</code></p>`).join('');
}

function renderVisible(items) {
  const container = document.getElementById('visibleContainer');
  if (!container) return;
  if (!Array.isArray(items) || items.length === 0) {
    renderEmpty('visibleContainer', 'No visible listings.');
    return;
  }
  container.innerHTML = items
    .map(
      (item) => `
        <article class="admin-card">
          <div class="admin-card-row">
            <h4>${escapeHtml(item.name || item.soul_id)}</h4>
            <span class="badge badge-organic">public</span>
          </div>
          <p class="admin-line">soul_id: <code>${escapeHtml(item.soul_id || '-')}</code></p>
          <p class="admin-line">creator: <code>${escapeHtml(item.wallet_address || '-')}</code></p>
          <p class="admin-line">published: <code>${escapeHtml(formatDate(item.published_at))}</code></p>
          <div class="admin-card-actions">
            ${item.share_url ? `<a class="btn btn-ghost" href="${escapeHtml(item.share_url)}" target="_blank" rel="noopener noreferrer">open</a>` : ''}
            <button class="btn btn-primary" data-action="hide-listing" data-soul="${escapeHtml(item.soul_id)}">remove visibility</button>
          </div>
        </article>
      `
    )
    .join('');
}

function renderHidden(items) {
  const container = document.getElementById('hiddenContainer');
  if (!container) return;
  if (!Array.isArray(items) || items.length === 0) {
    renderEmpty('hiddenContainer', 'No hidden listings.');
    return;
  }
  container.innerHTML = items
    .map(
      (item) => `
        <article class="admin-card">
          <div class="admin-card-row">
            <h4>${escapeHtml(item.name || item.soul_id)}</h4>
            <span class="badge badge-hybrid">hidden</span>
          </div>
          <p class="admin-line">soul_id: <code>${escapeHtml(item.soul_id || '-')}</code></p>
          <p class="admin-line">hidden_by: <code>${escapeHtml(item.hidden_by || '-')}</code></p>
          <p class="admin-line">hidden_at: <code>${escapeHtml(formatDate(item.hidden_at))}</code></p>
          <p class="admin-line">reason: <code>${escapeHtml(item.hidden_reason || '-')}</code></p>
        </article>
      `
    )
    .join('');
}

async function loadModerators() {
  const data = await apiCall('list_moderators');
  state.moderators = Array.isArray(data.moderators) ? data.moderators.map((w) => String(w).toLowerCase()) : [];
  renderModeratorList();
}

function disconnectWallet() {
  state.provider = null;
  state.signer = null;
  state.wallet = null;
  state.walletType = null;
  clearWalletSession();
  setConnectButton();
  setStatus('Wallet not connected.');
  renderEmpty('visibleContainer', 'Connect an allowlisted moderator wallet.');
  renderEmpty('hiddenContainer', 'Connect an allowlisted moderator wallet.');
  showToast('Wallet disconnected', 'info');
}

async function requireAllowedModerator() {
  if (!state.wallet || !state.signer) throw new Error('Connect an allowlisted moderator wallet first');
  if (!isAllowedModerator(state.wallet)) throw new Error('Connected wallet is not allowlisted for moderation');
}

async function loadModerationListings() {
  await requireAllowedModerator();
  const data = await apiCall('list_moderation_listings', { moderatorAuth: true });
  renderVisible(data.visible || []);
  renderHidden(data.hidden || []);
}

async function hideListing(soulId) {
  await requireAllowedModerator();
  const reason = window.prompt('Optional reason for removal from public visibility:', '') || '';
  await apiCall('remove_listing_visibility', {
    method: 'POST',
    moderatorAuth: true,
    body: { soul_id: soulId, reason }
  });
}

async function connectWallet() {
  if (!state.signer || !state.wallet) throw new Error('No wallet session found');
  if (isAllowedModerator(state.wallet)) {
    setStatus(`Connected moderator: ${state.wallet}`);
    showToast('Moderator wallet connected', 'success');
    await loadModerationListings();
  } else {
    setStatus(`Connected wallet is not allowlisted: ${state.wallet}`);
    renderEmpty('visibleContainer', 'Access denied. Use an allowlisted moderator wallet.');
    renderEmpty('hiddenContainer', 'Access denied. Use an allowlisted moderator wallet.');
    showToast('Wallet is not in moderator allowlist', 'warning');
  }
}

async function restoreWalletSession() {
  const session = readWalletSession();
  if (!session) return;
  const providerCandidate = findProviderByKind(session.walletType) || fallbackInjectedProvider();
  if (!providerCandidate) {
    clearWalletSession();
    return;
  }
  try {
    await connectWithProviderInternal(providerCandidate, session.walletType, true);
    if (state.wallet !== session.wallet) {
      clearWalletSession();
      return;
    }
    await connectWallet();
  } catch (_) {
    clearWalletSession();
  }
}

function bindEvents() {
  const onWalletButtonClick = async () => {
    try {
      if (state.wallet) disconnectWallet();
      else openWalletModal();
    } catch (error) {
      showToast(error.message, 'error');
    }
  };
  document.getElementById('connectWalletBtn')?.addEventListener('click', onWalletButtonClick);
  document.getElementById('walletBtn')?.addEventListener('click', onWalletButtonClick);

  document.getElementById('refreshListingsBtn')?.addEventListener('click', async () => {
    try {
      await loadModerationListings();
    } catch (error) {
      showToast(error.message, 'error');
      renderEmpty('visibleContainer', `Visible list load failed: ${error.message}`);
    }
  });

  document.getElementById('refreshHiddenBtn')?.addEventListener('click', async () => {
    try {
      await loadModerationListings();
    } catch (error) {
      showToast(error.message, 'error');
      renderEmpty('hiddenContainer', `Hidden list load failed: ${error.message}`);
    }
  });

  document.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.getAttribute('data-action') !== 'hide-listing') return;
    const soulId = target.getAttribute('data-soul');
    if (!soulId) return;
    target.setAttribute('disabled', 'true');
    try {
      await hideListing(soulId);
      showToast('Listing removed from public visibility', 'success');
      await loadModerationListings();
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      target.removeAttribute('disabled');
    }
  });
}

async function connectFromChoice(kind) {
  if (state.connecting) return;
  state.connecting = true;
  setWalletOptionsDisabled(true);
  try {
    if (kind === 'metamask') await connectMetaMaskProvider();
    else if (kind === 'rabby') await connectRabbyProvider();
    else if (kind === 'bankr') await connectBankrProvider();
    if (!state.signer || !state.wallet) throw new Error('Wallet connection did not complete. Please try again.');
    await connectWallet();
  } finally {
    setWalletOptionsDisabled(false);
    state.connecting = false;
  }
}

function bindWalletChoiceHandlers() {
  const map = [
    ['connectMetaMask', 'metamask'],
    ['connectRabby', 'rabby'],
    ['connectBankr', 'bankr']
  ];
  for (const [fnName, kind] of map) {
    window[fnName] = async () => {
      try {
        await connectFromChoice(kind);
      } catch (error) {
        showToast(error.message, 'error');
      }
    };
  }
}

function initMobileNav() {
  const toggle = document.getElementById('navToggle');
  const nav = document.getElementById('topNav');
  if (!toggle || !nav) return;

  const closeNav = () => {
    nav.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  };

  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const nextOpen = !nav.classList.contains('open');
    nav.classList.toggle('open', nextOpen);
    toggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  });

  nav.querySelectorAll('a, button').forEach((item) => {
    item.addEventListener('click', () => {
      if (window.innerWidth <= 760) closeNav();
    });
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!nav.contains(target) && !toggle.contains(target)) closeNav();
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 760) closeNav();
  });
}

async function init() {
  initProviderDiscovery();
  initMobileNav();
  bindEvents();
  bindWalletChoiceHandlers();
  await loadModerators();
  setConnectButton();
  setStatus('Wallet not connected.');
  renderEmpty('visibleContainer', 'Connect an allowlisted moderator wallet.');
  renderEmpty('hiddenContainer', 'Connect an allowlisted moderator wallet.');
  await restoreWalletSession();
}

window.closeWalletModal = closeWalletModal;

init().catch((error) => {
  showToast(error.message, 'error');
});
