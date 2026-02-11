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

let provider = null;
let signer = null;
let walletAddress = null;
let walletConnectProjectId = null;

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
  provider = null;
  signer = null;
  walletAddress = null;
  updateWalletUI();
  showToast('Wallet disconnected', 'info');
}

async function connectWithProvider(rawProvider) {
  if (!rawProvider) {
    showToast('Wallet provider not found', 'error');
    return;
  }

  closeWalletModal();

  try {
    provider = new ethers.providers.Web3Provider(rawProvider, 'any');
    await provider.send('eth_requestAccounts', []);
    signer = provider.getSigner();
    walletAddress = (await signer.getAddress()).toLowerCase();
    await ensureBaseNetwork();
    updateWalletUI();
    showToast('Wallet connected', 'success');
  } catch (error) {
    console.error('Wallet connection failed:', error);
    showToast(`Connection failed: ${error.message || 'Unknown error'}`, 'error');
  }
}

async function connectMetaMask() {
  if (!window.ethereum) {
    showToast('MetaMask not found. Install MetaMask first.', 'error');
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
    showToast('Coinbase Wallet extension not found', 'error');
    return;
  }

  if (Array.isArray(window.ethereum.providers)) {
    const cb = window.ethereum.providers.find((p) => p.isCoinbaseWallet);
    if (cb) return connectWithProvider(cb);
  }

  if (window.ethereum.isCoinbaseWallet) {
    return connectWithProvider(window.ethereum);
  }

  showToast('Coinbase provider not detected. Use Browser Wallet instead.', 'warning');
}

async function connectInjected() {
  if (!window.ethereum) {
    showToast('No injected wallet found', 'error');
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

  try {
    const wcProvider = await window.EthereumProvider.init({
      projectId: walletConnectProjectId,
      chains: [CONFIG.baseChainIdDec],
      optionalChains: [1, 8453],
      showQrModal: true
    });
    await wcProvider.enable();
    await connectWithProvider(wcProvider);
  } catch (error) {
    console.error('WalletConnect failed:', error);
    showToast(`WalletConnect failed: ${error.message || 'Unknown error'}`, 'error');
  }
}

async function ensureBaseNetwork() {
  if (!provider) return;
  const network = await provider.getNetwork();
  if (network.chainId === CONFIG.baseChainIdDec) return;

  const raw = provider.provider;
  try {
    await raw.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CONFIG.baseChainIdHex }] });
  } catch (error) {
    if (error.code === 4902) {
      await raw.request({ method: 'wallet_addEthereumChain', params: [CONFIG.baseChainParams] });
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

function buildAuthMessage({ wallet, soulId, action, timestamp }) {
  return [
    'SoulStarter Wallet Authentication',
    `address:${wallet.toLowerCase()}`,
    `soul:${soulId}`,
    `action:${action}`,
    `timestamp:${timestamp}`
  ].join('\n');
}

async function signRedownloadAuth(soulId) {
  const timestamp = Date.now();
  const message = buildAuthMessage({
    wallet: walletAddress,
    soulId,
    action: 'redownload',
    timestamp
  });
  const signature = await signer.signMessage(message);
  return { timestamp, signature };
}

async function buildX402PaymentSignature(paymentRequired) {
  if (!paymentRequired || paymentRequired.x402Version !== 2) {
    throw new Error('Unsupported x402 version');
  }

  const accepted = Array.isArray(paymentRequired.accepts) ? paymentRequired.accepts[0] : null;
  if (!accepted) {
    throw new Error('No payment requirements available');
  }

  if (!accepted.extra?.name || !accepted.extra?.version) {
    throw new Error('Missing EIP-712 domain parameters in payment requirements');
  }

  const chainId = Number(String(accepted.network).split(':')[1]);
  if (!Number.isFinite(chainId)) {
    throw new Error('Invalid payment network');
  }

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: walletAddress,
    to: accepted.payTo,
    value: accepted.amount,
    validAfter: String(now - 600),
    validBefore: String(now + (accepted.maxTimeoutSeconds || 300)),
    nonce: ethers.utils.hexlify(ethers.utils.randomBytes(32))
  };

  const domain = {
    name: accepted.extra.name,
    version: accepted.extra.version,
    chainId,
    verifyingContract: accepted.asset
  };

  const signature = await signer._signTypedData(domain, TRANSFER_WITH_AUTHORIZATION_TYPE, authorization);

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

  const auth = await signRedownloadAuth(soulId);
  const receipt = getStoredReceipt(soulId, walletAddress);
  if (!receipt) return { ok: false, requiresPayment: true };

  const response = await fetchWithTimeout(`${CONFIG.apiBase}/souls/${encodeURIComponent(soulId)}/download`, {
    method: 'GET',
    headers: {
      'X-WALLET-ADDRESS': walletAddress,
      'X-AUTH-SIGNATURE': auth.signature,
      'X-AUTH-TIMESTAMP': String(auth.timestamp),
      'X-PURCHASE-RECEIPT': receipt,
      Accept: 'text/markdown'
    }
  });

  if (response.ok) {
    const content = await response.text();
    const tx = readSettlementTx(response);
    const refreshedReceipt = response.headers.get('X-PURCHASE-RECEIPT');
    if (refreshedReceipt) storeReceipt(soulId, walletAddress, refreshedReceipt);
    showPaymentSuccess(content, tx, soulId, true);
    return { ok: true };
  }

  if (response.status === 402 || response.status === 401) {
    return { ok: false, requiresPayment: true };
  }

  const error = await readError(response);
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
    const paymentPayload = await buildX402PaymentSignature(paymentRequired);

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

    const content = await paid.text();
    const tx = readSettlementTx(paid);
    const receipt = paid.headers.get('X-PURCHASE-RECEIPT');
    if (receipt) storeReceipt(soulId, walletAddress, receipt);

    showPaymentSuccess(content, tx, soulId, false);
    showToast('Soul acquired successfully!', 'success');
  } catch (error) {
    console.error('Purchase failed:', error);
    showToast(`Purchase failed: ${error.message || 'Unknown error'}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Buy Soul';
    }
  }
}

function readSettlementTx(response) {
  const header = response.headers.get('PAYMENT-RESPONSE');
  if (!header) return null;
  try {
    const payload = JSON.parse(atob(header));
    return payload.transaction || null;
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

function storeReceipt(soulId, wallet, receipt) {
  try {
    localStorage.setItem(receiptStorageKey(wallet, soulId), receipt);
  } catch (_) {}
}

function getStoredReceipt(soulId, wallet) {
  try {
    return localStorage.getItem(receiptStorageKey(wallet, soulId));
  } catch (_) {
    return null;
  }
}

function showPaymentSuccess(content, txHash, soulId, redownload) {
  const purchaseCard = document.getElementById('purchaseCard');
  if (purchaseCard) purchaseCard.style.display = 'none';

  const successCard = document.getElementById('successCard');
  if (!successCard) return;
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

  const downloadLink = document.getElementById('downloadLink');
  if (downloadLink) {
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    downloadLink.href = url;
    downloadLink.download = `${soulId}-SOUL.md`;
    setTimeout(() => downloadLink.click(), 300);
  }

  const txHashEl = document.getElementById('txHash');
  if (txHashEl) {
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

async function loadSouls() {
  const grid = document.getElementById('soulsGrid');
  if (!grid) return;

  try {
    const response = await fetchWithTimeout('/api/mcp/tools/list_souls');
    if (!response.ok) throw new Error('Failed to load soul catalog');
    const payload = await response.json();
    const souls = payload.souls || [];

    grid.innerHTML = souls
      .map(
        (soul) => `
      <article class="soul-card ${soul.id === 'sassy-starter-v1' ? 'soul-card-featured' : ''}" data-soul-id="${escapeHtml(soul.id)}">
        <div class="soul-card-icon">${escapeHtml(soul.icon || '🔮')}</div>
        <h3>${escapeHtml(soul.name)}</h3>
        <p>${escapeHtml(soul.description)}</p>
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
        <button class="btn btn-primary btn-full" onclick="purchaseSoul('${escapeHtml(soul.id)}')">Buy Soul</button>
      </article>
    `
      )
      .join('');
  } catch (error) {
    console.error('Catalog load failed:', error);
    grid.innerHTML = '<p>Catalog is temporarily unavailable.</p>';
  }
}

async function loadWalletConfig() {
  try {
    const response = await fetch('/api/wallet-config');
    if (!response.ok) return;
    const config = await response.json();
    walletConnectProjectId = config.walletConnectProjectId || null;
  } catch (_) {
    walletConnectProjectId = null;
  }
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

document.addEventListener('DOMContentLoaded', async () => {
  await loadWalletConfig();
  updateWalletUI();
  loadSouls();
});

window.openWalletModal = openWalletModal;
window.closeWalletModal = closeWalletModal;
window.connectWallet = connectWallet;
window.connectMetaMask = connectMetaMask;
window.connectWalletConnect = connectWalletConnect;
window.connectCoinbase = connectCoinbase;
window.connectInjected = connectInjected;
window.disconnectWallet = disconnectWallet;
window.purchaseSoul = purchaseSoul;
window.showToast = showToast;
