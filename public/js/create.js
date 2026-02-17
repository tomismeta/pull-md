const MCP_ENDPOINT = '/mcp';
const BASE_CHAIN_HEX = '0x2105';
const BASE_CHAIN_DEC = 8453;
const SIWE_DOMAIN = 'soulstarter.vercel.app';
const SIWE_URI = 'https://soulstarter.vercel.app';
const WALLET_SESSION_KEY = 'soulstarter_wallet_session_v1';
let moderatorAllowlist = new Set();
const providerMetadata = new WeakMap();
let providerDiscoveryInitialized = false;
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

async function mcpToolCall(name, args = {}) {
  return getMcpClient().callTool(name, args, {
    endpoint: MCP_ENDPOINT,
    idPrefix: 'create'
  });
}

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
  const el = document.getElementById('publishStatus');
  if (el) el.textContent = text;
}

function setOutput(value) {
  const output = document.getElementById('publishOutput');
  if (!output) return;
  output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
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

async function connectWithProviderInternal(rawProvider, walletType, silent) {
  if (!rawProvider) throw new Error('Wallet provider not found');
  closeWalletModal();
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
}

async function connectMetaMaskProvider() {
  const metamaskProvider = findProviderByKind('metamask');
  if (metamaskProvider) return connectWithProviderInternal(metamaskProvider, 'metamask', false);
  const fallback = fallbackInjectedProvider();
  if (!fallback) return toast('MetaMask not found', 'error');
  toast('MetaMask-specific provider not detected. Using current injected wallet.', 'warning');
  return connectWithProviderInternal(fallback, 'metamask', false);
}

async function connectRabbyProvider() {
  const rabbyProvider = findProviderByKind('rabby');
  if (rabbyProvider) return connectWithProviderInternal(rabbyProvider, 'rabby', false);
  const fallback = fallbackInjectedProvider();
  if (!fallback) return toast('Rabby wallet not found', 'error');
  toast('Rabby-specific provider not detected. Using current injected wallet.', 'warning');
  return connectWithProviderInternal(fallback, 'rabby', false);
}

async function connectBankrProvider() {
  const bankrProvider = findProviderByKind('bankr');
  if (bankrProvider) return connectWithProviderInternal(bankrProvider, 'bankr', false);
  const fallback = fallbackInjectedProvider();
  if (!fallback) return toast('Bankr Wallet not found', 'error');
  toast('Bankr-specific provider not detected. Using current injected wallet.', 'warning');
  return connectWithProviderInternal(fallback, 'bankr', false);
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

async function sha256Hex(input) {
  const enc = new TextEncoder().encode(String(input));
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function creatorSiweMessage(action, timestamp) {
  const ts = Number(timestamp);
  const nonceSeed = `creator|${String(action || '')}|${String(ts)}`;
  const nonce = (await sha256Hex(nonceSeed)).slice(0, 16);
  return [
    `${SIWE_DOMAIN} wants you to sign in with your Ethereum account:`,
    String(STATE.wallet || '').toLowerCase(),
    '',
    'Authenticate wallet ownership for SoulStarter. No token transfer or approval.',
    '',
    `URI: ${SIWE_URI}`,
    'Version: 1',
    `Chain ID: ${BASE_CHAIN_DEC}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date(ts).toISOString()}`,
    `Expiration Time: ${new Date(ts + 5 * 60 * 1000).toISOString()}`,
    `Request ID: ${String(action || 'creator')}:creator`,
    'Resources:',
    `- urn:soulstarter:action:${String(action || '')}`,
    '- urn:soulstarter:scope:creator'
  ].join('\n');
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
  const soulMarkdown = document.getElementById('soulMarkdown')?.value || '';
  return {
    name,
    price_usdc: Number.isFinite(price) ? price : 0,
    description,
    soul_markdown: soulMarkdown
  };
}

function applyTemplate(template) {
  const payload = template && typeof template === 'object' ? template : {};
  document.getElementById('name').value = payload.name || '';
  document.getElementById('description').value = payload.description || '';
  document.getElementById('priceUsdc').value = payload.price_usdc || '';
  document.getElementById('soulMarkdown').value = normalizeTemplateMarkdown(payload.soul_markdown || '');
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
  applyTemplate(payload.template);
  setOutput(payload);
  setStatus('Example loaded.');
}

function renderPublishedList(items) {
  const container = document.getElementById('publishedList');
  if (!container) return;
  if (!STATE.wallet) {
    container.innerHTML = '<p class="admin-empty">Connect your wallet to view your published souls.</p>';
    return;
  }
  if (!Array.isArray(items) || items.length === 0) {
    container.innerHTML = '<p class="admin-empty">No published souls for this wallet yet.</p>';
    return;
  }
  container.innerHTML = items
    .map((item) => {
      const visibility = String(item.visibility || 'public');
      const shareUrl = String(item.share_url || '');
      const soulId = String(item.soul_id || '').trim();
      const type = 'hybrid';
      const creator = shortenAddress(item.wallet_address || STATE.wallet || '');
      const description = formatCardDescription(item.description, 'Published soul listing.');
      return `
        <article class="soul-card">
          <div class="soul-card-glyph">${escapeHtml(getSoulGlyph(item))}</div>
          <h3>${escapeHtml(item.name || soulId)}</h3>
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
          <p class="soul-format-label">${escapeHtml(visibility)}</p>
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
  const name = String(item?.name || item?.soul_id || 'Soul').trim();
  const clean = name.replace(/[^a-zA-Z0-9 ]/g, '');
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  if (parts.length === 1 && parts[0].length >= 2) return parts[0].slice(0, 2).toUpperCase();
  if (parts.length === 1 && parts[0].length === 1) return `${parts[0].toUpperCase()}S`;
  return 'SS';
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
  setStatus(`Loaded ${payload.count || 0} published listing(s).`);
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
  setStatus(`Published ${payload?.listing?.soul_id || 'listing'} successfully.`);
  toast('Soul published', 'success');
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
  setStatus('Ready to publish.');
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
    toast('Wallet connected', 'success');
    renderPublishedList([]);
    setStatus('Wallet connected. Publish now, or click Refresh to load your private listing view.');
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
