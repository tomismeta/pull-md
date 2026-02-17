const CONFIG = {
  apiBase: '/api',
  requestTimeout: 45000,
  baseChainIdHex: '0x2105',
  baseChainIdDec: 8453,
  baseChainParams: {
    chainId: '0x2105',
    chainName: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.base.org'],
    blockExplorerUrls: ['https://basescan.org']
  }
};
const SIWE_DOMAIN = 'soulstarter.vercel.app';
const SIWE_URI = 'https://soulstarter.vercel.app';

const X402_FETCH_SDK_VERSION = '2.3.0';
const X402_EVM_SDK_VERSION = '2.3.1';
const EXPECTED_SELLER_ADDRESS = '0x7F46aCB709cd8DF5879F84915CA431fB740989E4';
const BASE_PUBLIC_RPC_URL = 'https://mainnet.base.org';
const ERC20_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const ERC20_TRANSFER_IFACE = new ethers.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const WALLET_SESSION_KEY = 'soulstarter_wallet_session_v1';
const RECEIPT_PREFIX = 'soulstarter.receipt.';
const REDOWNLOAD_SESSION_PREFIX = 'soulstarter.redownload.session.';
const sellerAddressCache = new Map();
const entitlementCacheByWallet = new Map();
const createdSoulCacheByWallet = new Map();
let moderatorAllowlist = new Set();
let soulCatalogCache = [];

let provider = null;
let signer = null;
let walletAddress = null;
let walletType = null;
let activeSuccessDownloadUrl = null;
let latestSoulDownload = null;
let baseRpcProvider = null;
let settlementVerificationSequence = 0;
let currentSoulDetailId = null;
let x402SdkModulesPromise = null;

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

function getUiShell() {
  const helper = window?.SoulStarterUiShell;
  if (!helper) {
    throw new Error('UI shell helper unavailable');
  }
  return helper;
}

function getSiweBuilder() {
  const helper = window?.SoulStarterSiwe;
  if (!helper || typeof helper.buildSoulActionMessage !== 'function') {
    throw new Error('SIWE message helper unavailable');
  }
  return helper;
}

function openWalletModal() {
  getUiShell().openModal('walletModal');
}

function closeWalletModal() {
  getUiShell().closeModal('walletModal');
}

function connectWallet() {
  openWalletModal();
}

function disconnectWallet() {
  if (walletAddress) {
    clearRedownloadSession(walletAddress);
  }
  provider = null;
  signer = null;
  walletAddress = null;
  walletType = null;
  clearWalletSession();
  entitlementCacheByWallet.clear();
  createdSoulCacheByWallet.clear();
  updateWalletUI();
  updateModeratorNavLinkVisibility();
  loadSouls();
  updateSoulPagePurchaseState();
  showToast('Wallet disconnected', 'info');
}

function saveWalletSession() {
  getWalletCommon().saveWalletSession({
    key: WALLET_SESSION_KEY,
    wallet: walletAddress,
    walletType
  });
}

function clearWalletSession() {
  getWalletCommon().clearWalletSession({ key: WALLET_SESSION_KEY });
}

function readWalletSession() {
  return getWalletCommon().readWalletSession({ key: WALLET_SESSION_KEY });
}

async function connectWithProvider(rawProvider) {
  return connectWithProviderInternal(rawProvider, 'injected', false);
}

async function connectWithProviderInternal(rawProvider, type, silent) {
  if (!rawProvider) throw new Error('Wallet provider not found');
  closeWalletModal();
  provider = new ethers.BrowserProvider(rawProvider, 'any');
  if (silent) {
    const accounts = await provider.send('eth_accounts', []);
    const first = Array.isArray(accounts) && accounts[0] ? String(accounts[0]) : '';
    if (!first) throw new Error('No existing wallet authorization found');
  } else {
    await provider.send('eth_requestAccounts', []);
  }
  signer = await provider.getSigner();
  walletAddress = (await signer.getAddress()).toLowerCase();
  walletType = type;
  await ensureBaseNetwork();
  saveWalletSession();
  await Promise.all([refreshEntitlementsForWallet(walletAddress), refreshCreatedSoulsForWallet(walletAddress)]);
  updateWalletUI();
  updateModeratorNavLinkVisibility();
  loadSouls();
  updateSoulPagePurchaseState();
  if (!silent) showToast('Wallet connected', 'success');
}

async function connectMetaMask() {
  const metamaskProvider = findProviderByKind('metamask');
  if (metamaskProvider) {
    return connectWithProviderInternal(metamaskProvider, 'metamask', false);
  }

  const fallback = fallbackInjectedProvider();
  if (!fallback) {
    showToast('MetaMask not found. Install MetaMask first.', 'error');
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
    showToast('Rabby wallet not found.', 'error');
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
    showToast('Bankr Wallet not found.', 'error');
    return;
  }

  showToast('Bankr-specific provider not detected. Using current injected wallet.', 'warning');
  return connectWithProviderInternal(fallback, 'bankr', false);
}

async function ensureBaseNetwork() {
  return getWalletCommon().ensureBaseNetwork(provider, {
    chainIdDec: CONFIG.baseChainIdDec,
    chainIdHex: CONFIG.baseChainIdHex,
    chainParams: CONFIG.baseChainParams
  });
}

function updateWalletUI() {
  const btn = document.getElementById('walletBtn');
  const text = document.getElementById('walletText');
  if (!btn || !text) return;

  if (walletAddress) {
    text.textContent = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
    btn.classList.add('connected');
    btn.onclick = disconnectWallet;
  } else {
    text.textContent = 'Connect Wallet';
    btn.classList.remove('connected');
    btn.onclick = openWalletModal;
  }
}

function updateModeratorNavLinkVisibility() {
  const navLinks = document.querySelectorAll('.moderator-nav-link');
  if (!navLinks.length) return;
  const show = Boolean(walletAddress && moderatorAllowlist.has(walletAddress));
  navLinks.forEach((el) => {
    el.style.display = show ? '' : 'none';
  });
}

function ownedSoulSetForCurrentWallet() {
  if (!walletAddress) return new Set();
  return entitlementCacheByWallet.get(walletAddress) || new Set();
}

function createdSoulSetForCurrentWallet() {
  if (!walletAddress) return new Set();
  return createdSoulCacheByWallet.get(walletAddress) || new Set();
}

function isSoulCreated(soulId) {
  if (!walletAddress || !soulId) return false;
  const created = createdSoulSetForCurrentWallet();
  return created.has(soulId);
}

function isSoulAccessible(soulId) {
  if (!walletAddress || !soulId) return false;
  const owned = ownedSoulSetForCurrentWallet();
  if (owned.has(soulId)) return true;
  const created = createdSoulSetForCurrentWallet();
  return created.has(soulId);
}

function parseSoulIdFromReceiptKey(key, wallet) {
  const prefix = `${RECEIPT_PREFIX}${wallet.toLowerCase()}.`;
  if (!String(key || '').startsWith(prefix)) return null;
  return String(key).slice(prefix.length);
}

function collectStoredProofs(wallet) {
  const proofs = [];
  try {
    const normalized = wallet.toLowerCase();
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      const soulId = parseSoulIdFromReceiptKey(key, normalized);
      if (!soulId) continue;
      const receipt = localStorage.getItem(key);
      if (!receipt) continue;
      proofs.push({ soul_id: soulId, receipt });
    }
  } catch (_) {}
  return proofs;
}

function getMcpClient() {
  const client = window?.SoulStarterMcp;
  if (!client || typeof client.callTool !== 'function') {
    throw new Error('MCP client unavailable');
  }
  return client;
}

async function mcpToolCall(name, args = {}) {
  return getMcpClient().callTool(name, args, {
    timeoutMs: CONFIG.requestTimeout,
    idPrefix: 'web'
  });
}

async function refreshEntitlementsForWallet(wallet) {
  if (!wallet) return;
  const proofs = collectStoredProofs(wallet);
  if (proofs.length === 0) {
    entitlementCacheByWallet.set(wallet.toLowerCase(), new Set());
    return;
  }
  try {
    const payload = await mcpToolCall('check_entitlements', {
      wallet_address: wallet.toLowerCase(),
      proofs
    });
    const owned = new Set(
      (Array.isArray(payload?.entitlements) ? payload.entitlements : [])
        .filter((entry) => entry?.entitled && entry?.soul_id)
        .map((entry) => String(entry.soul_id))
    );
    entitlementCacheByWallet.set(wallet.toLowerCase(), owned);
  } catch (_) {
    const fallback = new Set(proofs.map((proof) => String(proof.soul_id)));
    entitlementCacheByWallet.set(wallet.toLowerCase(), fallback);
  }
  renderOwnedSouls();
  updateSoulPagePurchaseState();
}

async function refreshCreatedSoulsForWallet(wallet) {
  if (!wallet) return;
  try {
    const payload = await mcpToolCall('list_published_listings', {});
    const created = new Set(
      (Array.isArray(payload?.listings) ? payload.listings : [])
        .filter((entry) => String(entry?.wallet_address || '').toLowerCase() === wallet.toLowerCase())
        .map((entry) => String(entry?.soul_id || '').trim())
        .filter(Boolean)
    );
    createdSoulCacheByWallet.set(wallet.toLowerCase(), created);
  } catch (_) {
    createdSoulCacheByWallet.set(wallet.toLowerCase(), new Set());
  }
  renderOwnedSouls();
  updateSoulPagePurchaseState();
}

function updateSoulPagePurchaseState() {
  const btn = document.getElementById('buyBtn');
  if (!btn) return;
  const soulId = String(btn.dataset.soulId || '').trim();
  if (!soulId) {
    const onclick = String(btn.getAttribute('onclick') || '');
    const match = onclick.match(/purchaseSoul\(['"]([^'"]+)['"]\)/);
    if (!match?.[1]) return;
    btn.dataset.soulId = match[1];
  }
  const resolvedSoulId = String(btn.dataset.soulId || '').trim();
  if (!resolvedSoulId) return;
  btn.onclick = () => purchaseSoul(resolvedSoulId);
  btn.removeAttribute('onclick');
  const owned = isSoulAccessible(resolvedSoulId);
  btn.textContent = owned ? 'Download SOUL.md' : 'Purchase SOUL.md';
}

function formatCreatorLabel(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/^Creator\s+(0x[a-fA-F0-9]{40})$/);
  if (match) {
    return `Creator ${shortenAddress(match[1])}`;
  }
  if (/^0x[a-fA-F0-9]{40}$/.test(text)) {
    return `Creator ${shortenAddress(text)}`;
  }
  return text || 'Creator';
}

function soulIdFromLocation() {
  try {
    const params = new URLSearchParams(window.location.search);
    return String(params.get('id') || '').trim();
  } catch (_) {
    return '';
  }
}

function soulListingHref(soulId) {
  return `/soul.html?id=${encodeURIComponent(String(soulId || '').trim())}`;
}

function updateSoulDetailMetadata(soul) {
  if (!soul || typeof soul !== 'object') return;
  const glyph = document.getElementById('soulDetailGlyph');
  if (glyph) glyph.textContent = getSoulGlyph(soul);

  const name = document.getElementById('soulDetailName');
  if (name) name.textContent = String(soul.name || soul.id || 'Soul');

  const description = document.getElementById('soulDetailDescription');
  if (description) description.textContent = String(soul.description || 'No description available.');

  const preview = document.getElementById('soulDetailPreview');
  if (preview) preview.textContent = String(soul.preview?.excerpt || soul.description || 'No preview available.');

  const type = String(soul.provenance?.type || 'hybrid').toLowerCase();
  const typeBadge = document.getElementById('soulDetailType');
  if (typeBadge) {
    typeBadge.textContent = type;
    typeBadge.className = `badge badge-${escapeHtml(type)}`;
  }

  const lineage = document.getElementById('soulDetailLineage');
  if (lineage) lineage.textContent = formatCreatorLabel(soul.provenance?.raised_by || '');

  const tagsWrap = document.getElementById('soulDetailTags');
  if (tagsWrap) {
    const tags = Array.isArray(soul.tags) ? soul.tags.filter(Boolean).slice(0, 6) : [];
    tagsWrap.innerHTML = tags.length
      ? tags.map((tag) => `<span class="tag">${escapeHtml(String(tag))}</span>`).join('')
      : '<span class="tag">untagged</span>';
  }

  const price = document.getElementById('soulDetailPrice');
  if (price) {
    const display = String(soul.price?.display || '').replace(/\s*USDC$/i, '');
    price.textContent = display || '$0.00';
  }

  const note = document.getElementById('soulDetailPurchaseNote');
  if (note) {
    const seller = soul.seller_address ? shortenAddress(soul.seller_address) : 'seller wallet';
    note.textContent = `Paid access via x402. Settlement recipient: ${seller}.`;
  }

  if (soul?.id) {
    currentSoulDetailId = String(soul.id);
    const btn = document.getElementById('buyBtn');
    if (btn) btn.dataset.soulId = currentSoulDetailId;
    document.title = `${String(soul.name || soul.id)} — SoulStarter`;
    const descMeta = document.querySelector('meta[name="description"]');
    if (descMeta) descMeta.setAttribute('content', String(soul.description || 'SoulStarter listing details.'));
  }
}

async function hydrateSoulDetailPage() {
  const pageRoot = document.getElementById('soulDetailPage');
  if (!pageRoot) return;
  const soulId = soulIdFromLocation();
  const btn = document.getElementById('buyBtn');
  if (btn) {
    btn.textContent = 'Loading...';
    btn.disabled = true;
  }
  if (!soulId) {
    showToast('Missing soul id in URL', 'error');
    if (btn) {
      btn.textContent = 'Unavailable';
    }
    return;
  }

  try {
    const payload = await mcpToolCall('get_soul_details', { id: soulId });
    const soul = payload?.soul || null;
    if (!soul) throw new Error('Soul metadata unavailable');
    soulCatalogCache = [soul, ...(Array.isArray(soulCatalogCache) ? soulCatalogCache.filter((item) => item.id !== soul.id) : [])];
    updateSoulDetailMetadata(soul);
    updateSoulPagePurchaseState();
  } catch (error) {
    showToast(error?.message || 'Unable to load soul details', 'error');
    const name = document.getElementById('soulDetailName');
    if (name) name.textContent = 'Soul unavailable';
    const description = document.getElementById('soulDetailDescription');
    if (description) description.textContent = 'This listing could not be loaded.';
    if (btn) {
      btn.textContent = 'Unavailable';
      btn.disabled = true;
    }
    return;
  }

  if (btn) btn.disabled = false;
}

function renderOwnedSouls() {
  const grid = document.getElementById('ownedSoulsGrid');
  if (!grid) return;

  if (!walletAddress) {
    grid.innerHTML = '<p class="admin-empty">Connect your wallet to view your purchased and created souls.</p>';
    return;
  }

  const owned = ownedSoulSetForCurrentWallet();
  const created = createdSoulSetForCurrentWallet();
  const allSoulIds = new Set([...owned, ...created]);
  if (!allSoulIds.size) {
    grid.innerHTML = '<p class="admin-empty">No purchased or created souls found for this wallet yet.</p>';
    return;
  }

  const byId = new Map((Array.isArray(soulCatalogCache) ? soulCatalogCache : []).map((soul) => [soul.id, soul]));
  const cards = [...allSoulIds].map((soulId) => {
    const soul = byId.get(soulId) || { id: soulId, name: soulId, description: 'Soul access available' };
    const cardDescription = formatCardDescription(soul.description, 'Soul access available');
    const isOwned = owned.has(soulId);
    const isCreated = created.has(soulId);
    const sourceLabel = isOwned && isCreated ? 'Purchased and created' : isCreated ? 'Creator access' : 'Wallet entitlement';
    return `
      <article class="soul-card" data-owned-soul-id="${escapeHtml(soul.id)}">
        <div class="soul-card-glyph">${escapeHtml(getSoulGlyph(soul))}</div>
        <h3>${escapeHtml(soul.name || soul.id)}</h3>
        <p>${escapeHtml(cardDescription)}</p>
        <div class="soul-card-meta">
          <div class="soul-lineage">
            ${
              isOwned
                ? '<span class="badge badge-organic">Owned</span>'
                : ''
            }
            ${
              isCreated
                ? '<span class="badge badge-synthetic">Created</span>'
                : ''
            }
            <span style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(sourceLabel)}</span>
          </div>
        </div>
        <div class="soul-card-actions">
          <a class="btn btn-ghost" href="${escapeHtml(soulListingHref(soul.id))}">View Listing</a>
          <button class="btn btn-primary" onclick="downloadOwnedSoul('${escapeHtml(soul.id)}')">Download SOUL.md</button>
        </div>
      </article>
    `;
  });

  grid.innerHTML = cards.join('');
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
    if (walletAddress !== session.wallet) clearWalletSession();
  } catch (_) {
    clearWalletSession();
  }
}

async function buildSiweAuthMessage({ wallet, soulId, action, timestamp }) {
  return getSiweBuilder().buildSoulActionMessage({
    domain: SIWE_DOMAIN,
    uri: SIWE_URI,
    chainId: CONFIG.baseChainIdDec,
    wallet,
    soulId,
    action,
    timestamp
  });
}

function normalizeAddress(address) {
  try {
    return ethers.getAddress(String(address || '').trim());
  } catch (_) {
    return null;
  }
}

function assertExpectedSellerAddress(payTo, expectedPayTo) {
  const expected = normalizeAddress(expectedPayTo || EXPECTED_SELLER_ADDRESS);
  const actual = normalizeAddress(payTo);
  if (!expected || !actual) {
    throw new Error('Invalid seller address in payment requirements');
  }
  if (expected !== actual) {
    throw new Error(
      `Security check failed: payment recipient mismatch. Expected ${expected}, got ${actual}. Do not continue.`
    );
  }
}

async function getExpectedSellerAddressForSoul(soulId) {
  if (sellerAddressCache.has(soulId)) {
    return sellerAddressCache.get(soulId);
  }
  try {
    const payload = await mcpToolCall('get_soul_details', { id: soulId });
    const seller = payload?.soul?.seller_address;
    const normalized = normalizeAddress(seller || EXPECTED_SELLER_ADDRESS);
    if (!normalized) throw new Error('invalid seller');
    sellerAddressCache.set(soulId, normalized);
    return normalized;
  } catch (_) {
    return normalizeAddress(EXPECTED_SELLER_ADDRESS);
  }
}

async function ensureRedownloadSession() {
  if (!walletAddress || !signer) throw new Error('Connect your wallet first');
  const existing = getStoredRedownloadSession(walletAddress);
  if (existing) return existing;

  const timestamp = Date.now();
  const siwe = await buildSiweAuthMessage({
    wallet: walletAddress,
    soulId: '*',
    action: 'session',
    timestamp
  });
  const signature = await signer.signMessage(siwe);
  const response = await fetchWithTimeout(`${CONFIG.apiBase}/auth/session`, {
    method: 'GET',
    headers: {
      'X-WALLET-ADDRESS': walletAddress,
      'X-AUTH-SIGNATURE': signature,
      'X-AUTH-TIMESTAMP': String(timestamp),
      Accept: 'application/json'
    }
  });
  if (!response.ok) {
    const error = await readError(response);
    throw new Error(error || 'Session authentication failed');
  }
  const body = await response.json().catch(() => ({}));
  const token = response.headers.get('X-REDOWNLOAD-SESSION') || body?.token || null;
  const expiresAtMs = Number(body?.expires_at_ms || Date.now() + 10 * 60 * 1000);
  if (token) storeRedownloadSession(walletAddress, token, expiresAtMs);
  return { token, expiresAtMs };
}

function normalizeTypedDataTypesForEthers(types) {
  const source = types && typeof types === 'object' ? types : {};
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'EIP712Domain') continue;
    result[key] = value;
  }
  return result;
}

async function loadX402SdkModules() {
  if (!x402SdkModulesPromise) {
    x402SdkModulesPromise = Promise.all([
      import(`https://esm.sh/@x402/fetch@${X402_FETCH_SDK_VERSION}?bundle`),
      import(`https://esm.sh/@x402/evm@${X402_EVM_SDK_VERSION}?bundle`)
    ]).then(([fetchSdk, evmSdk]) => ({
      x402Client: fetchSdk.x402Client,
      x402HTTPClient: fetchSdk.x402HTTPClient,
      ExactEvmScheme: evmSdk.ExactEvmScheme,
      toClientEvmSigner: evmSdk.toClientEvmSigner
    }));
  }
  return x402SdkModulesPromise;
}

function selectPaymentRequirement({
  accepts,
  expectedSeller,
  preferredAssetTransferMethod = 'eip3009'
}) {
  const options = Array.isArray(accepts) ? accepts : [];
  if (options.length === 0) {
    throw new Error('No payment requirements available');
  }
  const expected = normalizeAddress(expectedSeller || EXPECTED_SELLER_ADDRESS);
  const sellerMatches = options.filter((option) => normalizeAddress(option?.payTo) === expected);
  if (expected && sellerMatches.length === 0) {
    throw new Error(
      `Security check failed: payment recipient mismatch. Expected ${expected}. Do not continue.`
    );
  }
  const method = String(preferredAssetTransferMethod || 'eip3009').trim().toLowerCase();
  const target = method === 'permit2' ? 'permit2' : 'eip3009';
  const preferredMatches = (sellerMatches.length ? sellerMatches : options).filter(
    (option) => String(option?.extra?.assetTransferMethod || 'eip3009').toLowerCase() === target
  );
  if (preferredMatches.length > 0) return preferredMatches[0];
  const available = [...new Set((sellerMatches.length ? sellerMatches : options).map((option) =>
    String(option?.extra?.assetTransferMethod || 'eip3009').toLowerCase()
  ))];
  throw new Error(
    `No ${target} payment option available for this quote. Available methods: ${available.join(', ') || 'none'}.`
  );
}

async function createX402SdkEngine({
  wallet,
  activeSigner,
  expectedSeller,
  preferredAssetTransferMethod = 'eip3009'
}) {
  const sdk = await loadX402SdkModules();
  const clientSigner = sdk.toClientEvmSigner({
    address: wallet,
    signTypedData: async ({ domain, types, message }) => {
      const normalizedTypes = normalizeTypedDataTypesForEthers(types);
      return activeSigner.signTypedData(domain || {}, normalizedTypes, message || {});
    }
  });
  const paymentRequirementsSelector = (_version, accepts) =>
    selectPaymentRequirement({
      accepts,
      expectedSeller,
      preferredAssetTransferMethod
    });
  const client = sdk.x402Client.fromConfig({
    schemes: [
      {
        network: 'eip155:*',
        client: new sdk.ExactEvmScheme(clientSigner)
      }
    ],
    paymentRequirementsSelector
  });
  return {
    client,
    httpClient: new sdk.x402HTTPClient(client)
  };
}

async function decodePaymentRequiredWithSdk(response, httpClient) {
  let body;
  try {
    const text = await response.clone().text();
    if (text) {
      body = JSON.parse(text);
    }
  } catch (_) {}
  return httpClient.getPaymentRequiredResponse((name) => response.headers.get(name), body);
}

async function buildX402PaymentSignature(paymentRequired, soulId, x402Engine = null) {
  if (!paymentRequired || paymentRequired.x402Version !== 2) {
    throw new Error('Unsupported x402 version');
  }
  const accepted = Array.isArray(paymentRequired.accepts) ? paymentRequired.accepts : [];
  if (accepted.length === 0) {
    throw new Error('No payment requirements available');
  }
  const expectedSeller = await getExpectedSellerAddressForSoul(soulId);
  const selected = selectPaymentRequirement({
    accepts: accepted,
    expectedSeller,
    preferredAssetTransferMethod: 'eip3009'
  });
  const engine =
    x402Engine ||
    (await createX402SdkEngine({
      wallet: walletAddress,
      activeSigner: signer,
      expectedSeller,
      preferredAssetTransferMethod: 'eip3009'
    }));

  const normalizedPaymentRequired = {
    ...paymentRequired,
    accepts: [selected]
  };
  return engine.client.createPaymentPayload(normalizedPaymentRequired);
}

async function tryRedownload(soulId) {
  if (!walletAddress || !signer) return { ok: false, requiresPayment: true };

  const receipt = getStoredReceipt(soulId, walletAddress);
  const createdAccess = isSoulCreated(soulId);
  if (!receipt && !createdAccess) return { ok: false, requiresPayment: true };
  const activeSession = getStoredRedownloadSession(walletAddress);
  const passiveHeaders = {
    'X-WALLET-ADDRESS': walletAddress,
    Accept: 'text/markdown'
  };
  if (receipt) passiveHeaders['X-PURCHASE-RECEIPT'] = receipt;
  if (activeSession?.token) passiveHeaders['X-REDOWNLOAD-SESSION'] = activeSession.token;

  const passive = await fetchWithTimeout(`${CONFIG.apiBase}/souls/${encodeURIComponent(soulId)}/download`, {
    method: 'GET',
    headers: passiveHeaders
  });

  if (passive.ok) {
    const content = await passive.text();
    const tx = readSettlementTx(passive);
    const refreshedReceipt = passive.headers.get('X-PURCHASE-RECEIPT');
    if (refreshedReceipt) storeReceipt(soulId, walletAddress, refreshedReceipt);
    showPaymentSuccess(content, tx, soulId, true);
    return { ok: true };
  }

  if (passive.status !== 401 && passive.status !== 402) {
    const error = await readError(passive);
    throw new Error(error || 'Re-download failed');
  }

  // One-time wallet session bootstrap, then retry wallet entitlement download.
  await ensureRedownloadSession();
  const refreshedSession = getStoredRedownloadSession(walletAddress);
  const retryHeaders = {
    'X-WALLET-ADDRESS': walletAddress,
    Accept: 'text/markdown'
  };
  if (receipt) retryHeaders['X-PURCHASE-RECEIPT'] = receipt;
  if (refreshedSession?.token) retryHeaders['X-REDOWNLOAD-SESSION'] = refreshedSession.token;

  const signed = await fetchWithTimeout(`${CONFIG.apiBase}/souls/${encodeURIComponent(soulId)}/download`, {
    method: 'GET',
    headers: retryHeaders
  });

  if (signed.ok) {
    const content = await signed.text();
    const tx = readSettlementTx(signed);
    const refreshedReceipt = signed.headers.get('X-PURCHASE-RECEIPT');
    if (refreshedReceipt) storeReceipt(soulId, walletAddress, refreshedReceipt);
    showPaymentSuccess(content, tx, soulId, true);
    return { ok: true };
  }

  if (signed.status === 401 || signed.status === 402) {
    return { ok: false, requiresPayment: true };
  }
  const error = await readError(signed);
  throw new Error(error || 'Re-download failed');
}

async function purchaseSoul(soulId) {
  if (!walletAddress || !signer) {
    showToast('Connect wallet first', 'warning');
    openWalletModal();
    return;
  }

  const btn = document.getElementById('buyBtn');
  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Checking access...';
    }

    await ensureBaseNetwork();

    const prior = await tryRedownload(soulId);
    if (prior.ok) {
      if (walletAddress) {
        const owned = ownedSoulSetForCurrentWallet();
        owned.add(soulId);
        entitlementCacheByWallet.set(walletAddress, owned);
      }
      loadSouls();
      updateSoulPagePurchaseState();
      showToast('Entitlement verified. Download restored.', 'success');
      return;
    }

    if (btn) btn.textContent = 'Requesting x402 terms...';
    const expectedSeller = await getExpectedSellerAddressForSoul(soulId);
    const x402Engine = await createX402SdkEngine({
      wallet: walletAddress,
      activeSigner: signer,
      expectedSeller,
      preferredAssetTransferMethod: 'eip3009'
    });
    const initial = await fetchWithTimeout(`${CONFIG.apiBase}/souls/${encodeURIComponent(soulId)}/download`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-WALLET-ADDRESS': walletAddress,
        'X-ASSET-TRANSFER-METHOD': 'eip3009'
      }
    });

    if (initial.status !== 402) {
      const error = await readError(initial);
      throw new Error(error || `Expected 402 payment required (got ${initial.status})`);
    }

    const paymentRequired = await decodePaymentRequiredWithSdk(initial, x402Engine.httpClient);
    if (btn) btn.textContent = 'Signing x402 payment...';
    const paymentPayload = await buildX402PaymentSignature(paymentRequired, soulId, x402Engine);

    if (btn) btn.textContent = 'Submitting payment...';
    const paid = await fetchWithTimeout(`${CONFIG.apiBase}/souls/${encodeURIComponent(soulId)}/download`, {
      method: 'GET',
      headers: {
        'PAYMENT-SIGNATURE': btoa(JSON.stringify(paymentPayload)),
        'X-WALLET-ADDRESS': walletAddress,
        'X-ASSET-TRANSFER-METHOD': 'eip3009',
        Accept: 'text/markdown'
      }
    });

    if (!paid.ok) {
      const error = await readError(paid);
      throw new Error(error || 'Payment failed');
    }

    const settlementResponse = readSettlementResponse(paid);
    if (!settlementResponse?.success) {
      throw new Error('Payment did not include a confirmed settlement response');
    }

    const content = await paid.text();
    const tx = settlementResponse.transaction || null;
    const receipt = paid.headers.get('X-PURCHASE-RECEIPT');
    if (receipt) storeReceipt(soulId, walletAddress, receipt);
    if (walletAddress) {
      const owned = ownedSoulSetForCurrentWallet();
      owned.add(soulId);
      entitlementCacheByWallet.set(walletAddress, owned);
    }

    const expectedSettlement = {
      token: paymentPayload?.accepted?.asset || null,
      amount: paymentPayload?.accepted?.amount || null,
      payTo: paymentPayload?.accepted?.payTo || null,
      payer: walletAddress,
      network: paymentPayload?.accepted?.network || null
    };
    showPaymentSuccess(content, tx, soulId, false, expectedSettlement);
    showToast('Soul acquired successfully!', 'success');
    loadSouls();
    updateSoulPagePurchaseState();
  } catch (error) {
    console.error('Purchase failed:', error);
    showToast(`Purchase failed: ${error.message || 'Unknown error'}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Purchase Soul';
    }
  }
}

async function downloadOwnedSoul(soulId) {
  if (!walletAddress || !signer) {
    showToast('Connect your wallet first', 'warning');
    openWalletModal();
    return;
  }
  try {
    await ensureBaseNetwork();
    const prior = await tryRedownload(soulId);
    if (prior.ok) {
      showToast('Download restored from your entitlement.', 'success');
      return;
    }
    showToast('No purchase or creator entitlement found for this soul on this wallet.', 'warning');
  } catch (error) {
    showToast(`Download failed: ${error.message || 'Unknown error'}`, 'error');
  }
}

function readSettlementTx(response) {
  const payload = readSettlementResponse(response);
  return payload?.transaction || null;
}

function readSettlementResponse(response) {
  const header = response.headers.get('PAYMENT-RESPONSE');
  if (!header) return null;
  try {
    return JSON.parse(atob(header));
  } catch (_) {
    return null;
  }
}

function getBaseRpcProvider() {
  if (!baseRpcProvider) {
    baseRpcProvider = new ethers.JsonRpcProvider(BASE_PUBLIC_RPC_URL);
  }
  return baseRpcProvider;
}

function normalizeAddressLower(value) {
  try {
    return ethers.getAddress(String(value || '').trim()).toLowerCase();
  } catch (_) {
    return null;
  }
}

function parseBigInt(value) {
  try {
    if (value === null || value === undefined || value === '') return null;
    return BigInt(String(value));
  } catch (_) {
    return null;
  }
}

function isTransactionHash(value) {
  return /^0x[a-fA-F0-9]{64}$/.test(String(value || ''));
}

function formatMicroUsdc(value) {
  const amount = parseBigInt(value);
  if (amount === null) return '-';
  const whole = amount / 1000000n;
  const fractional = (amount % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fractional ? `${whole}.${fractional} USDC` : `${whole} USDC`;
}

function shortenAddress(value) {
  const normalized = normalizeAddressLower(value);
  if (!normalized) return String(value || '-');
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function renderSettlementVerification(view) {
  const panel = document.getElementById('settlementVerification');
  if (!panel) return;
  if (!view || view.phase === 'hidden') {
    panel.style.display = 'none';
    panel.className = 'settlement-verification';
    panel.innerHTML = '';
    return;
  }

  panel.style.display = 'block';
  if (view.phase === 'pending') {
    panel.className = 'settlement-verification settlement-verification-pending';
    panel.innerHTML = `
      <div class="settlement-verification-header">
        <strong>Verifying settlement</strong>
      </div>
      <p>Confirming on-chain USDC transfer details.</p>
    `;
    return;
  }

  if (view.phase === 'verified') {
    const actual = view.actual || {};
    panel.className = 'settlement-verification settlement-verification-ok';
    panel.innerHTML = `
      <div class="settlement-verification-header">
        <strong>Verified settlement</strong>
        <span class="verification-pill verification-pill-ok">Verified</span>
      </div>
      <p>This transaction matches SoulStarter payment expectations.</p>
      <dl class="verification-grid">
        <dt>Payer</dt><dd>${escapeHtml(shortenAddress(actual.from || view.expected?.payer || '-'))}</dd>
        <dt>Pay To</dt><dd>${escapeHtml(shortenAddress(actual.to || view.expected?.payTo || '-'))}</dd>
        <dt>Amount</dt><dd>${escapeHtml(formatMicroUsdc(actual.amount || view.expected?.amount || null))}</dd>
        <dt>Token</dt><dd>${escapeHtml(shortenAddress(view.expected?.token || '-'))}</dd>
      </dl>
    `;
    return;
  }

  panel.className = 'settlement-verification settlement-verification-warn';
  panel.innerHTML = `
    <div class="settlement-verification-header">
      <strong>Settlement not verified</strong>
      <span class="verification-pill verification-pill-warn">Check manually</span>
    </div>
    <p>${escapeHtml(view.reason || 'Transaction details did not match expected settlement fields.')}</p>
    <dl class="verification-grid">
      <dt>Expected Pay To</dt><dd>${escapeHtml(shortenAddress(view.expected?.payTo || '-'))}</dd>
      <dt>Expected Amount</dt><dd>${escapeHtml(formatMicroUsdc(view.expected?.amount || null))}</dd>
      <dt>Expected Token</dt><dd>${escapeHtml(shortenAddress(view.expected?.token || '-'))}</dd>
    </dl>
  `;
}

async function verifySettlementOnchain(txHash, expectedSettlement) {
  const expected = {
    token: normalizeAddressLower(expectedSettlement?.token),
    payTo: normalizeAddressLower(expectedSettlement?.payTo),
    payer: normalizeAddressLower(expectedSettlement?.payer),
    amount: parseBigInt(expectedSettlement?.amount),
    network: String(expectedSettlement?.network || '')
  };

  if (!isTransactionHash(txHash)) {
    return { verified: false, reason: 'Missing or invalid transaction hash.', expected };
  }

  if (expected.network && expected.network !== 'eip155:8453') {
    return { verified: false, reason: `Unexpected network: ${expected.network}`, expected };
  }

  const receipt = await getBaseRpcProvider().getTransactionReceipt(txHash);
  if (!receipt) {
    return { verified: false, reason: 'Transaction receipt not found yet.', expected };
  }
  if (Number(receipt.status) !== 1) {
    return { verified: false, reason: 'Transaction reverted on-chain.', expected };
  }

  const transfers = [];
  for (const log of receipt.logs || []) {
    if (normalizeAddressLower(log.address) !== expected.token) continue;
    if (!Array.isArray(log.topics) || String(log.topics[0] || '').toLowerCase() !== ERC20_TRANSFER_TOPIC.toLowerCase()) continue;
    try {
      const parsed = ERC20_TRANSFER_IFACE.parseLog(log);
      if (!parsed || parsed.name !== 'Transfer') continue;
      transfers.push({
        from: normalizeAddressLower(parsed.args.from),
        to: normalizeAddressLower(parsed.args.to),
        amount: parseBigInt(parsed.args.value)
      });
    } catch (_) {}
  }

  if (!transfers.length) {
    return { verified: false, reason: 'No USDC transfer log found for expected token in this transaction.', expected };
  }

  const exact = transfers.find((entry) => {
    if (!entry.from || !entry.to || entry.amount === null) return false;
    if (expected.payTo && entry.to !== expected.payTo) return false;
    if (expected.payer && entry.from !== expected.payer) return false;
    if (expected.amount !== null && entry.amount < expected.amount) return false;
    return true;
  });

  if (exact) {
    return { verified: true, expected, actual: exact };
  }

  const mismatch = [];
  const best = transfers[0];
  if (expected.payTo && !transfers.some((entry) => entry.to === expected.payTo)) mismatch.push('seller address mismatch');
  if (expected.payer && !transfers.some((entry) => entry.from === expected.payer)) mismatch.push('payer mismatch');
  if (expected.amount !== null && !transfers.some((entry) => entry.amount !== null && entry.amount >= expected.amount)) {
    mismatch.push('amount below expected value');
  }
  return {
    verified: false,
    expected,
    actual: best || null,
    reason: mismatch.length ? mismatch.join('; ') : 'Transfer log found but fields did not match expected payment details.'
  };
}

async function readError(response) {
  try {
    const body = await response.json();
    return body.error || body.message || null;
  } catch (_) {
    return null;
  }
}

function receiptStorageKey(wallet, soulId) {
  return `soulstarter.receipt.${wallet.toLowerCase()}.${soulId}`;
}

function redownloadSessionStorageKey(wallet) {
  return `${REDOWNLOAD_SESSION_PREFIX}${String(wallet || '').toLowerCase()}`;
}

function getStoredRedownloadSession(wallet) {
  try {
    const raw = localStorage.getItem(redownloadSessionStorageKey(wallet));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const token = String(parsed.token || '');
    const expiresAtMs = Number(parsed.expiresAtMs || 0);
    if (!token || !Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs) return null;
    return { token, expiresAtMs };
  } catch (_) {
    return null;
  }
}

function storeRedownloadSession(wallet, token, expiresAtMs) {
  try {
    localStorage.setItem(
      redownloadSessionStorageKey(wallet),
      JSON.stringify({
        token: String(token || ''),
        expiresAtMs: Number(expiresAtMs || 0)
      })
    );
  } catch (_) {}
}

function clearRedownloadSession(wallet) {
  try {
    localStorage.removeItem(redownloadSessionStorageKey(wallet));
  } catch (_) {}
}

function storeReceipt(soulId, wallet, receipt) {
  try {
    localStorage.setItem(receiptStorageKey(wallet, soulId), receipt);
    const normalized = wallet.toLowerCase();
    const owned = entitlementCacheByWallet.get(normalized) || new Set();
    owned.add(soulId);
    entitlementCacheByWallet.set(normalized, owned);
  } catch (_) {}
}

function getStoredReceipt(soulId, wallet) {
  try {
    return localStorage.getItem(receiptStorageKey(wallet, soulId));
  } catch (_) {
    return null;
  }
}

function triggerMarkdownDownload(content, soulId) {
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${soulId}-SOUL.md`;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isLikelyMobileBrowser() {
  if (typeof navigator === 'undefined') return false;
  const ua = String(navigator.userAgent || '');
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

async function handleSuccessDownloadClick(event) {
  if (!latestSoulDownload || !isLikelyMobileBrowser()) return;

  const { content, soulId } = latestSoulDownload;
  const filename = `${soulId}-SOUL.md`;
  event.preventDefault();

  if (navigator?.share && typeof File !== 'undefined') {
    try {
      const file = new File([content], filename, { type: 'text/markdown' });
      if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: filename,
          text: 'SoulStarter file',
          files: [file]
        });
        return;
      }
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }

  try {
    const viewUrl = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const opened = window.open(viewUrl, '_blank', 'noopener,noreferrer');
    if (!opened) {
      window.location.href = viewUrl;
    }
    setTimeout(() => {
      try {
        URL.revokeObjectURL(viewUrl);
      } catch (_) {}
    }, 60 * 1000);
    showToast('Opened SOUL.md. Use browser Share/Save to keep it locally.', 'info');
  } catch (_) {
    showToast('Unable to open SOUL.md. Try again from My Souls.', 'error');
  }
}

function revokeActiveSuccessDownloadUrl() {
  if (!activeSuccessDownloadUrl) return;
  try {
    URL.revokeObjectURL(activeSuccessDownloadUrl);
  } catch (_) {}
  activeSuccessDownloadUrl = null;
}

function showPaymentSuccess(content, txRef, soulId, redownload, expectedSettlement = null) {
  const txHash = typeof txRef === 'string' ? txRef : null;
  settlementVerificationSequence += 1;
  const verificationRunId = settlementVerificationSequence;
  latestSoulDownload = { content, soulId };
  const purchaseCard = document.getElementById('purchaseCard');
  if (purchaseCard) purchaseCard.style.display = 'none';

  const successCard = document.getElementById('successCard');
  const downloadLink = document.getElementById('downloadLink');
  if (successCard) {
    successCard.style.display = 'block';
    const heading = successCard.querySelector('h3');
    if (heading) {
      heading.textContent = redownload ? 'Soul Restored!' : 'Soul Acquired!';
    }

    const firstP = successCard.querySelector('p');
    if (firstP) {
      firstP.textContent = redownload
        ? 'Entitlement verified via wallet re-authentication.'
        : 'x402 payment settled successfully.';
    }
  }

  if (downloadLink) {
    revokeActiveSuccessDownloadUrl();
    activeSuccessDownloadUrl = URL.createObjectURL(new Blob([content], { type: 'text/markdown' }));
    downloadLink.href = activeSuccessDownloadUrl;
    downloadLink.download = `${soulId}-SOUL.md`;
    downloadLink.onclick = handleSuccessDownloadClick;
  }

  // Always trigger human download, even outside detail page cards.
  try {
    triggerMarkdownDownload(content, soulId);
  } catch (_) {}

  const txHashEl = document.getElementById('txHash');
  if (txHashEl && successCard) {
    txHashEl.textContent = '';
    if (txHash) {
      txHashEl.appendChild(document.createTextNode('Transaction: '));
      const link = document.createElement('a');
      link.href = `https://basescan.org/tx/${encodeURIComponent(txHash)}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `${txHash.slice(0, 10)}...${txHash.slice(-8)}`;
      txHashEl.appendChild(link);
    } else {
      txHashEl.textContent = 'Transaction: prior entitlement';
    }
  }

  if (redownload || !txHash || !expectedSettlement) {
    renderSettlementVerification({ phase: 'hidden' });
    return;
  }

  renderSettlementVerification({ phase: 'pending' });
  verifySettlementOnchain(txHash, expectedSettlement)
    .then((result) => {
      if (verificationRunId !== settlementVerificationSequence) return;
      if (result.verified) {
        renderSettlementVerification({
          phase: 'verified',
          actual: result.actual,
          expected: result.expected
        });
        return;
      }
      renderSettlementVerification({
        phase: 'warn',
        reason: result.reason,
        expected: result.expected
      });
    })
    .catch(() => {
      if (verificationRunId !== settlementVerificationSequence) return;
      renderSettlementVerification({
        phase: 'warn',
        reason: 'Unable to verify settlement right now. You can still inspect the transaction on BaseScan.',
        expected: expectedSettlement
      });
    });
}

function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = text;
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

function formatSoulPriceLabel(soul) {
  const numericAmount = Number(soul?.price?.amount);
  if (Number.isFinite(numericAmount) && numericAmount >= 0) {
    return `$${numericAmount.toFixed(2)}`;
  }
  const fallback = String(soul?.price?.display || soul?.priceDisplay || '').replace(/\s*USDC$/i, '').trim();
  return fallback || '$0.00';
}

function renderInventorySummary(souls, errorMessage = '') {
  const container = document.getElementById('liveInventorySummary');
  if (!container) return;
  const copy = container.querySelector('.hero-inventory-copy span');
  if (!copy) return;
  if (errorMessage) {
    copy.textContent = errorMessage;
    return;
  }
  if (!Array.isArray(souls) || souls.length === 0) {
    copy.textContent = 'No public souls listed yet.';
    return;
  }
  const topNames = souls
    .slice(0, 3)
    .map((soul) => String(soul?.name || '').trim())
    .filter(Boolean)
    .join(', ');
  const minPrice = souls.reduce((min, soul) => {
    const amount = Number(soul?.price?.amount);
    if (!Number.isFinite(amount)) return min;
    return Math.min(min, amount);
  }, Number.POSITIVE_INFINITY);
  const minPriceLabel = Number.isFinite(minPrice) ? `$${minPrice.toFixed(2)}` : null;
  copy.textContent = `${souls.length} public soul${souls.length === 1 ? '' : 's'}${minPriceLabel ? ` · from ${minPriceLabel} USDC` : ''}${topNames ? ` · ${topNames}` : ''}`;
}

function getSoulGlyph(soul) {
  const name = String(soul?.name || soul?.id || 'Soul').trim();
  const clean = name.replace(/[^a-zA-Z0-9 ]/g, '');
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  if (parts.length === 1 && parts[0].length >= 2) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  if (parts.length === 1 && parts[0].length === 1) {
    return `${parts[0].toUpperCase()}S`;
  }
  return 'SS';
}

async function loadSouls() {
  const grid = document.getElementById('soulsGrid');
  if (!grid) {
    renderOwnedSouls();
    return;
  }

  try {
    const response = await fetchWithTimeout('/api/souls');
    if (!response.ok) throw new Error('Failed to load soul catalog');
    const payload = await response.json();
    const souls = payload.souls || [];
    soulCatalogCache = souls;
    renderInventorySummary(souls);

    if (!souls.length) {
      grid.innerHTML =
        '<p class="admin-empty">No public souls are listed yet. Use <a href="/create.html">Create</a> to publish the first listing.</p>';
      renderOwnedSouls();
      return;
    }

    grid.innerHTML = souls
      .map(
        (soul) => {
          const owned = isSoulAccessible(soul.id);
          const cta = owned ? 'Download SOUL.md' : 'Purchase SOUL.md';
          const lineageLabel = formatCreatorLabel(soul.provenance?.raised_by || '');
          const type = String((soul.provenance?.type || 'hybrid')).toLowerCase();
          const cardDescription = formatCardDescription(soul.description, 'Soul listing available.');
          const priceLabel = formatSoulPriceLabel(soul);
          return `
      <article class="soul-card ${soul.id === 'sassy-starter-v1' ? 'soul-card-featured' : ''}" data-soul-id="${escapeHtml(soul.id)}">
        <div class="soul-card-glyph">${escapeHtml(getSoulGlyph(soul))}</div>
        <h3>${escapeHtml(soul.name)}</h3>
        <p>${escapeHtml(cardDescription)}</p>
        ${
          soul.source_url
            ? `<a class="soul-source-link" href="${escapeHtml(soul.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
                soul.source_label || 'Source'
              )}</a>`
            : ''
        }
        <div class="soul-card-meta">
          <div class="soul-lineage">
            <span class="badge badge-${escapeHtml(type)}">${escapeHtml(type)}</span>
            <span class="lineage-mini">${escapeHtml(lineageLabel || 'Unknown lineage')}</span>
          </div>
          <div>
            <span class="price">${escapeHtml(priceLabel)}</span>
            <span class="currency">USDC</span>
          </div>
        </div>
        <div class="soul-card-actions">
          <a class="btn btn-ghost" href="${escapeHtml(soulListingHref(soul.id))}">View Listing</a>
          <button class="btn btn-primary" onclick="${owned ? `downloadOwnedSoul('${escapeHtml(soul.id)}')` : `purchaseSoul('${escapeHtml(soul.id)}')`}">${escapeHtml(cta)}</button>
        </div>
      </article>
    `;
        }
      )
      .join('');
    renderOwnedSouls();
  } catch (error) {
    console.error('Catalog load failed:', error);
    grid.innerHTML = '<p>Souls are temporarily unavailable. Please try again.</p>';
    renderInventorySummary([], 'Souls are temporarily unavailable.');
    renderOwnedSouls();
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

async function fetchWithTimeout(url, options = {}, timeout = CONFIG.requestTimeout) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') throw new Error('Request timed out');
    throw error;
  }
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
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function bindWalletOptionHandlers() {
  const options = document.querySelectorAll('.wallet-option[data-wallet-kind]');
  options.forEach((option) => {
    option.addEventListener('click', async () => {
        const kind = option.getAttribute('data-wallet-kind');
        try {
          if (kind === 'metamask') {
            await connectMetaMask();
          } else if (kind === 'rabby') {
            await connectRabby();
          } else if (kind === 'bankr') {
            await connectBankr();
          }
      } catch (error) {
        showToast(error?.message || 'Wallet connection failed', 'error');
      }
    });
  });
}

function initMobileNav() {
  getUiShell().initMobileNav({
    toggleId: 'navToggle',
    navId: 'topNav',
    mobileMaxWidth: 760
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  initProviderDiscovery();
  initMobileNav();
  await loadModeratorAllowlist();
  bindWalletOptionHandlers();
  updateWalletUI();
  await restoreWalletSession();
  await refreshEntitlementsForWallet(walletAddress);
  await refreshCreatedSoulsForWallet(walletAddress);
  await hydrateSoulDetailPage();
  loadSouls();
  updateSoulPagePurchaseState();
});

window.openWalletModal = openWalletModal;
window.closeWalletModal = closeWalletModal;
window.connectWallet = connectWallet;
window.connectMetaMask = connectMetaMask;
window.connectRabby = connectRabby;
window.connectBankr = connectBankr;
window.disconnectWallet = disconnectWallet;
window.purchaseSoul = purchaseSoul;
window.downloadOwnedSoul = downloadOwnedSoul;
window.addEventListener('beforeunload', () => {
  revokeActiveSuccessDownloadUrl();
});
window.showToast = showToast;
