const API_BASE = '/api/mcp/tools/creator_marketplace';
const BASE_CHAIN_HEX = '0x2105';
const BASE_CHAIN_DEC = 8453;
let walletConnectProjectId = null;
const state = {
  provider: null,
  signer: null,
  wallet: null,
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
  const raw = provider.provider;
  try {
    await raw.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_CHAIN_HEX }] });
  } catch (error) {
    if (error.code === 4902) {
      await raw.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: BASE_CHAIN_HEX,
            chainName: 'Base',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://mainnet.base.org'],
            blockExplorerUrls: ['https://basescan.org']
          }
        ]
      });
      return;
    }
    throw error;
  }
}

async function connectWithProvider(rawProvider) {
  if (!rawProvider) {
    showToast('Wallet provider not found', 'error');
    return;
  }
  closeWalletModal();
  state.provider = new ethers.BrowserProvider(rawProvider, 'any');
  await state.provider.send('eth_requestAccounts', []);
  state.signer = await state.provider.getSigner();
  state.wallet = (await state.signer.getAddress()).toLowerCase();
  await ensureBaseNetwork(state.provider);
}

async function connectMetaMask() {
  if (!window.ethereum) {
    showToast('MetaMask not found', 'error');
    return;
  }
  if (Array.isArray(window.ethereum.providers)) {
    const mm = window.ethereum.providers.find((p) => p.isMetaMask);
    if (mm) return connectWithProvider(mm);
  }
  return connectWithProvider(window.ethereum);
}

async function connectCoinbase() {
  if (!window.ethereum) {
    showToast('Coinbase Wallet not found', 'error');
    return;
  }
  if (Array.isArray(window.ethereum.providers)) {
    const cb = window.ethereum.providers.find((p) => p.isCoinbaseWallet);
    if (cb) return connectWithProvider(cb);
  }
  if (window.ethereum.isCoinbaseWallet) return connectWithProvider(window.ethereum);
  showToast('Coinbase provider not detected', 'warning');
}

async function connectInjected() {
  if (!window.ethereum) {
    showToast('No injected wallet detected', 'error');
    return;
  }
  return connectWithProvider(window.ethereum);
}

async function connectWalletConnect() {
  if (!window.EthereumProvider) {
    showToast('WalletConnect provider script failed to load', 'error');
    return;
  }
  if (!walletConnectProjectId) {
    showToast('WalletConnect is not configured on this deployment', 'error');
    return;
  }
  closeWalletModal();
  const wcProvider = await window.EthereumProvider.init({
    projectId: walletConnectProjectId,
    chains: [BASE_CHAIN_DEC],
    optionalChains: [1, 8453],
    showQrModal: true
  });
  await wcProvider.enable();
  return connectWithProvider(wcProvider);
}

async function loadWalletConfig() {
  try {
    const response = await fetch('/api/wallet-config');
    if (!response.ok) return;
    const payload = await response.json();
    walletConnectProjectId = payload.walletConnectProjectId || null;
  } catch (_) {
    walletConnectProjectId = null;
  }
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
      openWalletModal();
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
  else if (kind === 'walletconnect') await connectWalletConnect();
  else if (kind === 'coinbase') await connectCoinbase();
  else await connectInjected();
  await connectWallet();
}

function bindWalletChoiceHandlers() {
  const map = [
    ['connectMetaMask', 'metamask'],
    ['connectWalletConnect', 'walletconnect'],
    ['connectCoinbase', 'coinbase'],
    ['connectInjected', 'injected']
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

async function init() {
  bindEvents();
  bindWalletChoiceHandlers();
  await loadWalletConfig();
  await loadModerators();
  setStatus('Wallet not connected.');
  renderEmpty('queueContainer', 'Connect an allowlisted moderator wallet.');
  renderEmpty('publishedContainer', 'Connect an allowlisted moderator wallet.');
}

window.closeWalletModal = closeWalletModal;

init().catch((error) => {
  showToast(error.message, 'error');
});
