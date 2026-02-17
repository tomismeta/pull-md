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
let settlementVerificationSequence = 0;
let currentSoulDetailId = null;

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

function getStorageHelper() {
  const helper = window?.SoulStarterStorage;
  if (!helper) {
    throw new Error('Storage helper unavailable');
  }
  return helper;
}

function getToastHelper() {
  const helper = window?.SoulStarterToast;
  if (!helper || typeof helper.show !== 'function') {
    throw new Error('Toast helper unavailable');
  }
  return helper;
}

function getSettlementVerifier() {
  const helper = window?.SoulStarterSettlementVerify;
  if (!helper || typeof helper.verifySettlementOnchain !== 'function' || typeof helper.formatMicroUsdc !== 'function') {
    throw new Error('Settlement verify helper unavailable');
  }
  return helper;
}

function getSettlementUiHelper() {
  const helper = window?.SoulStarterSettlementUi;
  if (
    !helper ||
    typeof helper.readSettlementResponse !== 'function' ||
    typeof helper.readSettlementTx !== 'function' ||
    typeof helper.renderSettlementVerification !== 'function'
  ) {
    throw new Error('Settlement UI helper unavailable');
  }
  return helper;
}

function getX402Helper() {
  const helper = window?.SoulStarterX402Browser;
  if (
    !helper ||
    typeof helper.normalizeAddress !== 'function' ||
    typeof helper.createSdkEngine !== 'function' ||
    typeof helper.decodePaymentRequiredWithSdk !== 'function' ||
    typeof helper.createPaymentPayload !== 'function'
  ) {
    throw new Error('x402 browser helper unavailable');
  }
  return helper;
}

function getRedownloadHelper() {
  const helper = window?.SoulStarterRedownloadFlow;
  if (
    !helper ||
    typeof helper.ensureRedownloadSession !== 'function' ||
    typeof helper.attemptRedownload !== 'function'
  ) {
    throw new Error('Redownload helper unavailable');
  }
  return helper;
}

function getSoulCardsHelper() {
  const helper = window?.SoulStarterSoulCards;
  if (
    !helper ||
    typeof helper.escapeHtml !== 'function' ||
    typeof helper.formatCardDescription !== 'function' ||
    typeof helper.formatSoulPriceLabel !== 'function' ||
    typeof helper.getSoulGlyph !== 'function' ||
    typeof helper.renderInventorySummary !== 'function' ||
    typeof helper.buildOwnedSoulCardsHtml !== 'function' ||
    typeof helper.buildCatalogSoulCardsHtml !== 'function'
  ) {
    throw new Error('Soul cards helper unavailable');
  }
  return helper;
}

function getDownloadDeliveryHelper() {
  const helper = window?.SoulStarterDownloadDelivery;
  if (
    !helper ||
    typeof helper.triggerMarkdownDownload !== 'function' ||
    typeof helper.isLikelyMobileBrowser !== 'function' ||
    typeof helper.handleMobileDownloadClick !== 'function'
  ) {
    throw new Error('Download delivery helper unavailable');
  }
  return helper;
}

function getSoulDetailUiHelper() {
  const helper = window?.SoulStarterSoulDetailUi;
  if (
    !helper ||
    typeof helper.soulIdFromLocation !== 'function' ||
    typeof helper.soulListingHref !== 'function' ||
    typeof helper.formatCreatorLabel !== 'function' ||
    typeof helper.updateSoulDetailMetadata !== 'function' ||
    typeof helper.updateSoulPagePurchaseState !== 'function'
  ) {
    throw new Error('Soul detail UI helper unavailable');
  }
  return helper;
}

function getSellerGuardHelper() {
  const helper = window?.SoulStarterSellerGuard;
  if (!helper || typeof helper.normalizeAddress !== 'function' || typeof helper.resolveExpectedSellerAddress !== 'function') {
    throw new Error('Seller guard helper unavailable');
  }
  return helper;
}

function getNetworkHelper() {
  const helper = window?.SoulStarterNetwork;
  if (!helper || typeof helper.fetchWithTimeout !== 'function' || typeof helper.readError !== 'function') {
    throw new Error('Network helper unavailable');
  }
  return helper;
}

function getAppBootstrapHelper() {
  const helper = window?.SoulStarterAppBootstrap;
  if (
    !helper ||
    typeof helper.bindWalletOptionHandlers !== 'function' ||
    typeof helper.runStartup !== 'function' ||
    typeof helper.bindBeforeUnload !== 'function'
  ) {
    throw new Error('App bootstrap helper unavailable');
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
  return getWalletConnector().connectWithProviderInternal({
    rawProvider,
    walletType: type,
    silent,
    closeModal: closeWalletModal,
    ensureNetwork: ensureBaseNetwork,
    onState: (next) => {
      provider = next.provider;
      signer = next.signer;
      walletAddress = next.wallet;
      walletType = next.walletType;
    },
    afterConnected: async ({ silent: wasSilent }) => {
      saveWalletSession();
      await Promise.all([refreshEntitlementsForWallet(walletAddress), refreshCreatedSoulsForWallet(walletAddress)]);
      updateWalletUI();
      updateModeratorNavLinkVisibility();
      loadSouls();
      updateSoulPagePurchaseState();
      if (!wasSilent) showToast('Wallet connected', 'success');
    }
  });
}

async function connectMetaMask() {
  return getWalletConnector().connectWithPreferredKind({
    kind: 'metamask',
    walletType: 'metamask',
    connectInternal: connectWithProviderInternal,
    findProviderByKind,
    fallbackInjectedProvider,
    notify: (message, type) => showToast(message, type),
    missingProviderMessage: 'MetaMask not found. Install MetaMask first.',
    fallbackNotice: 'MetaMask-specific provider not detected. Using current injected wallet.',
    throwOnMissingProvider: false
  });
}

async function connectRabby() {
  return getWalletConnector().connectWithPreferredKind({
    kind: 'rabby',
    walletType: 'rabby',
    connectInternal: connectWithProviderInternal,
    findProviderByKind,
    fallbackInjectedProvider,
    notify: (message, type) => showToast(message, type),
    missingProviderMessage: 'Rabby wallet not found.',
    fallbackNotice: 'Rabby-specific provider not detected. Using current injected wallet.',
    throwOnMissingProvider: false
  });
}

async function connectBankr() {
  return getWalletConnector().connectWithPreferredKind({
    kind: 'bankr',
    walletType: 'bankr',
    connectInternal: connectWithProviderInternal,
    findProviderByKind,
    fallbackInjectedProvider,
    notify: (message, type) => showToast(message, type),
    missingProviderMessage: 'Bankr Wallet not found.',
    fallbackNotice: 'Bankr-specific provider not detected. Using current injected wallet.',
    throwOnMissingProvider: false
  });
}

async function ensureBaseNetwork(targetProvider = provider) {
  return getWalletCommon().ensureBaseNetwork(targetProvider, {
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

function collectStoredProofs(wallet) {
  return getStorageHelper().collectStoredProofs(wallet, {
    receiptPrefix: RECEIPT_PREFIX
  });
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
  getSoulDetailUiHelper().updateSoulPagePurchaseState({
    walletAddress,
    currentSoulDetailId,
    soulCatalogCache,
    isSoulAccessible,
    buyButtonId: 'buyBtn',
    onPurchaseClick: purchaseSoul
  });
}

function formatCreatorLabel(raw) {
  return getSoulDetailUiHelper().formatCreatorLabel(raw, shortenAddress);
}

function soulIdFromLocation() {
  return getSoulDetailUiHelper().soulIdFromLocation(window.location);
}

function soulListingHref(soulId) {
  return getSoulDetailUiHelper().soulListingHref(soulId);
}

function updateSoulDetailMetadata(soul) {
  getSoulDetailUiHelper().updateSoulDetailMetadata({
    soul,
    escapeHtml,
    getSoulGlyph,
    shortenAddress,
    formatCreatorLabelFn: formatCreatorLabel
  });

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
  grid.innerHTML = getSoulCardsHelper().buildOwnedSoulCardsHtml({
    soulIds: [...allSoulIds],
    ownedSet: owned,
    createdSet: created,
    soulsById: byId,
    listingHrefBuilder: soulListingHref
  });
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
  return getSellerGuardHelper().normalizeAddress(address);
}

async function getExpectedSellerAddressForSoul(soulId) {
  return getSellerGuardHelper().resolveExpectedSellerAddress({
    soulId,
    defaultSellerAddress: EXPECTED_SELLER_ADDRESS,
    cache: sellerAddressCache,
    fetchSoulDetails: (id) => mcpToolCall('get_soul_details', { id })
  });
}

async function createX402SdkEngine({
  wallet,
  activeSigner,
  expectedSeller,
  preferredAssetTransferMethod = 'eip3009'
}) {
  return getX402Helper().createSdkEngine({
    wallet,
    signer: activeSigner,
    expectedSeller,
    defaultExpectedSeller: EXPECTED_SELLER_ADDRESS,
    preferredAssetTransferMethod,
    fetchSdkVersion: X402_FETCH_SDK_VERSION,
    evmSdkVersion: X402_EVM_SDK_VERSION
  });
}

async function decodePaymentRequiredWithSdk(response, httpClient) {
  return getX402Helper().decodePaymentRequiredWithSdk(response, httpClient);
}

async function buildX402PaymentSignature(paymentRequired, soulId, x402Engine = null) {
  const expectedSeller = await getExpectedSellerAddressForSoul(soulId);
  const result = await getX402Helper().createPaymentPayload({
    paymentRequired,
    expectedSeller,
    defaultExpectedSeller: EXPECTED_SELLER_ADDRESS,
    preferredAssetTransferMethod: 'eip3009',
    engine: x402Engine,
    wallet: walletAddress,
    signer,
    fetchSdkVersion: X402_FETCH_SDK_VERSION,
    evmSdkVersion: X402_EVM_SDK_VERSION
  });
  return result.payload;
}

async function tryRedownload(soulId) {
  return getRedownloadHelper().attemptRedownload({
    soulId,
    wallet: walletAddress,
    signer,
    apiBase: CONFIG.apiBase,
    fetchWithTimeout,
    readError,
    getStoredReceipt,
    storeReceipt,
    hasCreatorAccess: isSoulCreated,
    getStoredSession: getStoredRedownloadSession,
    storeSession: storeRedownloadSession,
    buildSiweAuthMessage,
    readSettlementTx,
    onSuccess: ({ content, tx, soulId: successSoulId }) => {
      showPaymentSuccess(content, tx, successSoulId, true);
    }
  });
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
  return getSettlementUiHelper().readSettlementTx(response);
}

function readSettlementResponse(response) {
  return getSettlementUiHelper().readSettlementResponse(response);
}

function normalizeAddressLower(value) {
  try {
    return ethers.getAddress(String(value || '').trim()).toLowerCase();
  } catch (_) {
    return null;
  }
}

function formatMicroUsdc(value) {
  return getSettlementVerifier().formatMicroUsdc(value);
}

function shortenAddress(value) {
  const normalized = normalizeAddressLower(value);
  if (!normalized) return String(value || '-');
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function renderSettlementVerification(view) {
  const panel = document.getElementById('settlementVerification');
  getSettlementUiHelper().renderSettlementVerification(panel, view, {
    escapeHtml,
    shortenAddress,
    formatMicroUsdc
  });
}

async function verifySettlementOnchain(txHash, expectedSettlement) {
  return getSettlementVerifier().verifySettlementOnchain(txHash, expectedSettlement);
}

async function readError(response) {
  return getNetworkHelper().readError(response);
}

function getStoredRedownloadSession(wallet) {
  return getStorageHelper().getStoredRedownloadSession(wallet, {
    redownloadSessionPrefix: REDOWNLOAD_SESSION_PREFIX
  });
}

function storeRedownloadSession(wallet, token, expiresAtMs) {
  getStorageHelper().storeRedownloadSession(wallet, token, expiresAtMs, {
    redownloadSessionPrefix: REDOWNLOAD_SESSION_PREFIX
  });
}

function clearRedownloadSession(wallet) {
  getStorageHelper().clearRedownloadSession(wallet, {
    redownloadSessionPrefix: REDOWNLOAD_SESSION_PREFIX
  });
}

function storeReceipt(soulId, wallet, receipt) {
  getStorageHelper().storeReceipt(soulId, wallet, receipt, {
    receiptPrefix: RECEIPT_PREFIX
  });
  const normalized = wallet.toLowerCase();
  const owned = entitlementCacheByWallet.get(normalized) || new Set();
  owned.add(soulId);
  entitlementCacheByWallet.set(normalized, owned);
}

function getStoredReceipt(soulId, wallet) {
  return getStorageHelper().getStoredReceipt(soulId, wallet, {
    receiptPrefix: RECEIPT_PREFIX
  });
}

function triggerMarkdownDownload(content, soulId) {
  getDownloadDeliveryHelper().triggerMarkdownDownload(content, soulId);
}

function isLikelyMobileBrowser() {
  return getDownloadDeliveryHelper().isLikelyMobileBrowser();
}

async function handleSuccessDownloadClick(event) {
  if (!latestSoulDownload || !isLikelyMobileBrowser()) return;
  const { content, soulId } = latestSoulDownload;
  await getDownloadDeliveryHelper().handleMobileDownloadClick({
    event,
    content,
    soulId,
    showToast
  });
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
  return getSoulCardsHelper().escapeHtml(text);
}

function formatCardDescription(value, fallback) {
  return getSoulCardsHelper().formatCardDescription(value, fallback);
}

function formatSoulPriceLabel(soul) {
  return getSoulCardsHelper().formatSoulPriceLabel(soul);
}

function renderInventorySummary(souls, errorMessage = '') {
  getSoulCardsHelper().renderInventorySummary({
    souls,
    errorMessage,
    containerId: 'liveInventorySummary'
  });
}

function getSoulGlyph(soul) {
  return getSoulCardsHelper().getSoulGlyph(soul);
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

    grid.innerHTML = getSoulCardsHelper().buildCatalogSoulCardsHtml({
      souls,
      isAccessible: isSoulAccessible,
      listingHrefBuilder: soulListingHref,
      lineageLabelForSoul: (soul) => formatCreatorLabel(soul?.provenance?.raised_by || '')
    });
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
  return getNetworkHelper().fetchWithTimeout(url, options, timeout);
}

function showToast(message, type = 'info') {
  getToastHelper().show({
    message,
    type,
    containerId: 'toastContainer',
    durationMs: 4000,
    removeDelayMs: 300
  });
}

function bindWalletOptionHandlers() {
  getAppBootstrapHelper().bindWalletOptionHandlers({
    selector: '.wallet-option[data-wallet-kind]',
    connectByKind: async (kind) => {
      if (kind === 'metamask') {
        await connectMetaMask();
      } else if (kind === 'rabby') {
        await connectRabby();
      } else if (kind === 'bankr') {
        await connectBankr();
      }
    },
    onError: (error) => {
      showToast(error?.message || 'Wallet connection failed', 'error');
    }
  });
}

function initMobileNav() {
  getUiShell().initMobileNav({
    toggleId: 'navToggle',
    navId: 'topNav',
    mobileMaxWidth: 760
  });
}

getAppBootstrapHelper().runStartup({
  initProviderDiscovery,
  initMobileNav,
  loadModeratorAllowlist,
  bindWalletOptions: bindWalletOptionHandlers,
  updateWalletUI,
  restoreWalletSession,
  refreshEntitlements: () => refreshEntitlementsForWallet(walletAddress),
  refreshCreatedSouls: () => refreshCreatedSoulsForWallet(walletAddress),
  hydrateSoulDetailPage,
  loadSouls,
  updateSoulPagePurchaseState
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
getAppBootstrapHelper().bindBeforeUnload(() => {
  revokeActiveSuccessDownloadUrl();
});
window.showToast = showToast;
