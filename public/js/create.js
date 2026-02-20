const BASE_CHAIN_HEX = '0x2105';
const BASE_CHAIN_DEC = 8453;
const WALLET_SESSION_KEY = 'pullmd_wallet_session_v1';
let moderatorAllowlist = new Set();
const STATE = {
  provider: null,
  signer: null,
  wallet: null,
  walletType: null,
  connecting: false
};

function getToastHelper() {
  const helper = window?.PullMdToast;
  if (!helper || typeof helper.show !== 'function') {
    throw new Error('Toast helper unavailable');
  }
  return helper;
}

async function toolCall(name, args = {}) {
  const response = await fetch('/api/ui/tool', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      name: String(name || '').trim(),
      arguments: args && typeof args === 'object' ? args : {}
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = String(payload?.error || payload?.message || `UI tool request failed (${response.status})`);
    const toolError = new Error(message);
    if (payload && typeof payload === 'object') {
      Object.assign(toolError, payload);
    }
    throw toolError;
  }
  return payload || {};
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
  window?.PullMdWalletProviders?.initDiscovery?.();
}

function findProviderByKind(kind) {
  return window?.PullMdWalletProviders?.findProviderByKind?.(kind) || null;
}

function fallbackInjectedProvider() {
  return window?.PullMdWalletProviders?.fallbackInjectedProvider?.() || null;
}

function getWalletCommon() {
  const helper = window?.PullMdWalletCommon;
  if (!helper) {
    throw new Error('Wallet common helper unavailable');
  }
  return helper;
}

function getWalletConnector() {
  const helper = window?.PullMdWalletConnect;
  if (!helper) {
    throw new Error('Wallet connector helper unavailable');
  }
  return helper;
}

function getUiShell() {
  const helper = window?.PullMdUiShell;
  if (!helper) {
    throw new Error('UI shell helper unavailable');
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
    const response = await fetch('/api/moderation?action=list_moderators', {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(payload?.error || 'Failed to load moderators'));
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

async function creatorAuth(action) {
  if (!STATE.signer || !STATE.wallet) throw new Error('Connect your wallet first');
  const challenge = await toolCall('get_auth_challenge', {
    flow: 'creator',
    wallet_address: STATE.wallet,
    action
  });
  const message = String(challenge?.auth_message_template || '').trim();
  const issuedAt = String(challenge?.issued_at || '').trim();
  const challengeTimestamp = Number(challenge?.auth_timestamp_ms);
  const authTimestamp = Number.isFinite(challengeTimestamp) ? challengeTimestamp : Date.parse(issuedAt);
  if (!message || !Number.isFinite(authTimestamp)) {
    throw new Error('Failed to build creator SIWE challenge');
  }
  const authSignature = await STATE.signer.signMessage(message);
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
  const contentMarkdown = document.getElementById('soulMarkdown')?.value || '';
  const fileName = assetType === 'skill' ? 'SKILL.md' : 'SOUL.md';
  return {
    asset_type: assetType,
    file_name: fileName,
    name,
    price_usdc: Number.isFinite(price) ? price : 0,
    description,
    content_markdown: contentMarkdown
  };
}

function applyTemplate(template) {
  const payload = template && typeof template === 'object' ? template : {};
  const assetType = String(payload.asset_type || document.getElementById('assetType')?.value || 'soul')
    .trim()
    .toLowerCase();
  const normalizedType = assetType === 'skill' ? 'skill' : 'soul';
  const fileName = normalizedType === 'skill' ? 'SKILL.md' : 'SOUL.md';
  const rawTemplateBody = normalizeTemplateMarkdown(payload.content_markdown || '').trim();
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
    return toolCall('get_listing_template', {});
  }

  if (normalizedAction === 'publish_listing') {
    if (normalizedMethod !== 'POST') {
      throw new Error('publish_listing requires POST');
    }
    return toolCall('publish_listing', body && typeof body === 'object' ? body : {});
  }

  if (normalizedAction === 'list_my_published_listings') {
    const args = {
      wallet_address: String(headers['X-WALLET-ADDRESS'] || body?.wallet_address || '').trim(),
      auth_signature: String(headers['X-AUTH-SIGNATURE'] || body?.auth_signature || '').trim(),
      auth_timestamp: headers['X-AUTH-TIMESTAMP'] || body?.auth_timestamp
    };
    return toolCall('list_my_published_listings', args);
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
      const assetId = String(item.asset_id || '').trim();
      const type = String(item.asset_type || 'asset').toLowerCase();
      const fileName = String(item.file_name || 'ASSET.md').trim() || 'ASSET.md';
      const creator = shortenAddress(item.wallet_address || STATE.wallet || '');
      const description = formatCardDescription(item.description, 'Published markdown listing.');
      const scanIndicator = scanIndicatorHtml(item);
      return `
        <article class="soul-card">
          ${scanIndicator}
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

function scanIndicatorHtml(item) {
  const verdict = String(item?.scan_verdict || '').trim().toLowerCase();
  if (!verdict || verdict === 'disabled') return '';
  const summary = item?.scan_summary && typeof item.scan_summary === 'object' ? item.scan_summary : {};
  const warnCount = Number(summary?.by_action?.warn || 0);
  const blockCount = Number(summary?.by_action?.block || 0);
  const docsHref = '/security.html#technical-security';
  if (verdict === 'clean') {
    const tooltip =
      'Scanned on publish/edit for hidden Unicode, confusables, risky markdown or HTML, unsafe links, prompt-injection phrases, and leaked secrets.';
    return `<a class="scan-indicator scan-indicator-clean" href="${docsHref}" data-scan-tooltip="${escapeHtml(tooltip)}" title="${escapeHtml(
      tooltip
    )}" aria-label="Security scan clean. Open technical scan details."><span aria-hidden="true">✓</span></a>`;
  }
  if (verdict === 'warn') {
    const count = Number.isFinite(warnCount) ? warnCount : 0;
    const tooltip = `Scan warnings detected (${count}). Open technical scan details.`;
    return `<a class="scan-indicator scan-indicator-warn" href="${docsHref}" data-scan-tooltip="${escapeHtml(tooltip)}" title="${escapeHtml(
      tooltip
    )}" aria-label="Security scan warnings detected. Open technical scan details."><span aria-hidden="true">!</span></a>`;
  }
  if (verdict === 'block') {
    const count = Number.isFinite(blockCount) ? blockCount : 1;
    const tooltip = `Critical scan findings detected (${count}). Publication is blocked in enforce mode.`;
    return `<a class="scan-indicator scan-indicator-block" href="${docsHref}" data-scan-tooltip="${escapeHtml(tooltip)}" title="${escapeHtml(
      tooltip
    )}" aria-label="Critical security findings detected. Open technical scan details."><span aria-hidden="true">×</span></a>`;
  }
  return '';
}

function getSoulGlyph(item) {
  const name = String(item?.name || item?.asset_id || 'Asset').trim();
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
  const scanVerdict = String(payload?.scan_report?.verdict || '').trim().toLowerCase();
  if (scanVerdict === 'clean') {
    toast('Security scan clean', 'success');
  } else if (scanVerdict === 'warn') {
    const warnCount = Number(payload?.scan_report?.summary?.by_action?.warn || 0);
    toast(`Security scan warnings: ${Number.isFinite(warnCount) ? warnCount : 0}`, 'warning');
  }
  toast(`Published ${payload?.listing?.asset_id || 'listing'} successfully.`, 'success');
  await refreshPublished();
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
