const API_BASE = '/api/mcp/tools/creator_marketplace';
const DEFAULT_SELLER = '0x7F46aCB709cd8DF5879F84915CA431fB740989E4';
const BASE_CHAIN_HEX = '0x2105';
const BASE_CHAIN_DEC = 8453;
const WALLET_SESSION_KEY = 'soulstarter_wallet_session_v1';
let walletConnectProjectId = null;
const STATE = {
  provider: null,
  signer: null,
  wallet: null,
  walletType: null,
  lastDraftId: null
};

function toast(message, type = 'info') {
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

function setStatus(text) {
  const el = document.getElementById('draftStatus');
  if (el) el.textContent = text;
}

function setWalletButton() {
  const btn = document.getElementById('walletBtn');
  if (!btn) return;
  if (STATE.wallet) {
    btn.textContent = `${STATE.wallet.slice(0, 6)}...${STATE.wallet.slice(-4)}`;
    btn.classList.add('connected');
    btn.onclick = disconnectWallet;
  } else {
    btn.textContent = 'Connect Wallet';
    btn.classList.remove('connected');
    btn.onclick = openWalletModal;
  }
}

function saveWalletSession() {
  if (!STATE.wallet || !STATE.walletType) return;
  try {
    localStorage.setItem(
      WALLET_SESSION_KEY,
      JSON.stringify({
        wallet: STATE.wallet,
        walletType: STATE.walletType
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
    toast('Wallet provider not found', 'error');
    return;
  }
  return connectWithProviderInternal(rawProvider, 'injected', false);
}

async function connectWithProviderInternal(rawProvider, walletType, silent) {
  if (!rawProvider) {
    throw new Error('Wallet provider not found');
  }
  closeWalletModal();
  try {
    STATE.provider = new ethers.BrowserProvider(rawProvider, 'any');
    if (silent) {
      const accounts = await STATE.provider.send('eth_accounts', []);
      const first = Array.isArray(accounts) && accounts[0] ? String(accounts[0]) : '';
      if (!first) throw new Error('No existing wallet authorization found');
    } else {
      await STATE.provider.send('eth_requestAccounts', []);
    }
    STATE.signer = await STATE.provider.getSigner();
    STATE.wallet = (await STATE.signer.getAddress()).toLowerCase();
    STATE.walletType = walletType;
    await ensureBaseNetwork(STATE.provider);
    saveWalletSession();
    setWalletButton();
    const seller = document.getElementById('sellerAddress');
    if (seller && !seller.value.trim()) seller.value = DEFAULT_SELLER;
    if (!silent) toast('Wallet connected', 'success');
  } catch (error) {
    if (!silent) {
      toast(error.message || 'Wallet connection failed', 'error');
    }
    throw error;
  }
}

async function connectMetaMask() {
  if (!window.ethereum) {
    toast('MetaMask not found', 'error');
    return;
  }
  if (Array.isArray(window.ethereum.providers)) {
    const mm = window.ethereum.providers.find((p) => p.isMetaMask);
    if (mm) return connectWithProviderInternal(mm, 'metamask', false);
  }
  return connectWithProviderInternal(window.ethereum, 'metamask', false);
}

async function connectCoinbase() {
  if (!window.ethereum) {
    toast('Coinbase Wallet not found', 'error');
    return;
  }
  if (Array.isArray(window.ethereum.providers)) {
    const cb = window.ethereum.providers.find((p) => p.isCoinbaseWallet);
    if (cb) return connectWithProviderInternal(cb, 'coinbase', false);
  }
  if (window.ethereum.isCoinbaseWallet) {
    return connectWithProviderInternal(window.ethereum, 'coinbase', false);
  }
  toast('Coinbase provider not detected', 'warning');
}

async function connectInjected() {
  if (!window.ethereum) {
    toast('No injected wallet found', 'error');
    return;
  }
  return connectWithProviderInternal(window.ethereum, 'injected', false);
}

async function connectWalletConnect() {
  if (!window.EthereumProvider) {
    toast('WalletConnect provider script failed to load', 'error');
    return;
  }
  if (!walletConnectProjectId) {
    toast('WalletConnect is not configured on this deployment', 'error');
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
  return connectWithProviderInternal(wcProvider, 'walletconnect', false);
}

async function disconnectWallet() {
  STATE.provider = null;
  STATE.signer = null;
  STATE.wallet = null;
  STATE.walletType = null;
  clearWalletSession();
  setWalletButton();
  toast('Wallet disconnected', 'info');
}

async function restoreWalletSession() {
  const session = readWalletSession();
  if (!session) return;

  if (session.walletType === 'walletconnect') {
    if (!window.EthereumProvider || !walletConnectProjectId) {
      clearWalletSession();
      return;
    }
    try {
      const wcProvider = await window.EthereumProvider.init({
        projectId: walletConnectProjectId,
        chains: [BASE_CHAIN_DEC],
        optionalChains: [1, 8453],
        showQrModal: false
      });
      await connectWithProviderInternal(wcProvider, 'walletconnect', true);
      if (STATE.wallet !== session.wallet) clearWalletSession();
    } catch (_) {
      clearWalletSession();
    }
    return;
  }

  if (!window.ethereum) {
    clearWalletSession();
    return;
  }

  try {
    let providerCandidate = window.ethereum;
    if (Array.isArray(window.ethereum.providers)) {
      if (session.walletType === 'metamask') {
        providerCandidate = window.ethereum.providers.find((p) => p.isMetaMask) || window.ethereum;
      } else if (session.walletType === 'coinbase') {
        providerCandidate = window.ethereum.providers.find((p) => p.isCoinbaseWallet) || window.ethereum;
      }
    }
    await connectWithProviderInternal(providerCandidate, session.walletType, true);
    if (STATE.wallet !== session.wallet) clearWalletSession();
  } catch (_) {
    clearWalletSession();
  }
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

function authMessage(action, timestamp) {
  return [
    'SoulStarter Creator Authentication',
    `address:${STATE.wallet}`,
    `action:${action}`,
    `timestamp:${timestamp}`
  ].join('\n');
}

async function creatorAuth(action) {
  if (!STATE.signer || !STATE.wallet) {
    throw new Error('Connect wallet first');
  }
  const authTimestamp = Date.now();
  const authSignature = await STATE.signer.signMessage(authMessage(action, authTimestamp));
  return {
    wallet_address: STATE.wallet,
    auth_signature: authSignature,
    auth_timestamp: authTimestamp
  };
}

function splitTags(input) {
  return String(input || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function collectDraft() {
  return {
    listing: {
      soul_id: document.getElementById('soulId').value.trim(),
      name: document.getElementById('name').value.trim(),
      description: document.getElementById('description').value.trim(),
      long_description: document.getElementById('longDescription').value.trim(),
      category: document.getElementById('category').value.trim(),
      soul_type: document.getElementById('soulType').value.trim(),
      icon: document.getElementById('icon').value.trim(),
      tags: splitTags(document.getElementById('tags').value),
      price_usdc: Number(document.getElementById('priceUsdc').value),
      seller_address: document.getElementById('sellerAddress').value.trim() || DEFAULT_SELLER,
      creator_royalty_bps: Number(document.getElementById('creatorRoyaltyBps').value || 9900),
      platform_fee_bps: Number(document.getElementById('platformFeeBps').value || 100)
    },
    assets: {
      soul_markdown: document.getElementById('soulMarkdown').value,
      source_url: document.getElementById('sourceUrl').value.trim(),
      source_label: document.getElementById('sourceLabel').value.trim()
    }
  };
}

function applyDraft(draft) {
  const listing = draft?.listing || {};
  const assets = draft?.assets || {};
  document.getElementById('soulId').value = listing.soul_id || '';
  document.getElementById('name').value = listing.name || '';
  document.getElementById('description').value = listing.description || '';
  document.getElementById('longDescription').value = listing.long_description || '';
  document.getElementById('category').value = listing.category || '';
  document.getElementById('soulType').value = listing.soul_type || 'hybrid';
  document.getElementById('icon').value = listing.icon || '';
  document.getElementById('tags').value = Array.isArray(listing.tags) ? listing.tags.join(', ') : '';
  document.getElementById('priceUsdc').value = listing.price_usdc || '';
  document.getElementById('sellerAddress').value = listing.seller_address || DEFAULT_SELLER;
  document.getElementById('creatorRoyaltyBps').value = listing.creator_royalty_bps ?? 9900;
  document.getElementById('platformFeeBps').value = listing.platform_fee_bps ?? 100;
  document.getElementById('soulMarkdown').value = assets.soul_markdown || '';
  document.getElementById('sourceUrl').value = assets.source_url || '';
  document.getElementById('sourceLabel').value = assets.source_label || '';
}

async function api(action, { method = 'GET', body, headers = {} } = {}) {
  const url = `${API_BASE}?action=${encodeURIComponent(action)}`;
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.auth_message_template || `Request failed (${response.status})`);
  }
  return payload;
}

function setValidationOutput(value) {
  const output = document.getElementById('validationOutput');
  if (!output) return;
  output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function loadTemplate() {
  const data = await api('get_listing_template');
  applyDraft(data.template);
  setValidationOutput(data);
  setStatus('Template loaded.');
}

async function validateDraft() {
  const payload = await api('validate_listing_draft', {
    method: 'POST',
    body: collectDraft()
  });
  STATE.lastDraftId = payload.draft_id || null;
  setValidationOutput(payload);
  setStatus(payload.ok ? `Valid draft: ${payload.draft_id}` : 'Validation failed.');
  toast(payload.ok ? 'Draft validated' : 'Validation has errors', payload.ok ? 'success' : 'warning');
  return payload;
}

async function saveDraft() {
  const auth = await creatorAuth('save_listing_draft');
  const payload = await api('save_listing_draft', {
    method: 'POST',
    body: {
      ...auth,
      draft: collectDraft()
    }
  });
  STATE.lastDraftId = payload?.draft?.draft_id || null;
  setValidationOutput(payload);
  setStatus(`Draft saved: ${STATE.lastDraftId || 'unknown'}`);
  toast('Draft saved', 'success');
  return payload;
}

function renderDraftList(items) {
  const container = document.getElementById('draftList');
  if (!container) return;
  if (!Array.isArray(items) || items.length === 0) {
    container.innerHTML = '<p class="admin-empty">No drafts found for this wallet.</p>';
    return;
  }
  container.innerHTML = items
    .map(
      (item) => `
      <article class="admin-card">
        <div class="admin-card-row">
          <h4>${item.name || item.draft_id}</h4>
          <span class="badge badge-hybrid">${item.status || 'draft'}</span>
        </div>
        <p class="admin-line">draft_id: <code>${item.draft_id}</code></p>
        <p class="admin-line">soul_id: <code>${item.soul_id || '-'}</code></p>
        <p class="admin-line">updated: <code>${item.updated_at || '-'}</code></p>
        <div class="admin-card-actions">
          <button class="btn btn-ghost" data-action="load-draft" data-draft="${item.draft_id}">load</button>
          <button class="btn btn-primary" data-action="submit-review" data-draft="${item.draft_id}">submit for review</button>
        </div>
      </article>
    `
    )
    .join('');
}

async function listDrafts() {
  const auth = await creatorAuth('list_my_listing_drafts');
  const payload = await api('list_my_listing_drafts', {
    method: 'GET',
    headers: {
      'X-WALLET-ADDRESS': auth.wallet_address,
      'X-AUTH-SIGNATURE': auth.auth_signature,
      'X-AUTH-TIMESTAMP': String(auth.auth_timestamp)
    }
  });
  renderDraftList(payload.drafts || []);
  setStatus(`Loaded ${payload.count || 0} drafts.`);
  return payload;
}

async function loadDraftById(draftId) {
  const auth = await creatorAuth('get_my_listing_draft');
  const response = await fetch(
    `${API_BASE}?action=get_my_listing_draft&draft_id=${encodeURIComponent(draftId)}`,
    {
      method: 'GET',
      headers: {
        'X-WALLET-ADDRESS': auth.wallet_address,
        'X-AUTH-SIGNATURE': auth.auth_signature,
        'X-AUTH-TIMESTAMP': String(auth.auth_timestamp)
      }
    }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Unable to load draft (${response.status})`);
  }
  applyDraft(payload?.draft?.normalized || {});
  setValidationOutput(payload);
  setStatus(`Draft loaded: ${draftId}`);
  toast('Draft loaded', 'success');
}

async function submitForReview(draftId) {
  const auth = await creatorAuth('submit_listing_for_review');
  const payload = await api('submit_listing_for_review', {
    method: 'POST',
    body: {
      ...auth,
      draft_id: draftId
    }
  });
  setValidationOutput(payload);
  setStatus(`Draft submitted: ${draftId}`);
  toast('Draft submitted for review', 'success');
}

function bindEvents() {
  document.getElementById('loadTemplateBtn')?.addEventListener('click', async () => {
    try {
      await loadTemplate();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  document.getElementById('validateBtn')?.addEventListener('click', async () => {
    try {
      await validateDraft();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  document.getElementById('saveDraftBtn')?.addEventListener('click', async () => {
    try {
      await saveDraft();
      await listDrafts();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  document.getElementById('listDraftsBtn')?.addEventListener('click', async () => {
    try {
      await listDrafts();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  document.getElementById('refreshDraftsBtn')?.addEventListener('click', async () => {
    try {
      await listDrafts();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  document.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.getAttribute('data-action');
    const draftId = target.getAttribute('data-draft');
    if (!action || !draftId) return;
    target.setAttribute('disabled', 'true');
    try {
      if (action === 'load-draft') {
        await loadDraftById(draftId);
      } else if (action === 'submit-review') {
        await submitForReview(draftId);
        await listDrafts();
      }
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      target.removeAttribute('disabled');
    }
  });
}

function initDefaults() {
  document.getElementById('sellerAddress').value = DEFAULT_SELLER;
  document.getElementById('creatorRoyaltyBps').value = '9900';
  document.getElementById('platformFeeBps').value = '100';
  setWalletButton();
}

bindEvents();
initDefaults();
loadWalletConfig().then(() => restoreWalletSession());

window.closeWalletModal = closeWalletModal;
window.connectMetaMask = connectMetaMask;
window.connectCoinbase = connectCoinbase;
window.connectInjected = connectInjected;
window.connectWalletConnect = connectWalletConnect;
