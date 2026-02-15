const API_BASE = '/api/mcp/tools/creator_marketplace';
const BASE_CHAIN_HEX = '0x2105';
const BASE_CHAIN_DEC = 8453;
const WALLET_SESSION_KEY = 'soulstarter_wallet_session_v1';
let moderatorAllowlist = new Set();
const providerMetadata = new WeakMap();
let providerDiscoveryInitialized = false;
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

function updateModeratorNavLinkVisibility() {
  const navLinks = document.querySelectorAll('.moderator-nav-link');
  if (!navLinks.length) return;
  const show = Boolean(STATE.wallet && moderatorAllowlist.has(STATE.wallet));
  navLinks.forEach((el) => {
    el.style.display = show ? '' : 'none';
  });
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
    updateModeratorNavLinkVisibility();
    if (!silent) toast('Wallet connected', 'success');
  } catch (error) {
    if (!silent) {
      toast(error.message || 'Wallet connection failed', 'error');
    }
    throw error;
  }
}

async function connectMetaMask() {
  const metamaskProvider = findProviderByKind('metamask');
  if (metamaskProvider) {
    return connectWithProviderInternal(metamaskProvider, 'metamask', false);
  }

  const fallback = fallbackInjectedProvider();
  if (!fallback) {
    toast('MetaMask not found', 'error');
    return;
  }

  toast('MetaMask-specific provider not detected. Using current injected wallet.', 'warning');
  return connectWithProviderInternal(fallback, 'metamask', false);
}

async function connectRabby() {
  const rabbyProvider = findProviderByKind('rabby');
  if (rabbyProvider) {
    return connectWithProviderInternal(rabbyProvider, 'rabby', false);
  }

  const fallback = fallbackInjectedProvider();
  if (!fallback) {
    toast('Rabby wallet not found', 'error');
    return;
  }

  toast('Rabby-specific provider not detected. Using current injected wallet.', 'warning');
  return connectWithProviderInternal(fallback, 'rabby', false);
}

async function connectBankr() {
  const bankrProvider = findProviderByKind('bankr');
  if (bankrProvider) {
    return connectWithProviderInternal(bankrProvider, 'bankr', false);
  }

  const fallback = fallbackInjectedProvider();
  if (!fallback) {
    toast('Bankr Wallet not found', 'error');
    return;
  }

  toast('Bankr-specific provider not detected. Using current injected wallet.', 'warning');
  return connectWithProviderInternal(fallback, 'bankr', false);
}

async function disconnectWallet() {
  STATE.provider = null;
  STATE.signer = null;
  STATE.wallet = null;
  STATE.walletType = null;
  clearWalletSession();
  setWalletButton();
  updateModeratorNavLinkVisibility();
  toast('Wallet disconnected', 'info');
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
    if (STATE.wallet !== session.wallet) clearWalletSession();
  } catch (_) {
    clearWalletSession();
  }
}

async function loadModeratorAllowlist() {
  try {
    const response = await fetch(`${API_BASE}?action=list_moderators`);
    if (!response.ok) throw new Error('moderator lookup failed');
    const payload = await response.json();
    moderatorAllowlist = new Set(
      (Array.isArray(payload?.moderators) ? payload.moderators : [])
        .map((wallet) => String(wallet || '').toLowerCase())
        .filter((wallet) => /^0x[a-f0-9]{40}$/i.test(wallet))
    );
  } catch (_) {
    moderatorAllowlist = new Set();
  }
  updateModeratorNavLinkVisibility();
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

function collectDraft() {
  const name = document.getElementById('name').value.trim();
  const description = document.getElementById('description').value.trim();
  const price = Number(document.getElementById('priceUsdc').value);
  const soulMarkdown = document.getElementById('soulMarkdown').value;

  return {
    name,
    price_usdc: Number.isFinite(price) ? price : 0,
    description,
    soul_markdown: soulMarkdown
  };
}

function applyDraft(draft) {
  const payload = draft && typeof draft === 'object' ? draft : {};
  const listing = payload.listing && typeof payload.listing === 'object' ? payload.listing : payload;
  const assets = payload.assets && typeof payload.assets === 'object' ? payload.assets : payload;
  document.getElementById('name').value = listing.name || '';
  document.getElementById('description').value = listing.description || '';
  document.getElementById('priceUsdc').value = listing.price_usdc || '';
  document.getElementById('soulMarkdown').value = assets.soul_markdown || '';
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

function initDefaults() {
  initProviderDiscovery();
  initMobileNav();
  setWalletButton();
}

bindEvents();
initDefaults();
loadModeratorAllowlist().then(() => restoreWalletSession());

window.closeWalletModal = closeWalletModal;
window.connectMetaMask = connectMetaMask;
window.connectRabby = connectRabby;
window.connectBankr = connectBankr;
