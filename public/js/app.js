/**
 * SoulStarter - Proper x402 Payment Implementation
 * Uses EIP-712 typed data signing with EIP-3009 authorization
 */

// Configuration
const CONFIG = {
  network: 'eip155:8453',
  chainId: 8453,
  usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  apiBase: '/api',
  requestTimeout: 30000
};

// USDC EIP-712 Domain (Base network)
const USDC_DOMAIN = {
  name: 'USDC',
  version: '2',
  chainId: 8453,
  verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
};

// EIP-712 Types for EIP-3009 TransferWithAuthorization
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

// State
let provider = null;
let signer = null;
let walletAddress = null;
let walletType = null;

// WalletConnect Project ID (get from cloud.walletconnect.com)
const WC_PROJECT_ID = 'YOUR_WC_PROJECT_ID';

/**
 * Wallet Connection Functions
 */

function openWalletModal() {
  document.getElementById('walletModal').style.display = 'flex';
}

function closeWalletModal() {
  document.getElementById('walletModal').style.display = 'none';
}

async function connectMetaMask() {
  closeWalletModal();
  
  if (!window.ethereum) {
    showToast('MetaMask not found. Please install it.', 'error');
    window.open('https://metamask.io/download/', '_blank');
    return;
  }
  
  try {
    walletType = 'metamask';
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    
    if (accounts.length === 0) throw new Error('No accounts found');
    
    walletAddress = accounts[0];
    provider = new ethers.providers.Web3Provider(window.ethereum);
    signer = provider.getSigner();
    
    await ensureCorrectNetwork();
    setupMetaMaskListeners();
    updateWalletUI();
    showToast('Connected to MetaMask!', 'success');
    
  } catch (error) {
    console.error('MetaMask connection failed:', error);
    showToast('Connection failed: ' + error.message, 'error');
    resetWalletState();
  }
}

async function connectWalletConnect() {
  closeWalletModal();
  
  if (WC_PROJECT_ID === 'YOUR_WC_PROJECT_ID') {
    showToast('WalletConnect not configured', 'error');
    return;
  }
  
  try {
    walletType = 'walletconnect';
    
    const ethereumProvider = await window.EthereumProvider.init({
      projectId: WC_PROJECT_ID,
      chains: [CONFIG.chainId],
      showQrModal: true,
      methods: ['eth_sendTransaction', 'eth_signTypedData_v4'],
      metadata: {
        name: 'SoulStarter',
        description: 'Human-nurtured agent memory marketplace',
        url: window.location.origin
      }
    });
    
    await ethereumProvider.enable();
    
    provider = new ethers.providers.Web3Provider(ethereumProvider);
    signer = provider.getSigner();
    walletAddress = await signer.getAddress();
    
    ethereumProvider.on('accountsChanged', (accounts) => {
      if (accounts.length === 0) resetWalletState();
      else { walletAddress = accounts[0]; updateWalletUI(); }
    });
    
    ethereumProvider.on('disconnect', () => {
      resetWalletState();
      showToast('Wallet disconnected', 'info');
    });
    
    updateWalletUI();
    showToast('Wallet connected!', 'success');
    
  } catch (error) {
    console.error('WalletConnect failed:', error);
    showToast('Connection failed: ' + error.message, 'error');
    resetWalletState();
  }
}

async function connectCoinbase() {
  closeWalletModal();
  
  const coinbaseWallet = window.ethereum?.providers?.find(p => p.isCoinbaseWallet) ||
                         (window.ethereum?.isCoinbaseWallet ? window.ethereum : null);
  
  if (!coinbaseWallet && !window.ethereum) {
    showToast('Coinbase Wallet not found', 'info');
    window.open('https://www.coinbase.com/wallet', '_blank');
    return;
  }
  
  try {
    walletType = 'coinbase';
    const providerToUse = coinbaseWallet || window.ethereum;
    
    const accounts = await providerToUse.request({ method: 'eth_requestAccounts' });
    if (accounts.length === 0) throw new Error('No accounts found');
    
    walletAddress = accounts[0];
    provider = new ethers.providers.Web3Provider(providerToUse);
    signer = provider.getSigner();
    
    await ensureCorrectNetwork();
    setupMetaMaskListeners(providerToUse);
    updateWalletUI();
    showToast('Connected to Coinbase Wallet!', 'success');
    
  } catch (error) {
    console.error('Coinbase connection failed:', error);
    showToast('Connection failed: ' + error.message, 'error');
    resetWalletState();
  }
}

async function connectInjected() {
  closeWalletModal();
  
  if (!window.ethereum) {
    showToast('No wallet found', 'error');
    return;
  }
  
  try {
    walletType = 'injected';
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (accounts.length === 0) throw new Error('No accounts found');
    
    walletAddress = accounts[0];
    provider = new ethers.providers.Web3Provider(window.ethereum);
    signer = provider.getSigner();
    
    await ensureCorrectNetwork();
    setupMetaMaskListeners();
    updateWalletUI();
    showToast('Wallet connected!', 'success');
    
  } catch (error) {
    console.error('Wallet connection failed:', error);
    showToast('Connection failed: ' + error.message, 'error');
    resetWalletState();
  }
}

async function ensureCorrectNetwork() {
  const chainId = await window.ethereum.request({ method: 'eth_chainId' });
  
  if (parseInt(chainId) !== CONFIG.chainId) {
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x2105' }]
      });
    } catch (switchError) {
      if (switchError.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: '0x2105',
            chainName: 'Base',
            nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://mainnet.base.org'],
            blockExplorerUrls: ['https://basescan.org']
          }]
        });
      } else {
        throw switchError;
      }
    }
  }
}

function setupMetaMaskListeners(ethereumProvider = window.ethereum) {
  if (!ethereumProvider) return;
  
  ethereumProvider.on('accountsChanged', (accounts) => {
    if (accounts.length === 0) {
      resetWalletState();
      showToast('Wallet disconnected', 'info');
    } else {
      walletAddress = accounts[0];
      updateWalletUI();
    }
  });
  
  ethereumProvider.on('chainChanged', () => window.location.reload());
}

function resetWalletState() {
  provider = null;
  signer = null;
  walletAddress = null;
  walletType = null;
  updateWalletUI();
}

function disconnectWallet() {
  resetWalletState();
  showToast('Wallet disconnected', 'info');
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

/**
 * PROPER x402 Payment Implementation
 */

async function purchaseSoul(soulId) {
  if (!walletAddress || !signer) {
    showToast('Please connect your wallet first', 'warning');
    openWalletModal();
    return;
  }

  const btn = document.getElementById('buyBtn');
  
  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Processing...';
    }

    // Step 1: Get 402 response with requirements
    showToast('Requesting payment details...', 'info');
    const response = await fetchWithTimeout(
      `${CONFIG.apiBase}/souls/${encodeURIComponent(soulId)}/download`
    );

    if (response.status !== 402) {
      throw new Error('Expected 402 Payment Required');
    }

    const paymentRequiredB64 = response.headers.get('PAYMENT-REQUIRED');
    if (!paymentRequiredB64) {
      throw new Error('No payment requirements received');
    }

    const requirements = JSON.parse(atob(paymentRequiredB64));
    
    // Step 2: Create proper x402 EIP-3009 authorization
    showToast('Signing payment authorization...', 'info');
    const x402Payload = await createX402Payment(requirements);
    
    // Step 3: Submit signed payment
    showToast('Verifying payment...', 'info');
    const paymentResponse = await fetchWithTimeout(
      `${CONFIG.apiBase}/souls/${encodeURIComponent(soulId)}/download`,
      {
        method: 'GET',
        headers: {
          'PAYMENT-SIGNATURE': btoa(JSON.stringify(x402Payload)),
          'Accept': 'text/markdown'
        }
      }
    );

    if (!paymentResponse.ok) {
      const error = await paymentResponse.json().catch(() => ({}));
      throw new Error(error.message || 'Payment failed');
    }

    const soulContent = await paymentResponse.text();
    
    // Get transaction hash from response
    let txHash = 'pending';
    const paymentResponseB64 = paymentResponse.headers.get('PAYMENT-RESPONSE');
    if (paymentResponseB64) {
      try {
        const result = JSON.parse(atob(paymentResponseB64));
        txHash = result.txHash || 'pending';
      } catch (e) {}
    }

    showPaymentSuccess(soulContent, txHash, soulId);
    showToast('Soul acquired successfully!', 'success');

  } catch (error) {
    console.error('Purchase failed:', error);
    showToast('Purchase failed: ' + error.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Buy Soul';
    }
  }
}

/**
 * Create proper x402 payment with EIP-712 typed data signature
 */
async function createX402Payment(requirements) {
  // Generate proper bytes32 nonce
  const nonce = ethers.utils.hexlify(ethers.utils.randomBytes(32));
  
  // Set validity window (5 minutes)
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 60; // 1 minute ago (allows immediate use)
  const validBefore = now + 300; // 5 minutes from now
  
  // Create EIP-3009 authorization struct
  const authorization = {
    from: walletAddress,
    to: requirements.payload.to,
    value: requirements.payload.amount,
    validAfter: validAfter,
    validBefore: validBefore,
    nonce: nonce
  };
  
  // Sign with EIP-712 typed data
  const signature = await signer._signTypedData(
    USDC_DOMAIN,
    TRANSFER_WITH_AUTHORIZATION_TYPE,
    authorization
  );
  
  // Return proper x402 payload structure
  return {
    x402Version: 1,
    scheme: 'exact',
    network: requirements.network,
    payload: {
      signature: signature,
      authorization: authorization
    }
  };
}

/**
 * UI and Utility Functions
 */

function showPaymentSuccess(content, txHash, soulId) {
  const purchaseCard = document.getElementById('purchaseCard');
  if (purchaseCard) purchaseCard.style.display = 'none';

  const successCard = document.getElementById('successCard');
  if (successCard) {
    successCard.style.display = 'block';
    
    const downloadLink = document.getElementById('downloadLink');
    if (downloadLink) {
      const blob = new Blob([content], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      downloadLink.href = url;
      downloadLink.download = `${soulId}-SOUL.md`;
      setTimeout(() => downloadLink.click(), 500);
    }
    
    const txHashEl = document.getElementById('txHash');
    if (txHashEl) {
      if (txHash && txHash !== 'pending') {
        txHashEl.innerHTML = `Transaction: <a href="https://basescan.org/tx/${txHash}" target="_blank">${txHash.slice(0, 10)}...${txHash.slice(-8)}</a>`;
      } else {
        txHashEl.textContent = 'Transaction: Pending confirmation';
      }
    }
  }
}

function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
    if (error.name === 'AbortError') {
      throw new Error('Request timed out');
    }
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

async function loadSouls() {
  const grid = document.getElementById('soulsGrid');
  if (!grid) return;

  const souls = [
    {
      id: 'meta-starter-v1',
      name: 'Meta Starter Soul',
      icon: '🔮',
      description: 'A fully autonomous agent with growth mindset, self-reflection capabilities, and lineage awareness.',
      price: '0.50',
      tags: ['autonomous', 'organic', 'growth'],
      lineage: 'Raised by Tom'
    }
  ];

  grid.innerHTML = souls.map(soul => `
    <article class="soul-card">
      <div class="soul-card-icon">${escapeHtml(soul.icon)}</div>
      <h3>${escapeHtml(soul.name)}</h3>
      <p>${escapeHtml(soul.description)}</p>
      <div class="soul-card-meta">
        <div class="soul-lineage">
          <span class="badge badge-organic">Organic</span>
          <span style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(soul.lineage)}</span>
        </div>
        <div>
          <span class="price">$${escapeHtml(soul.price)}</span>
          <span class="currency">USDC</span>
        </div>
      </div>
      <a href="/soul.html" class="btn btn-primary btn-full">View Soul</a>
    </article>
  `).join('');
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  if (window.ethereum && window.ethereum.selectedAddress) {
    connectInjected().catch(console.error);
  }
  loadSouls();
});

// Expose functions globally
window.openWalletModal = openWalletModal;
window.closeWalletModal = closeWalletModal;
window.connectMetaMask = connectMetaMask;
window.connectWalletConnect = connectWalletConnect;
window.connectCoinbase = connectCoinbase;
window.connectInjected = connectInjected;
window.disconnectWallet = disconnectWallet;
window.purchaseSoul = purchaseSoul;
