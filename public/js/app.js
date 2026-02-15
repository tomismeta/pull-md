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

const TRANSFER_WITH_AUTHORIZATION_TYPE = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' }
  ]
};

const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const X402_EXACT_PERMIT2_PROXY = '0x4020615294c913F045dc10f0a5cdEbd86c280001';
const MAX_UINT256_DEC = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
const EXPECTED_SELLER_ADDRESS = '0x7F46aCB709cd8DF5879F84915CA431fB740989E4';
const WALLET_SESSION_KEY = 'soulstarter_wallet_session_v1';
const RECEIPT_PREFIX = 'soulstarter.receipt.';
const REDOWNLOAD_SESSION_PREFIX = 'soulstarter.redownload.session.';
const sellerAddressCache = new Map();
const entitlementCacheByWallet = new Map();
const createdSoulCacheByWallet = new Map();
let moderatorAllowlist = new Set();
let soulCatalogCache = [];

const PERMIT2_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'Witness' }
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' }
  ],
  Witness: [
    { name: 'to', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'extra', type: 'bytes' }
  ]
};

let provider = null;
let signer = null;
let walletAddress = null;
let walletType = null;
const providerMetadata = new WeakMap();
let providerDiscoveryInitialized = false;
let activeSuccessDownloadUrl = null;

function initProviderDiscovery() {
  if (providerDiscoveryInitialized || typeof window === 'undefined') return;
  providerDiscoveryInitialized = true;
  window.addEventListener('eip6963:announceProvider', (event) => {
    const detail = event?.detail;
    if (!detail || typeof detail !== 'object') return;
    const announcedProvider = detail.provider;
    if (!announcedProvider || typeof announcedProvider !== 'object') return;
    providerMetadata.set(announcedProvider, {
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
  if (window?.ethereum && typeof window.ethereum === 'object') return window.ethereum;
  return null;
}

function openWalletModal() {
  const modal = document.getElementById('walletModal');
  if (modal) modal.style.display = 'flex';
}

function closeWalletModal() {
  const modal = document.getElementById('walletModal');
  if (modal) modal.style.display = 'none';
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
  if (!walletAddress || !walletType) return;
  try {
    localStorage.setItem(
      WALLET_SESSION_KEY,
      JSON.stringify({
        wallet: walletAddress,
        walletType
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
    const type = String(parsed?.walletType || '').toLowerCase();
    if (!wallet || !type) return null;
    return { wallet, walletType: type };
  } catch (_) {
    return null;
  }
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
  if (!provider) return;
  const network = await provider.getNetwork();
  if (Number(network.chainId) === CONFIG.baseChainIdDec) return;

  try {
    await provider.send('wallet_switchEthereumChain', [{ chainId: CONFIG.baseChainIdHex }]);
  } catch (error) {
    if (error.code === 4902) {
      await provider.send('wallet_addEthereumChain', [CONFIG.baseChainParams]);
      return;
    }
    throw error;
  }
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

async function refreshEntitlementsForWallet(wallet) {
  if (!wallet) return;
  const proofs = collectStoredProofs(wallet);
  if (proofs.length === 0) {
    entitlementCacheByWallet.set(wallet.toLowerCase(), new Set());
    return;
  }
  try {
    const response = await fetchWithTimeout(`${CONFIG.apiBase}/mcp/tools/check_entitlements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet_address: wallet.toLowerCase(),
        proofs
      })
    });
    if (!response.ok) throw new Error('entitlement check failed');
    const payload = await response.json();
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
    const response = await fetchWithTimeout(
      `${CONFIG.apiBase}/mcp/tools/creator_marketplace?action=list_published_listings`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' }
      }
    );
    if (!response.ok) throw new Error('published listing lookup failed');
    const payload = await response.json();
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
  const onclick = String(btn.getAttribute('onclick') || '');
  const match = onclick.match(/purchaseSoul\(['"]([^'"]+)['"]\)/);
  const soulId = match?.[1];
  if (!soulId) return;
  const owned = isSoulAccessible(soulId);
  btn.textContent = owned ? 'Download Soul' : 'Purchase Soul';
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
    const isOwned = owned.has(soulId);
    const isCreated = created.has(soulId);
    const sourceLabel = isOwned && isCreated ? 'Purchased and created' : isCreated ? 'Creator access' : 'Wallet entitlement';
    return `
      <article class="soul-card" data-owned-soul-id="${escapeHtml(soul.id)}">
        <div class="soul-card-glyph">${escapeHtml(getSoulGlyph(soul))}</div>
        <h3>${escapeHtml(soul.name || soul.id)}</h3>
        <p>${escapeHtml(soul.description || 'Soul access available')}</p>
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
          <div>
            <span class="price">${escapeHtml(isOwned ? 'Accessible' : 'Creator Access')}</span>
          </div>
        </div>
        <button class="btn btn-primary btn-full" onclick="downloadOwnedSoul('${escapeHtml(soul.id)}')">Download Soul File</button>
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

function buildAuthMessage({ wallet, soulId, action, timestamp }) {
  return [
    'SoulStarter Wallet Authentication',
    `address:${wallet.toLowerCase()}`,
    `soul:${soulId}`,
    `action:${action}`,
    `timestamp:${timestamp}`
  ].join('\n');
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
    const response = await fetchWithTimeout(`${CONFIG.apiBase}/mcp/tools/get_soul_details?id=${encodeURIComponent(soulId)}`);
    if (!response.ok) throw new Error('details lookup failed');
    const payload = await response.json();
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
  const message = buildAuthMessage({
    wallet: walletAddress,
    soulId: '*',
    action: 'session',
    timestamp
  });
  const signature = await signer.signMessage(message);
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

async function buildX402PaymentSignature(paymentRequired, soulId) {
  if (!paymentRequired || paymentRequired.x402Version !== 2) {
    throw new Error('Unsupported x402 version');
  }

  const accepted = Array.isArray(paymentRequired.accepts) ? paymentRequired.accepts[0] : null;
  if (!accepted) {
    throw new Error('No payment requirements available');
  }
  const expectedSeller = await getExpectedSellerAddressForSoul(soulId);
  assertExpectedSellerAddress(accepted.payTo, expectedSeller);

  if (!accepted.extra?.name || !accepted.extra?.version) {
    throw new Error('Missing EIP-712 domain parameters in payment requirements');
  }

  const chainId = Number(String(accepted.network).split(':')[1]);
  if (!Number.isFinite(chainId)) {
    throw new Error('Invalid payment network');
  }

  const transferMethod = String(accepted.extra?.assetTransferMethod || 'eip3009').toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  if (transferMethod === 'permit2') {
    const permitNonceHex = ethers.hexlify(ethers.randomBytes(32));
    const permit2Authorization = {
      from: walletAddress,
      permitted: {
        token: accepted.asset,
        amount: accepted.amount
      },
      spender: X402_EXACT_PERMIT2_PROXY,
      nonce: BigInt(permitNonceHex).toString(),
      deadline: String(now + (accepted.maxTimeoutSeconds || 300)),
      witness: {
        to: accepted.payTo,
        validAfter: String(now - 600),
        extra: '0x'
      }
    };

    const permitDomain = {
      name: 'Permit2',
      chainId,
      verifyingContract: PERMIT2_ADDRESS
    };
    const permitSignature = await signer.signTypedData(permitDomain, PERMIT2_WITNESS_TYPES, permit2Authorization);
    const approveData = new ethers.Interface(['function approve(address spender, uint256 amount)']).encodeFunctionData(
      'approve',
      [PERMIT2_ADDRESS, MAX_UINT256_DEC]
    );

    return {
      x402Version: paymentRequired.x402Version,
      scheme: accepted.scheme,
      network: accepted.network,
      payload: {
        permit2Authorization,
        signature: permitSignature,
        transaction: {
          to: accepted.asset,
          data: approveData
        }
      },
      accepted,
      resource: paymentRequired.resource,
      extensions: paymentRequired.extensions
    };
  }

  const authorization = {
    from: walletAddress,
    to: accepted.payTo,
    value: accepted.amount,
    validAfter: String(now - 600),
    validBefore: String(now + (accepted.maxTimeoutSeconds || 300)),
    nonce: ethers.hexlify(ethers.randomBytes(32))
  };
  const domain = {
    name: accepted.extra.name,
    version: accepted.extra.version,
    chainId,
    verifyingContract: accepted.asset
  };
  const signature = await signer.signTypedData(domain, TRANSFER_WITH_AUTHORIZATION_TYPE, authorization);
  return {
    x402Version: paymentRequired.x402Version,
    scheme: accepted.scheme,
    network: accepted.network,
    payload: {
      authorization,
      signature
    },
    accepted,
    resource: paymentRequired.resource,
    extensions: paymentRequired.extensions
  };
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
    const initial = await fetchWithTimeout(`${CONFIG.apiBase}/souls/${encodeURIComponent(soulId)}/download`, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });

    if (initial.status !== 402) {
      throw new Error('Expected 402 payment required');
    }

    const paymentRequiredHeader = initial.headers.get('PAYMENT-REQUIRED');
    if (!paymentRequiredHeader) {
      throw new Error('Missing PAYMENT-REQUIRED header');
    }

    const paymentRequired = JSON.parse(atob(paymentRequiredHeader));
    if (btn) btn.textContent = 'Signing x402 payment...';
    const paymentPayload = await buildX402PaymentSignature(paymentRequired, soulId);

    if (btn) btn.textContent = 'Submitting payment...';
    const paid = await fetchWithTimeout(`${CONFIG.apiBase}/souls/${encodeURIComponent(soulId)}/download`, {
      method: 'GET',
      headers: {
        'PAYMENT-SIGNATURE': btoa(JSON.stringify(paymentPayload)),
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

    showPaymentSuccess(content, tx, soulId, false);
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

function revokeActiveSuccessDownloadUrl() {
  if (!activeSuccessDownloadUrl) return;
  try {
    URL.revokeObjectURL(activeSuccessDownloadUrl);
  } catch (_) {}
  activeSuccessDownloadUrl = null;
}

function showPaymentSuccess(content, txHash, soulId, redownload) {
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
}

function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
    const response = await fetchWithTimeout('/api/mcp/tools/list_souls');
    if (!response.ok) throw new Error('Failed to load soul catalog');
    const payload = await response.json();
    const souls = payload.souls || [];
    soulCatalogCache = souls;

    grid.innerHTML = souls
      .map(
        (soul) => {
          const owned = isSoulAccessible(soul.id);
          const cta = owned ? 'Download Soul' : 'Purchase Soul';
          return `
      <article class="soul-card ${soul.id === 'sassy-starter-v1' ? 'soul-card-featured' : ''}" data-soul-id="${escapeHtml(soul.id)}">
        <div class="soul-card-glyph">${escapeHtml(getSoulGlyph(soul))}</div>
        <h3>${escapeHtml(soul.name)}</h3>
        <p>${escapeHtml(soul.description)}</p>
        ${
          soul.source_url
            ? `<a class="soul-source-link" href="${escapeHtml(soul.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
                soul.source_label || 'Source'
              )}</a>`
            : ''
        }
        <div class="soul-card-meta">
          <div class="soul-lineage">
            <span class="badge badge-${escapeHtml((soul.provenance?.type || 'hybrid').toLowerCase())}">${escapeHtml(soul.provenance?.type || 'Hybrid')}</span>
            <span style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(soul.provenance?.raised_by || 'Unknown lineage')}</span>
          </div>
          <div>
            <span class="price">${escapeHtml(soul.price?.display || '$0.00 USDC')}</span>
            <span class="currency">USDC</span>
          </div>
        </div>
        <button class="btn btn-primary btn-full" onclick="${owned ? `downloadOwnedSoul('${escapeHtml(soul.id)}')` : `purchaseSoul('${escapeHtml(soul.id)}')`}">${escapeHtml(cta)}</button>
      </article>
    `;
        }
      )
      .join('');
    renderOwnedSouls();
  } catch (error) {
    console.error('Catalog load failed:', error);
    grid.innerHTML = '<p>Catalog is temporarily unavailable.</p>';
    renderOwnedSouls();
  }
}

async function loadModeratorAllowlist() {
  try {
    const response = await fetchWithTimeout(`${CONFIG.apiBase}/mcp/tools/creator_marketplace?action=list_moderators`, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
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

document.addEventListener('DOMContentLoaded', async () => {
  initProviderDiscovery();
  initMobileNav();
  await loadModeratorAllowlist();
  bindWalletOptionHandlers();
  updateWalletUI();
  await restoreWalletSession();
  await refreshEntitlementsForWallet(walletAddress);
  await refreshCreatedSoulsForWallet(walletAddress);
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
