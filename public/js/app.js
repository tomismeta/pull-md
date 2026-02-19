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

const X402_FETCH_SDK_VERSION = '2.3.0';
const X402_EVM_SDK_VERSION = '2.3.1';
const EXPECTED_SELLER_ADDRESS = null;
const WALLET_SESSION_KEY = 'pullmd_wallet_session_v1';
const RECEIPT_PREFIX = 'pullmd.receipt.';
const REDOWNLOAD_SESSION_PREFIX = 'pullmd.redownload.session.';
const sellerAddressCache = new Map();
const entitlementCacheByWallet = new Map();
const createdSoulCacheByWallet = new Map();
let moderatorAllowlist = new Set();
let soulCatalogCache = [];
let currentAssetTypeFilter = 'all';
let currentSearchQuery = '';

let provider = null;
let signer = null;
let walletAddress = null;
let walletType = null;
let currentSoulDetailId = null;
let purchaseFlowController = null;

function initProviderDiscovery() {
  window?.PullMdWalletProviders?.initDiscovery?.();
}

function findProviderByKind(kind) {
  return window?.PullMdWalletProviders?.findProviderByKind?.(kind) || null;
}

function fallbackInjectedProvider() {
  return window?.PullMdWalletProviders?.fallbackInjectedProvider?.() || null;
}

const HELPER_SPECS = Object.freeze({
  walletCommon: {
    globalName: 'PullMdWalletCommon',
    methods: [],
    error: 'Wallet common helper unavailable'
  },
  walletConnector: {
    globalName: 'PullMdWalletConnect',
    methods: [],
    error: 'Wallet connector helper unavailable'
  },
  storage: {
    globalName: 'PullMdStorage',
    methods: [],
    error: 'Storage helper unavailable'
  },
  walletState: {
    globalName: 'PullMdWalletState',
    methods: [
      'updateWalletUI',
      'updateModeratorNavLinks',
      'ownedSoulSetForWallet',
      'createdSoulSetForWallet',
      'isSoulCreated',
      'isSoulAccessible',
      'collectStoredProofs',
      'refreshEntitlementsForWallet',
      'refreshCreatedSoulsForWallet',
      'loadModeratorAllowlist'
    ],
    error: 'Wallet state helper unavailable'
  },
  toast: {
    globalName: 'PullMdToast',
    methods: ['show'],
    error: 'Toast helper unavailable'
  },
  settlementVerify: {
    globalName: 'PullMdSettlementVerify',
    methods: ['verifySettlementOnchain', 'formatMicroUsdc'],
    error: 'Settlement verify helper unavailable'
  },
  settlementUi: {
    globalName: 'PullMdSettlementUi',
    methods: ['readSettlementResponse', 'readSettlementTx', 'renderSettlementVerification'],
    error: 'Settlement UI helper unavailable'
  },
  x402Browser: {
    globalName: 'PullMdX402Browser',
    methods: ['normalizeAddress', 'createSdkEngine', 'decodePaymentRequiredWithSdk', 'createPaymentPayload'],
    error: 'x402 browser helper unavailable'
  },
  redownload: {
    globalName: 'PullMdRedownloadFlow',
    methods: ['ensureRedownloadSession', 'attemptRedownload'],
    error: 'Redownload helper unavailable'
  },
  soulCards: {
    globalName: 'PullMdSoulCards',
    methods: [
      'escapeHtml',
      'formatCardDescription',
      'formatSoulPriceLabel',
      'getSoulGlyph',
      'renderInventorySummary',
      'buildOwnedSoulCardsHtml',
      'buildCatalogSoulCardsHtml'
    ],
    error: 'Soul cards helper unavailable'
  },
  catalogUi: {
    globalName: 'PullMdCatalogUi',
    methods: [
      'updateSoulPagePurchaseState',
      'updateSoulDetailMetadata',
      'hydrateSoulDetailPage',
      'renderOwnedSouls',
      'loadSouls',
      'renderCatalogGrid'
    ],
    error: 'Catalog UI helper unavailable'
  },
  downloadDelivery: {
    globalName: 'PullMdDownloadDelivery',
    methods: ['triggerMarkdownDownload', 'isLikelyMobileBrowser', 'handleMobileDownloadClick'],
    error: 'Download delivery helper unavailable'
  },
  purchaseFlow: {
    globalName: 'PullMdPurchaseFlow',
    methods: ['createController'],
    error: 'Purchase flow helper unavailable'
  },
  soulDetailUi: {
    globalName: 'PullMdSoulDetailUi',
    methods: ['soulIdFromLocation', 'soulListingHref', 'formatCreatorLabel', 'updateSoulDetailMetadata', 'updateSoulPagePurchaseState'],
    error: 'Soul detail UI helper unavailable'
  },
  sellerGuard: {
    globalName: 'PullMdSellerGuard',
    methods: ['normalizeAddress', 'resolveExpectedSellerAddress'],
    error: 'Seller guard helper unavailable'
  },
  network: {
    globalName: 'PullMdNetwork',
    methods: ['fetchWithTimeout', 'readError'],
    error: 'Network helper unavailable'
  },
  appBootstrap: {
    globalName: 'PullMdAppBootstrap',
    methods: ['bindWalletOptionHandlers', 'runStartup', 'bindBeforeUnload'],
    error: 'App bootstrap helper unavailable'
  },
  uiShell: {
    globalName: 'PullMdUiShell',
    methods: [],
    error: 'UI shell helper unavailable'
  },
  siwe: {
    globalName: 'PullMdSiwe',
    methods: ['buildSoulActionMessage'],
    error: 'SIWE message helper unavailable'
  }
});

function requireHelper(specKey) {
  const spec = HELPER_SPECS[specKey];
  if (!spec) throw new Error(`Unknown helper spec: ${specKey}`);
  const helper = window?.[spec.globalName];
  if (!helper) throw new Error(spec.error);
  const requiredMethods = Array.isArray(spec.methods) ? spec.methods : [];
  const missing = requiredMethods.some((methodName) => typeof helper[methodName] !== 'function');
  if (missing) throw new Error(spec.error);
  return helper;
}

function getWalletCommon() { return requireHelper('walletCommon'); }
function getWalletConnector() { return requireHelper('walletConnector'); }
function getStorageHelper() { return requireHelper('storage'); }
function getWalletStateHelper() { return requireHelper('walletState'); }
function getToastHelper() { return requireHelper('toast'); }
function getSettlementVerifier() { return requireHelper('settlementVerify'); }
function getSettlementUiHelper() { return requireHelper('settlementUi'); }
function getX402Helper() { return requireHelper('x402Browser'); }
function getRedownloadHelper() { return requireHelper('redownload'); }
function getSoulCardsHelper() { return requireHelper('soulCards'); }
function getCatalogUiHelper() { return requireHelper('catalogUi'); }
function getDownloadDeliveryHelper() { return requireHelper('downloadDelivery'); }
function getPurchaseFlowHelper() { return requireHelper('purchaseFlow'); }
function getSoulDetailUiHelper() { return requireHelper('soulDetailUi'); }
function getSellerGuardHelper() { return requireHelper('sellerGuard'); }
function getNetworkHelper() { return requireHelper('network'); }
function getAppBootstrapHelper() { return requireHelper('appBootstrap'); }
function getUiShell() { return requireHelper('uiShell'); }

function getPurchaseFlowController() {
  if (purchaseFlowController) return purchaseFlowController;
  purchaseFlowController = getPurchaseFlowHelper().createController({
    apiBase: CONFIG.apiBase,
    getWalletAddress: () => walletAddress,
    getSigner: () => signer,
    showToast,
    openWalletModal,
    ensureBaseNetwork,
    tryRedownload: (soulId) => tryRedownload(soulId),
    getExpectedSellerAddressForSoul,
    createX402SdkEngine,
    fetchWithTimeout,
    decodePaymentRequiredWithSdk,
    buildX402PaymentSignature,
    readError,
    readSettlementResponse,
    storeReceipt,
    markSoulOwned: (soulId) => {
      if (!walletAddress) return;
      const normalized = walletAddress.toLowerCase();
      const owned = entitlementCacheByWallet.get(normalized) || new Set();
      owned.add(soulId);
      entitlementCacheByWallet.set(normalized, owned);
    },
    loadSouls,
    updateSoulPagePurchaseState,
    renderSettlementVerification,
    verifySettlementOnchain,
    triggerMarkdownDownload,
    isLikelyMobileBrowser,
    handleMobileDownloadClick: ({ event, content, soulId, showToast: notify }) =>
      getDownloadDeliveryHelper().handleMobileDownloadClick({
        event,
        content,
        soulId,
        showToast: notify
      })
  });
  return purchaseFlowController;
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
  getWalletStateHelper().updateWalletUI({
    walletAddress,
    buttonId: 'walletBtn',
    labelId: 'walletText',
    onDisconnect: disconnectWallet,
    onConnect: openWalletModal
  });
}

function updateModeratorNavLinkVisibility() {
  getWalletStateHelper().updateModeratorNavLinks({
    walletAddress,
    moderatorAllowlist,
    selector: '.moderator-nav-link'
  });
}

function ownedSoulSetForCurrentWallet() {
  return getWalletStateHelper().ownedSoulSetForWallet({
    walletAddress,
    entitlementCacheByWallet
  });
}

function createdSoulSetForCurrentWallet() {
  return getWalletStateHelper().createdSoulSetForWallet({
    walletAddress,
    createdSoulCacheByWallet
  });
}

function isSoulCreated(soulId) {
  return getWalletStateHelper().isSoulCreated({
    walletAddress,
    soulId,
    createdSoulCacheByWallet
  });
}

function isSoulAccessible(soulId) {
  return getWalletStateHelper().isSoulAccessible({
    walletAddress,
    soulId,
    entitlementCacheByWallet,
    createdSoulCacheByWallet
  });
}

function collectStoredProofs(wallet) {
  return getWalletStateHelper().collectStoredProofs({
    wallet,
    storageHelper: getStorageHelper(),
    receiptPrefix: RECEIPT_PREFIX
  });
}

async function toolCall(name, args = {}) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), CONFIG.requestTimeout);
  try {
    const response = await fetch('/api/ui/tool', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        name: String(name || '').trim(),
        arguments: args && typeof args === 'object' ? args : {}
      }),
      signal: controller.signal
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
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error('UI tool request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function refreshEntitlementsForWallet(wallet) {
  await getWalletStateHelper().refreshEntitlementsForWallet({
    wallet,
    toolCall,
    storageHelper: getStorageHelper(),
    receiptPrefix: RECEIPT_PREFIX,
    entitlementCacheByWallet,
    onStateChanged: () => {
      renderOwnedSouls();
      updateSoulPagePurchaseState();
    }
  });
}

async function refreshCreatedSoulsForWallet(wallet) {
  await getWalletStateHelper().refreshCreatedSoulsForWallet({
    wallet,
    toolCall,
    createdSoulCacheByWallet,
    onStateChanged: () => {
      renderOwnedSouls();
      updateSoulPagePurchaseState();
    }
  });
}

function updateSoulPagePurchaseState() {
  getCatalogUiHelper().updateSoulPagePurchaseState({
    soulDetailUiHelper: getSoulDetailUiHelper(),
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

function soulListingHref(soulId) {
  return getSoulDetailUiHelper().soulListingHref(soulId);
}

function updateSoulDetailMetadata(soul) {
  const nextSoulDetailId = getCatalogUiHelper().updateSoulDetailMetadata({
    soul,
    soulDetailUiHelper: getSoulDetailUiHelper(),
    escapeHtml,
    getSoulGlyph,
    shortenAddress,
    formatCreatorLabelFn: formatCreatorLabel,
    buyButtonId: 'buyBtn'
  });
  if (nextSoulDetailId) currentSoulDetailId = nextSoulDetailId;
}

async function hydrateSoulDetailPage() {
  const result = await getCatalogUiHelper().hydrateSoulDetailPage({
    soulDetailUiHelper: getSoulDetailUiHelper(),
    toolCall,
    currentSoulDetailId,
    soulCatalogCache,
    setSoulCatalogCache: (next) => {
      soulCatalogCache = next;
    },
    updateSoulDetailMetadata,
    updateSoulPagePurchaseState,
    showToast,
    pageRootId: 'soulDetailPage',
    buyButtonId: 'buyBtn'
  });
  if (result?.currentSoulDetailId) {
    currentSoulDetailId = result.currentSoulDetailId;
  }
}

function renderOwnedSouls() {
  getCatalogUiHelper().renderOwnedSouls({
    walletAddress,
    soulCatalogCache,
    ownedSoulSetForCurrentWallet,
    createdSoulSetForCurrentWallet,
    soulCardsHelper: getSoulCardsHelper(),
    listingHrefBuilder: soulListingHref,
    containerId: 'ownedSoulsGrid'
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
  const flow = String(action || '').trim() === 'session' ? 'session' : 'redownload';
  const challengeArgs = {
    flow,
    wallet_address: wallet
  };
  if (flow === 'redownload') {
    challengeArgs.asset_id = String(soulId || '').trim();
  }
  const challenge = await toolCall('get_auth_challenge', challengeArgs);
  const message = String(challenge?.auth_message_template || '').trim();
  const issuedAt = String(challenge?.issued_at || '').trim();
  const challengeTimestamp = Number(challenge?.auth_timestamp_ms);
  const authTimestamp = Number.isFinite(challengeTimestamp) ? challengeTimestamp : Date.parse(issuedAt);
  if (!message || !Number.isFinite(authTimestamp)) {
    throw new Error('Failed to build wallet authentication challenge');
  }
  return {
    message,
    timestamp: authTimestamp
  };
}

function normalizeAddress(address) {
  return getSellerGuardHelper().normalizeAddress(address);
}

async function getExpectedSellerAddressForSoul(soulId) {
  return getSellerGuardHelper().resolveExpectedSellerAddress({
    soulId,
    cache: sellerAddressCache,
    fetchSoulDetails: async (id) => toolCall('get_asset_details', { id })
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
    defaultExpectedSeller: null,
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
    defaultExpectedSeller: null,
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
      const summary = Array.isArray(soulCatalogCache)
        ? soulCatalogCache.find((item) => String(item?.id || '') === String(successSoulId))
        : null;
      const fileName = String(summary?.delivery?.file_name || summary?.file_name || 'ASSET.md').trim() || 'ASSET.md';
      showPaymentSuccess(content, tx, successSoulId, true, null, fileName);
    }
  });
}

async function purchaseSoul(soulId, fileName = null) {
  return getPurchaseFlowController().purchaseSoul(soulId, fileName);
}

async function downloadOwnedSoul(soulId, fileName = null) {
  return getPurchaseFlowController().downloadOwnedSoul(soulId, fileName);
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

function triggerMarkdownDownload(content, soulId, fileName = 'ASSET.md') {
  getDownloadDeliveryHelper().triggerMarkdownDownload(content, soulId, fileName);
}

function isLikelyMobileBrowser() {
  return getDownloadDeliveryHelper().isLikelyMobileBrowser();
}

function showPaymentSuccess(content, txRef, soulId, redownload, expectedSettlement = null, fileName = null) {
  return getPurchaseFlowController().showPaymentSuccess(content, txRef, soulId, redownload, expectedSettlement, fileName);
}

function escapeHtml(text) {
  return getSoulCardsHelper().escapeHtml(text);
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

function bindAssetTypeFilters() {
  const register = () => {
    const root = document.getElementById('assetTypeFilters');
    if (!root) return;
    const buttons = [...root.querySelectorAll('.filter-pill[data-asset-type]')];
    if (!buttons.length) return;
    const applyState = () => {
      buttons.forEach((button) => {
        const value = String(button.getAttribute('data-asset-type') || '').toLowerCase();
        button.classList.toggle('active', value === currentAssetTypeFilter);
      });
    };
    buttons.forEach((button) => {
      button.addEventListener('click', async () => {
        const next = String(button.getAttribute('data-asset-type') || 'all').toLowerCase();
        if (!next || next === currentAssetTypeFilter) return;
        currentAssetTypeFilter = next;
        applyState();
        await loadSouls();
      });
    });
    applyState();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', register, { once: true });
  } else {
    register();
  }
}

function bindAssetSearchFilter() {
  const input = document.getElementById('assetSearchInput');
  if (!(input instanceof HTMLInputElement)) return;
  let debounceTimer = null;
  const apply = () => {
    currentSearchQuery = String(input.value || '').trim();
    const grid = document.getElementById('soulsGrid');
    if (!grid) return;
    const visible = getCatalogUiHelper().renderCatalogGrid({
      grid,
      souls: soulCatalogCache,
      searchQuery: currentSearchQuery,
      soulCardsHelper: getSoulCardsHelper(),
      isSoulAccessible,
      listingHrefBuilder: soulListingHref,
      lineageLabelForSoul: (soul) => formatCreatorLabel(
        soul?.provenance?.raised_by ||
        soul?.creator_address ||
        soul?.wallet_address ||
        soul?.seller_address ||
        ''
      )
    });
    renderInventorySummary(visible);
  };

  input.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(apply, 120);
  });
}

async function loadSouls() {
  await getCatalogUiHelper().loadSouls({
    fetchWithTimeout,
    soulCardsHelper: getSoulCardsHelper(),
    soulCatalogCache,
    setSoulCatalogCache: (next) => {
      soulCatalogCache = next;
    },
    renderInventorySummary,
    renderOwnedSouls,
    isSoulAccessible,
    listingHrefBuilder: soulListingHref,
    lineageLabelForSoul: (soul) => formatCreatorLabel(
      soul?.provenance?.raised_by ||
      soul?.creator_address ||
      soul?.wallet_address ||
      soul?.seller_address ||
      ''
    ),
    soulsGridId: 'soulsGrid',
    assetType: currentAssetTypeFilter,
    searchQuery: currentSearchQuery
  });
}

async function loadModeratorAllowlist() {
  moderatorAllowlist = await getWalletStateHelper().loadModeratorAllowlist({
    toolCall,
    onAllowlistLoaded: (allowlist) => {
      moderatorAllowlist = allowlist;
      updateModeratorNavLinkVisibility();
    }
  });
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
bindAssetTypeFilters();
bindAssetSearchFilter();

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
  getPurchaseFlowController().revokeActiveSuccessDownloadUrl();
});
window.showToast = showToast;
