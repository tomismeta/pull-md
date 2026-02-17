const MCP_ENDPOINT = '/mcp';
const BASE_CHAIN_HEX = '0x2105';
const BASE_CHAIN_DEC = 8453;
const SIWE_DOMAIN = 'soulstarter.vercel.app';
const SIWE_URI = 'https://soulstarter.vercel.app';
const WALLET_SESSION_KEY = 'soulstarter_wallet_session_v1';
const state = {
  provider: null,
  signer: null,
  wallet: null,
  walletType: null,
  moderators: [],
  connecting: false
};

function getMcpClient() {
  const client = window?.SoulStarterMcp;
  if (!client || typeof client.callTool !== 'function') {
    throw new Error('MCP client unavailable');
  }
  return client;
}

async function mcpToolCall(name, args = {}) {
  return getMcpClient().callTool(name, args, {
    endpoint: MCP_ENDPOINT,
    idPrefix: 'admin'
  });
}

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
  window?.SoulStarterWalletProviders?.initDiscovery?.();
}

function findProviderByKind(kind) {
  return window?.SoulStarterWalletProviders?.findProviderByKind?.(kind) || null;
}

function fallbackInjectedProvider() {
  return window?.SoulStarterWalletProviders?.fallbackInjectedProvider?.() || null;
}

function getWalletCommon() {
  const helper = window?.SoulStarterWalletCommon;
  if (!helper) {
    throw new Error('Wallet common helper unavailable');
  }
  return helper;
}

function getWalletConnector() {
  const helper = window?.SoulStarterWalletConnect;
  if (!helper) {
    throw new Error('Wallet connector helper unavailable');
  }
  return helper;
}

function getUiShell() {
  const helper = window?.SoulStarterUiShell;
  if (!helper) {
    throw new Error('UI shell helper unavailable');
  }
  return helper;
}

function getSiweBuilder() {
  const helper = window?.SoulStarterSiwe;
  if (!helper || typeof helper.buildScopedMessage !== 'function') {
    throw new Error('SIWE message helper unavailable');
  }
  return helper;
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
      btn.textContent = 'Connect Wallet';
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
  getUiShell().openModal('walletModal');
}

function closeWalletModal() {
  getUiShell().closeModal('walletModal');
}

function setWalletOptionsDisabled(disabled) {
  document.querySelectorAll('.wallet-option').forEach((option) => {
    if (!(option instanceof HTMLButtonElement)) return;
    option.disabled = disabled;
  });
}

async function ensureBaseNetwork(provider) {
  return getWalletCommon().ensureBaseNetwork(provider, {
    chainIdDec: BASE_CHAIN_DEC,
    chainIdHex: BASE_CHAIN_HEX,
    chainParams: {
      chainId: BASE_CHAIN_HEX,
      chainName: 'Base',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://mainnet.base.org'],
      blockExplorerUrls: ['https://basescan.org']
    }
  });
}

function saveWalletSession() {
  getWalletCommon().saveWalletSession({
    key: WALLET_SESSION_KEY,
    wallet: state.wallet,
    walletType: state.walletType
  });
}

function clearWalletSession() {
  getWalletCommon().clearWalletSession({ key: WALLET_SESSION_KEY });
}

function readWalletSession() {
  return getWalletCommon().readWalletSession({ key: WALLET_SESSION_KEY });
}

async function connectWithProviderInternal(rawProvider, walletType, silent) {
  return getWalletConnector().connectWithProviderInternal({
    rawProvider,
    walletType,
    silent,
    closeModal: closeWalletModal,
    ensureNetwork: ensureBaseNetwork,
    onState: (next) => {
      state.provider = next.provider;
      state.signer = next.signer;
      state.wallet = next.wallet;
      state.walletType = next.walletType;
    },
    afterConnected: async () => {
      saveWalletSession();
      setConnectButton();
    }
  });
}

async function connectMetaMaskProvider() {
  return getWalletConnector().connectWithPreferredKind({
    kind: 'metamask',
    walletType: 'metamask',
    connectInternal: connectWithProviderInternal,
    findProviderByKind,
    fallbackInjectedProvider,
    notify: showToast,
    missingProviderMessage: 'MetaMask not found',
    throwOnMissingProvider: true
  });
}

async function connectRabbyProvider() {
  return getWalletConnector().connectWithPreferredKind({
    kind: 'rabby',
    walletType: 'rabby',
    connectInternal: connectWithProviderInternal,
    findProviderByKind,
    fallbackInjectedProvider,
    notify: showToast,
    missingProviderMessage: 'Rabby wallet not found',
    throwOnMissingProvider: true
  });
}

async function connectBankrProvider() {
  return getWalletConnector().connectWithPreferredKind({
    kind: 'bankr',
    walletType: 'bankr',
    connectInternal: connectWithProviderInternal,
    findProviderByKind,
    fallbackInjectedProvider,
    notify: showToast,
    missingProviderMessage: 'Bankr Wallet not found',
    throwOnMissingProvider: true
  });
}

async function moderatorSiweMessage(action, timestamp) {
  return getSiweBuilder().buildScopedMessage({
    domain: SIWE_DOMAIN,
    uri: SIWE_URI,
    chainId: BASE_CHAIN_DEC,
    wallet: state.wallet,
    scope: 'moderator',
    action,
    timestamp
  });
}

async function signModeratorHeaders(action) {
  if (!state.wallet || !state.signer) throw new Error('Connect your wallet first');
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
  const normalizedAction = String(action || '').trim();
  if (normalizedAction === 'list_moderators') {
    return mcpToolCall('list_moderators', {});
  }

  const headers = moderatorAuth ? await signModeratorHeaders(normalizedAction) : {};
  const authArgs = {
    moderator_address: String(headers['X-MODERATOR-ADDRESS'] || '').trim(),
    moderator_signature: String(headers['X-MODERATOR-SIGNATURE'] || '').trim(),
    moderator_timestamp: headers['X-MODERATOR-TIMESTAMP']
  };

  if (normalizedAction === 'list_moderation_listings') {
    return mcpToolCall('list_moderation_listings', authArgs);
  }

  if (normalizedAction === 'remove_listing_visibility') {
    return mcpToolCall('remove_listing_visibility', {
      ...authArgs,
      soul_id: String(body?.soul_id || '').trim(),
      reason: typeof body?.reason === 'string' ? body.reason : ''
    });
  }

  throw new Error(`Unsupported moderation action: ${normalizedAction}`);
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
  setStatus('Connect wallet to continue.');
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
  getUiShell().initMobileNav({
    toggleId: 'navToggle',
    navId: 'topNav',
    mobileMaxWidth: 760
  });
}

async function init() {
  initProviderDiscovery();
  initMobileNav();
  bindEvents();
  bindWalletChoiceHandlers();
  await loadModerators();
  setConnectButton();
  setStatus('Connect wallet to continue.');
  renderEmpty('visibleContainer', 'Connect an allowlisted moderator wallet.');
  renderEmpty('hiddenContainer', 'Connect an allowlisted moderator wallet.');
  await restoreWalletSession();
}

window.closeWalletModal = closeWalletModal;

init().catch((error) => {
  showToast(error.message, 'error');
});
