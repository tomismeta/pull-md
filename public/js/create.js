const MCP_ENDPOINT = '/mcp';
const BASE_CHAIN_HEX = '0x2105';
const BASE_CHAIN_DEC = 8453;
const SIWE_DOMAIN = (typeof window !== 'undefined' && window.location?.hostname) || 'pull.md';
const SIWE_URI = (typeof window !== 'undefined' && window.location?.origin) || `https://${SIWE_DOMAIN}`;
const WALLET_SESSION_KEY = 'soulstarter_wallet_session_v1';
let moderatorAllowlist = new Set();
const STATE = {
  provider: null,
  signer: null,
  wallet: null,
  walletType: null,
  connecting: false
};

function getMcpClient() {
  const client = window?.SoulStarterMcp;
  if (!client || typeof client.callTool !== 'function') {
    throw new Error('MCP client unavailable');
  }
  return client;
}

function getToastHelper() {
  const helper = window?.SoulStarterToast;
  if (!helper || typeof helper.show !== 'function') {
    throw new Error('Toast helper unavailable');
  }
  return helper;
}

async function mcpToolCall(name, args = {}) {
  return getMcpClient().callTool(name, args, {
    endpoint: MCP_ENDPOINT,
    idPrefix: 'create'
  });
}

function toast(message, type = 'info') {
  getToastHelper().show({
    message,
    type,
    containerId: 'toastContainer',
    durationMs: 2800,
    removeDelayMs: 200
  });
}

function setOutput(value) {
  const output = document.getElementById('publishOutput');
  if (!output) return;
  output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
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
  getWalletCommon().saveWalletSession({
    key: WALLET_SESSION_KEY,
    wallet: STATE.wallet,
    walletType: STATE.walletType
  });
}

function clearWalletSession() {
  getWalletCommon().clearWalletSession({ key: WALLET_SESSION_KEY });
}

function readWalletSession() {
  return getWalletCommon().readWalletSession({ key: WALLET_SESSION_KEY });
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

async function connectWithProviderInternal(rawProvider, walletType, silent) {
  return getWalletConnector().connectWithProviderInternal({
    rawProvider,
    walletType,
    silent,
    closeModal: closeWalletModal,
    ensureNetwork: ensureBaseNetwork,
    onState: (next) => {
      STATE.provider = next.provider;
      STATE.signer = next.signer;
      STATE.wallet = next.wallet;
      STATE.walletType = next.walletType;
    },
    afterConnected: async () => {
      saveWalletSession();
      setWalletButton();
      updateModeratorNavLinkVisibility();
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
    notify: toast,
    missingProviderMessage: 'MetaMask not found',
    fallbackNotice: 'MetaMask-specific provider not detected. Using current injected wallet.',
    throwOnMissingProvider: false
  });
}

async function connectRabbyProvider() {
  return getWalletConnector().connectWithPreferredKind({
    kind: 'rabby',
    walletType: 'rabby',
    connectInternal: connectWithProviderInternal,
    findProviderByKind,
    fallbackInjectedProvider,
    notify: toast,
    missingProviderMessage: 'Rabby wallet not found',
    fallbackNotice: 'Rabby-specific provider not detected. Using current injected wallet.',
    throwOnMissingProvider: false
  });
}

async function connectBankrProvider() {
  return getWalletConnector().connectWithPreferredKind({
    kind: 'bankr',
    walletType: 'bankr',
    connectInternal: connectWithProviderInternal,
    findProviderByKind,
    fallbackInjectedProvider,
    notify: toast,
    missingProviderMessage: 'Bankr Wallet not found',
    fallbackNotice: 'Bankr-specific provider not detected. Using current injected wallet.',
    throwOnMissingProvider: false
  });
}

function disconnectWallet() {
  STATE.provider = null;
  STATE.signer = null;
  STATE.wallet = null;
  STATE.walletType = null;
  clearWalletSession();
  setWalletButton();
  updateModeratorNavLinkVisibility();
  renderPublishedList([]);
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
    const payload = await mcpToolCall('list_moderators', {});
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

async function creatorSiweMessage(action, timestamp) {
  return getSiweBuilder().buildScopedMessage({
    domain: SIWE_DOMAIN,
    uri: SIWE_URI,
    chainId: BASE_CHAIN_DEC,
    wallet: STATE.wallet,
    scope: 'creator',
    action,
    timestamp
  });
}

async function creatorAuth(action) {
  if (!STATE.signer || !STATE.wallet) throw new Error('Connect your wallet first');
  const authTimestamp = Date.now();
  const authSignature = await STATE.signer.signMessage(await creatorSiweMessage(action, authTimestamp));
  return {
    wallet_address: STATE.wallet,
    auth_signature: authSignature,
    auth_timestamp: authTimestamp
  };
}

function collectListing() {
  const name = document.getElementById('name')?.value.trim() || '';
  const description = document.getElementById('description')?.value.trim() || '';
  const price = Number(document.getElementById('priceUsdc')?.value);
  const assetType = String(document.getElementById('assetType')?.value || 'soul').trim().toLowerCase();
  const soulMarkdown = document.getElementById('soulMarkdown')?.value || '';
  const fileName = assetType === 'skill' ? 'SKILL.md' : 'SOUL.md';
  return {
    asset_type: assetType,
    file_name: fileName,
    name,
    price_usdc: Number.isFinite(price) ? price : 0,
    description,
    content_markdown: soulMarkdown
  };
}

function applyTemplate(template) {
  const payload = template && typeof template === 'object' ? template : {};
  const assetType = String(payload.asset_type || document.getElementById('assetType')?.value || 'soul')
    .trim()
    .toLowerCase();
  const normalizedType = assetType === 'skill' ? 'skill' : 'soul';
  const fileName = normalizedType === 'skill' ? 'SKILL.md' : 'SOUL.md';
  const rawTemplateBody = normalizeTemplateMarkdown(payload.content_markdown || payload.soul_markdown || '').trim();
  const soulTemplate = `# SOUL.md

## Core Principles
- Define your non-negotiable values and decision rules.

## Operating Pattern
- Describe how this markdown asset plans, executes, and iterates.

## Boundaries
- Clarify what this asset should not do and when to refuse.

## Communication
- Specify tone, brevity, formatting, and interaction style.

## Continuity
- Define memory expectations, handoff behavior, and long-term consistency rules.`;
  const skillTemplate = `# SKILL.md

## Skill Scaffolding

### 1. Operating Principle 1 

### 2. Operating Principle 2

### 3. Operating Principle 3

## Task Management
1. 
2. 
3. 

## Core Principles
- **One**: 
- **Two**: 
- **Three**: `;

  const transformedBody =
    normalizedType === 'skill'
      ? skillTemplate
      : rawTemplateBody || soulTemplate;
  const textareaPlaceholder =
    normalizedType === 'skill'
      ? '# SKILL.md\n\n## Skill Scaffolding\n\n### 1. Operating Principle 1\n...'
      : '# SOUL.md\n\n## Core Principles\n...';

  document.getElementById('assetType').value = normalizedType;
  document.getElementById('name').value = payload.name || '';
  document.getElementById('description').value = payload.description || '';
  document.getElementById('priceUsdc').value = payload.price_usdc || '';
  document.getElementById('soulMarkdown').value = transformedBody;
  document.getElementById('soulMarkdown').setAttribute('placeholder', textareaPlaceholder);
}

function normalizeTemplateMarkdown(value) {
  const text = String(value || '');
  // Guard against escaped JSON newline sequences from older template payloads.
  return text.includes('\\n') ? text.replace(/\\n/g, '\n') : text;
}

async function api(action, { method = 'GET', body, headers = {} } = {}) {
  const normalizedAction = String(action || '').trim();
  const normalizedMethod = String(method || '').toUpperCase();
  if (normalizedAction === 'get_listing_template') {
    return mcpToolCall('get_listing_template', {});
  }

  if (normalizedAction === 'publish_listing') {
    if (normalizedMethod !== 'POST') {
      throw new Error('publish_listing requires POST');
    }
    return mcpToolCall('publish_listing', body && typeof body === 'object' ? body : {});
  }

  if (normalizedAction === 'list_my_published_listings') {
    const args = {
      wallet_address: String(headers['X-WALLET-ADDRESS'] || body?.wallet_address || '').trim(),
      auth_signature: String(headers['X-AUTH-SIGNATURE'] || body?.auth_signature || '').trim(),
      auth_timestamp: headers['X-AUTH-TIMESTAMP'] || body?.auth_timestamp
    };
    return mcpToolCall('list_my_published_listings', args);
  }

  throw new Error(`Unsupported create action: ${normalizedAction}`);
}

async function loadTemplate() {
  const payload = await api('get_listing_template');
  const selectedType = String(document.getElementById('assetType')?.value || 'soul').toLowerCase();
  const template = { ...(payload?.template || {}), asset_type: selectedType };
  applyTemplate(template);
  setOutput(payload);
  toast('Template loaded', 'info');
}

function renderPublishedList(items) {
  const container = document.getElementById('publishedList');
  if (!container) return;
  if (!STATE.wallet) {
    container.innerHTML = '<p class="admin-empty">Connect your wallet to view your published assets.</p>';
    return;
  }
  if (!Array.isArray(items) || items.length === 0) {
    container.innerHTML = '<p class="admin-empty">No published assets for this wallet yet.</p>';
    return;
  }
  container.innerHTML = items
    .map((item) => {
      const visibility = String(item.visibility || 'public');
      const shareUrl = String(item.share_url || '');
      const assetId = String(item.asset_id || item.soul_id || '').trim();
      const type = String(item.asset_type || 'asset').toLowerCase();
      const fileName = String(item.file_name || 'ASSET.md').trim() || 'ASSET.md';
      const creator = shortenAddress(item.wallet_address || STATE.wallet || '');
      const description = formatCardDescription(item.description, 'Published markdown listing.');
      return `
        <article class="soul-card">
          <div class="soul-card-title">
            <span class="title-hash ${hashToneClass(assetId || item.name)}">#</span>
            <h3>${escapeHtml(item.name || assetId)}</h3>
          </div>
          <p>${escapeHtml(description)}</p>
          <div class="soul-card-meta">
            <div class="soul-lineage">
              <span class="badge badge-${escapeHtml(type)}">${escapeHtml(type)}</span>
              <span class="lineage-mini">Creator ${escapeHtml(creator)}</span>
            </div>
            <div>
              <span class="price">${escapeHtml(item.price_display || '$0.00')}</span>
              <span class="currency">USDC</span>
            </div>
          </div>
          <p class="soul-format-label">${escapeHtml(fileName)} · ${escapeHtml(visibility)}</p>
          ${
            shareUrl
              ? `<div class="soul-card-actions">
                  <a class="btn btn-ghost" href="${escapeHtml(shareUrl)}" target="_blank" rel="noopener noreferrer">View Listing</a>
                  <button class="btn btn-primary" data-action="copy-share" data-url="${escapeHtml(shareUrl)}">Copy Link</button>
                </div>`
              : ''
          }
        </article>
      `;
    })
    .join('');
}

function getSoulGlyph(item) {
  const name = String(item?.name || item?.asset_id || item?.soul_id || 'Asset').trim();
  const clean = name.replace(/[^a-zA-Z0-9 ]/g, '');
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  if (parts.length === 1 && parts[0].length >= 2) return parts[0].slice(0, 2).toUpperCase();
  if (parts.length === 1 && parts[0].length === 1) return `${parts[0].toUpperCase()}M`;
  return 'MD';
}

function shortenAddress(value) {
  const raw = String(value || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) return raw || '-';
  return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value || '');
  return div.innerHTML;
}

function formatCardDescription(value, fallback) {
  const raw = String(value || '').replace(/\r?\n+/g, ' ').trim();
  if (!raw) return fallback;
  const cleaned = raw
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[*_`~>#]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([:;,.!?])/g, '$1')
    .trim();
  return cleaned || fallback;
}

function hashToneClass(seed) {
  const value = String(seed || 'asset');
  const tones = ['hash-tone-blue', 'hash-tone-orange', 'hash-tone-green', 'hash-tone-purple', 'hash-tone-yellow'];
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return tones[Math.abs(hash) % tones.length];
}

async function refreshPublished() {
  if (!STATE.wallet) {
    renderPublishedList([]);
    return;
  }
  const auth = await creatorAuth('list_my_published_listings');
  const payload = await api('list_my_published_listings', {
    method: 'GET',
    headers: {
      'X-WALLET-ADDRESS': auth.wallet_address,
      'X-AUTH-SIGNATURE': auth.auth_signature,
      'X-AUTH-TIMESTAMP': String(auth.auth_timestamp)
    }
  });
  renderPublishedList(payload.listings || []);
  toast(`Loaded ${payload.count || 0} published asset(s).`, 'info');
}

async function publishNow() {
  const auth = await creatorAuth('publish_listing');
  const payload = await api('publish_listing', {
    method: 'POST',
    body: {
      ...auth,
      listing: collectListing()
    }
  });
  setOutput(payload);
  toast(`Published ${payload?.listing?.asset_id || payload?.listing?.soul_id || 'listing'} successfully.`, 'success');
  toast('Asset published', 'success');
}

async function copyShareUrl(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast('Share link copied', 'success');
  } catch (_) {
    toast('Unable to copy link', 'warning');
  }
}

function bindEvents() {
  document.getElementById('loadTemplateBtn')?.addEventListener('click', async () => {
    try {
      await loadTemplate();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  document.getElementById('publishBtn')?.addEventListener('click', async () => {
    try {
      await publishNow();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  document.getElementById('refreshPublishedBtn')?.addEventListener('click', async () => {
    try {
      await refreshPublished();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  document.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.getAttribute('data-action') !== 'copy-share') return;
    const url = target.getAttribute('data-url');
    if (!url) return;
    await copyShareUrl(url);
  });
}

function initMobileNav() {
  getUiShell().initMobileNav({
    toggleId: 'navToggle',
    navId: 'topNav',
    mobileMaxWidth: 760
  });
}

function initDefaults() {
  initProviderDiscovery();
  initMobileNav();
  setWalletButton();
  setOutput('No publish response yet.');
  renderPublishedList([]);
}

initDefaults();
bindEvents();
loadModeratorAllowlist().then(() => restoreWalletSession());

async function handleWalletConnect(connectFn) {
  if (STATE.connecting) return;
  STATE.connecting = true;
  setWalletOptionsDisabled(true);
  try {
    await connectFn();
    if (!STATE.wallet || !STATE.signer) {
      throw new Error('Wallet connection did not complete. Please try again.');
    }
    toast('Wallet connected', 'success');
    renderPublishedList([]);
    toast('Wallet connected. Publish now, or refresh your private listing view.', 'info');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setWalletOptionsDisabled(false);
    STATE.connecting = false;
  }
}

window.closeWalletModal = closeWalletModal;
window.connectMetaMask = async () => {
  await handleWalletConnect(connectMetaMaskProvider);
};
window.connectRabby = async () => {
  await handleWalletConnect(connectRabbyProvider);
};
window.connectBankr = async () => {
  await handleWalletConnect(connectBankrProvider);
};
