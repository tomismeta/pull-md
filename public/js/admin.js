const API_BASE = '/api/mcp/tools/creator_marketplace';
const BASE_CHAIN_HEX = '0x2105';
const BASE_CHAIN_DEC = 8453;
const WALLET_SESSION_KEY = 'soulstarter_wallet_session_v1';
const providerMetadata = new WeakMap();
let providerDiscoveryInitialized = false;
const state = {
  provider: null,
  signer: null,
  wallet: null,
  walletType: null,
  moderators: []
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
    if (!detail || typeof detail !== 'object') return;
    if (!detail.provider || typeof detail.provider !== 'object') return;
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
  const btn = document.getElementById('connectWalletBtn');
  if (!btn) return;
  if (state.wallet) {
    btn.textContent = `${state.wallet.slice(0, 6)}...${state.wallet.slice(-4)} (disconnect)`;
    btn.classList.add('connected');
  } else {
    btn.textContent = 'connect moderator wallet';
    btn.classList.remove('connected');
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

function openWalletModal() {
  const modal = document.getElementById('walletModal');
  if (modal) modal.style.display = 'flex';
}

function closeWalletModal() {
  const modal = document.getElementById('walletModal');
  if (modal) modal.style.display = 'none';
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

async function connectWithProvider(rawProvider) {
  return connectWithProviderInternal(rawProvider, 'injected', false);
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

async function connectMetaMask() {
  const metamaskProvider = findProviderByKind('metamask');
  if (metamaskProvider) {
    return connectWithProviderInternal(metamaskProvider, 'metamask', false);
  }
  const fallback = fallbackInjectedProvider();
  if (!fallback) {
    showToast('MetaMask not found', 'error');
    return;
  }
  showToast('MetaMask-specific provider not detected. Using current injected wallet.', 'warning');
  return connectWithProviderInternal(fallback, 'metamask', false);
}

async function connectRabby() {
  const rabbyProvider = findProviderByKind('rabby');
  if (rabbyProvider) {
    return connectWithProviderInternal(rabbyProvider, 'rabby', false);
  }
  const fallback = fallbackInjectedProvider();
  if (!fallback) {
    showToast('Rabby wallet not found', 'error');
    return;
  }
  showToast('Rabby-specific provider not detected. Using current injected wallet.', 'warning');
  return connectWithProviderInternal(fallback, 'rabby', false);
}

async function connectBankr() {
  const bankrProvider = findProviderByKind('bankr');
  if (bankrProvider) {
    return connectWithProviderInternal(bankrProvider, 'bankr', false);
  }
  const fallback = fallbackInjectedProvider();
  if (!fallback) {
    showToast('Bankr Wallet not found', 'error');
    return;
  }
  showToast('Bankr-specific provider not detected. Using current injected wallet.', 'warning');
  return connectWithProviderInternal(fallback, 'bankr', false);
}
function moderatorAuthMessage(action, timestamp) {
  return [
    'SoulStarter Moderator Authentication',
    `address:${state.wallet}`,
    `action:${action}`,
    `timestamp:${timestamp}`
  ].join('\n');
}

async function signModeratorHeaders(action) {
  if (!state.wallet || !state.signer) throw new Error('Connect wallet first');
  if (!isAllowedModerator(state.wallet)) throw new Error('Connected wallet is not allowlisted for moderation');
  const timestamp = Date.now();
  const signature = await state.signer.signMessage(moderatorAuthMessage(action, timestamp));
  return {
    'X-MODERATOR-ADDRESS': state.wallet,
    'X-MODERATOR-SIGNATURE': signature,
    'X-MODERATOR-TIMESTAMP': String(timestamp)
  };
}

async function apiCall(action, { method = 'GET', body, moderatorAuth = false } = {}) {
  const url = `${API_BASE}?action=${encodeURIComponent(action)}`;
  const authHeaders = moderatorAuth ? await signModeratorHeaders(action) : {};
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders
    },
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
  container.innerHTML = state.moderators
    .map((wallet) => `<p class="admin-line"><code>${wallet}</code></p>`)
    .join('');
}

function draftCardActions(item) {
  const wallet = item.wallet_address;
  const draftId = item.draft_id;
  return `
    <div class="admin-card-actions">
      <button class="btn btn-ghost" data-action="approve" data-wallet="${wallet}" data-draft="${draftId}">approve</button>
      <button class="btn btn-ghost" data-action="reject" data-wallet="${wallet}" data-draft="${draftId}">reject</button>
      <button class="btn btn-primary" data-action="publish" data-wallet="${wallet}" data-draft="${draftId}">publish</button>
    </div>
  `;
}

function renderQueue(items) {
  const container = document.getElementById('queueContainer');
  if (!container) return;
  if (!Array.isArray(items) || items.length === 0) {
    renderEmpty('queueContainer', 'No drafts waiting review.');
    return;
  }
  container.innerHTML = items
    .map((item) => {
      const listing = item.normalized?.listing || {};
      return `
        <article class="admin-card">
          <div class="admin-card-row">
            <h4>${listing.name || item.draft_id}</h4>
            <span class="badge badge-hybrid">${item.status || 'unknown'}</span>
          </div>
          <p class="admin-line">Soul ID: <code>${listing.soul_id || '-'}</code></p>
          <p class="admin-line">Creator: <code>${item.wallet_address || '-'}</code></p>
          <p class="admin-line">Price: <code>$${Number(listing.price_usdc || 0).toFixed(2)}</code></p>
          <p class="admin-line">Submitted: <code>${formatDate(item.moderation?.submitted_at)}</code></p>
          ${draftCardActions(item)}
        </article>
      `;
    })
    .join('');
}

function renderPublished(items) {
  const container = document.getElementById('publishedContainer');
  if (!container) return;
  if (!Array.isArray(items) || items.length === 0) {
    renderEmpty('publishedContainer', 'No published listings yet.');
    return;
  }
  container.innerHTML = items
    .map((item) => {
      const listing = item.normalized?.listing || {};
      return `
        <article class="admin-card">
          <div class="admin-card-row">
            <h4>${listing.name || item.draft_id}</h4>
            <span class="badge badge-organic">published</span>
          </div>
          <p class="admin-line">Soul ID: <code>${listing.soul_id || '-'}</code></p>
          <p class="admin-line">Creator: <code>${item.wallet_address || '-'}</code></p>
          <p class="admin-line">Published: <code>${formatDate(item.published_at || item.updated_at)}</code></p>
        </article>
      `;
    })
    .join('');
}

async function loadModerators() {
  const data = await apiCall('list_moderators');
  state.moderators = Array.isArray(data.moderators) ? data.moderators.map((w) => String(w).toLowerCase()) : [];
  renderModeratorList();
}

async function connectWallet() {
  if (!state.signer || !state.wallet) {
    throw new Error('No wallet session found');
  }
  const allowed = isAllowedModerator(state.wallet);
  if (allowed) {
    setStatus(`Connected moderator: ${state.wallet}`);
    showToast('Moderator wallet connected', 'success');
    await Promise.all([loadQueue(), loadPublished()]);
  } else {
    setStatus(`Connected wallet is not allowlisted: ${state.wallet}`);
    renderEmpty('queueContainer', 'Access denied. Use an allowlisted moderator wallet.');
    renderEmpty('publishedContainer', 'Access denied. Use an allowlisted moderator wallet.');
    showToast('Wallet is not in moderator allowlist', 'warning');
  }
}

function disconnectWallet() {
  state.provider = null;
  state.signer = null;
  state.wallet = null;
  state.walletType = null;
  clearWalletSession();
  setConnectButton();
  setStatus('Wallet not connected.');
  renderEmpty('queueContainer', 'Connect an allowlisted moderator wallet.');
  renderEmpty('publishedContainer', 'Connect an allowlisted moderator wallet.');
  showToast('Wallet disconnected', 'info');
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

async function requireAllowedModerator() {
  if (!state.wallet || !state.signer) throw new Error('Connect an allowlisted moderator wallet first');
  if (!isAllowedModerator(state.wallet)) throw new Error('Connected wallet is not allowlisted for moderation');
}

async function loadQueue() {
  await requireAllowedModerator();
  const data = await apiCall('list_review_queue', { moderatorAuth: true });
  renderQueue(data.queue || []);
}

async function loadPublished() {
  await requireAllowedModerator();
  const data = await apiCall('list_published_listings');
  renderPublished(data.listings || []);
}

async function reviewDecision(walletAddress, draftId, decision) {
  await requireAllowedModerator();
  await apiCall('review_listing_submission', {
    method: 'POST',
    moderatorAuth: true,
    body: {
      wallet_address: walletAddress,
      draft_id: draftId,
      decision,
      reviewer: state.wallet
    }
  });
}

async function publishDraft(walletAddress, draftId) {
  await requireAllowedModerator();
  await apiCall('publish_listing', {
    method: 'POST',
    moderatorAuth: true,
    body: {
      wallet_address: walletAddress,
      draft_id: draftId,
      reviewer: state.wallet
    }
  });
}

function bindEvents() {
  document.getElementById('connectWalletBtn')?.addEventListener('click', async () => {
    try {
      if (state.wallet) {
        disconnectWallet();
      } else {
        openWalletModal();
      }
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  document.getElementById('refreshQueueBtn')?.addEventListener('click', async () => {
    try {
      await loadQueue();
    } catch (error) {
      showToast(error.message, 'error');
      renderEmpty('queueContainer', `Queue load failed: ${error.message}`);
    }
  });

  document.getElementById('refreshPublishedBtn')?.addEventListener('click', async () => {
    try {
      await loadPublished();
    } catch (error) {
      showToast(error.message, 'error');
      renderEmpty('publishedContainer', `Published load failed: ${error.message}`);
    }
  });

  document.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.getAttribute('data-action');
    if (!action) return;
    const wallet = target.getAttribute('data-wallet');
    const draft = target.getAttribute('data-draft');
    if (!wallet || !draft) return;
    target.setAttribute('disabled', 'true');
    try {
      if (action === 'approve' || action === 'reject') {
        await reviewDecision(wallet, draft, action);
        showToast(`Draft ${action}d`, 'success');
      } else if (action === 'publish') {
        await publishDraft(wallet, draft);
        showToast('Draft published', 'success');
      }
      await Promise.all([loadQueue(), loadPublished()]);
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      target.removeAttribute('disabled');
    }
  });
}

async function connectFromChoice(kind) {
  if (kind === 'metamask') await connectMetaMask();
  else if (kind === 'rabby') await connectRabby();
  else if (kind === 'bankr') await connectBankr();
  await connectWallet();
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
  renderEmpty('queueContainer', 'Connect an allowlisted moderator wallet.');
  renderEmpty('publishedContainer', 'Connect an allowlisted moderator wallet.');
  await restoreWalletSession();
}

window.closeWalletModal = closeWalletModal;

init().catch((error) => {
  showToast(error.message, 'error');
});
