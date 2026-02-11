/**
 * SoulStarter - Multi-Wallet x402 Payment Integration
 * Supports MetaMask, WalletConnect, Coinbase, and injected wallets
 */

// Configuration
const CONFIG = {
  network: 'eip155:8453',
  usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  chainId: '0x2105',
  chainIdDecimal: 8453,
  apiBase: '/api',
  requestTimeout: 30000
};

// WalletConnect Project ID (replace with your own from https://cloud.walletconnect.com)
const WC_PROJECT_ID = 'YOUR_WC_PROJECT_ID'; // Get free from cloud.walletconnect.com

// State
let provider = null;
let signer = null;
let walletAddress = null;
let walletType = null;

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
    
    // Request account access
    const accounts = await window.ethereum.request({
      method: 'eth_requestAccounts'
    });
    
    if (accounts.length === 0) {
      throw new Error('No accounts found');
    }
    
    walletAddress = accounts[0];
    provider = new ethers.providers.Web3Provider(window.ethereum);
    signer = provider.getSigner();
    
    // Check and switch to Base
    await ensureCorrectNetwork(window.ethereum);
    
    // Setup listeners
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
    showToast('WalletConnect not configured. Please set up a project at cloud.walletconnect.com', 'error');
    return;
  }
  
  try {
    walletType = 'walletconnect';
    
    const ethereumProvider = await window.EthereumProvider.init({
      projectId: WC_PROJECT_ID,
      chains: [CONFIG.chainIdDecimal],
      showQrModal: true,
      methods: ['eth_sendTransaction', 'eth_sign', 'personal_sign'],
      events: ['chainChanged', 'accountsChanged'],
      metadata: {
        name: 'SoulStarter',
        description: 'Human-nurtured agent memory marketplace',
        url: window.location.origin,
        icons: [window.location.origin + '/favicon.ico']
      }
    });
    
    await ethereumProvider.enable();
    
    provider = new ethers.providers.Web3Provider(ethereumProvider);
    signer = provider.getSigner();
    walletAddress = await signer.getAddress();
    
    // WalletConnect handles network switching in the app
    
    // Setup listeners
    ethereumProvider.on('accountsChanged', (accounts) => {
      if (accounts.length === 0) {
        resetWalletState();
      } else {
        walletAddress = accounts[0];
        updateWalletUI();
      }
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
  
  // Check for Coinbase Wallet
  const coinbaseWallet = window.ethereum?.providers?.find(p => p.isCoinbaseWallet) ||
                         (window.ethereum?.isCoinbaseWallet ? window.ethereum : null);
  
  if (!coinbaseWallet && !window.ethereum) {
    showToast('Coinbase Wallet not found. Opening download page...', 'info');
    window.open('https://www.coinbase.com/wallet', '_blank');
    return;
  }
  
  try {
    walletType = 'coinbase';
    
    const providerToUse = coinbaseWallet || window.ethereum;
    
    const accounts = await providerToUse.request({
      method: 'eth_requestAccounts'
    });
    
    if (accounts.length === 0) {
      throw new Error('No accounts found');
    }
    
    walletAddress = accounts[0];
    provider = new ethers.providers.Web3Provider(providerToUse);
    signer = provider.getSigner();
    
    await ensureCorrectNetwork(providerToUse);
    
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
    showToast('No wallet found. Please install MetaMask, Rainbow, or another wallet.', 'error');
    return;
  }
  
  try {
    walletType = 'injected';
    
    const accounts = await window.ethereum.request({
      method: 'eth_requestAccounts'
    });
    
    if (accounts.length === 0) {
      throw new Error('No accounts found');
    }
    
    walletAddress = accounts[0];
    provider = new ethers.providers.Web3Provider(window.ethereum);
    signer = provider.getSigner();
    
    await ensureCorrectNetwork(window.ethereum);
    
    setupMetaMaskListeners();
    
    updateWalletUI();
    showToast('Wallet connected!', 'success');
    
  } catch (error) {
    console.error('Wallet connection failed:', error);
    showToast('Connection failed: ' + error.message, 'error');
    resetWalletState();
  }
}

async function ensureCorrectNetwork(ethereumProvider) {
  const chainId = await ethereumProvider.request({ method: 'eth_chainId' });
  
  if (chainId !== CONFIG.chainId) {
    try {
      await ethereumProvider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: CONFIG.chainId }]
      });
    } catch (switchError) {
      if (switchError.code === 4902) {
        await ethereumProvider.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: CONFIG.chainId,
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
  
  ethereumProvider.on('chainChanged', () => {
    window.location.reload();
  });
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
 * Purchase Functions
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

    // Step 1: Get payment requirements
    showToast('Requesting payment details...', 'info');
    const response = await fetchWithTimeout(
      `${CONFIG.apiBase}/souls/${encodeURIComponent(soulId)}/download`
    );

    if (response.status === 500) {
      throw new Error('Server error. Please try again later.');
    }
    
    if (response.status === 429) {
      throw new Error('Too many requests. Please wait a moment.');
    }

    if (response.status !== 402) {
      throw new Error('Unexpected response from server');
    }

    const paymentRequiredB64 = response.headers.get('PAYMENT-REQUIRED');
    if (!paymentRequiredB64) {
      throw new Error('No payment requirements received');
    }

    let requirements;
    try {
      requirements = JSON.parse(atob(paymentRequiredB64));
    } catch (e) {
      throw new Error('Invalid payment requirements');
    }
    
    if (!requirements.payload || !requirements.payload.amount) {
      throw new Error('Invalid payment data');
    }

    // Step 2: Create and sign payment
    showToast('Please sign the payment in your wallet', 'info');
    const paymentPayload = await createPaymentPayload(requirements);
    
    // Step 3: Send payment and get soul
    showToast('Verifying payment...', 'info');
    const paymentResponse = await fetchWithTimeout(
      `${CONFIG.apiBase}/souls/${encodeURIComponent(soulId)}/download`,
      {
        method: 'GET',
        headers: {
          'PAYMENT-SIGNATURE': btoa(JSON.stringify(paymentPayload)),
          'Accept': 'text/markdown'
        }
      }
    );

    if (!paymentResponse.ok) {
      let errorMessage = 'Payment failed';
      try {
        const error = await paymentResponse.json();
        errorMessage = error.message || errorMessage;
      } catch (e) {}
      
      if (paymentResponse.status === 402) {
        throw new Error('Payment was rejected: ' + errorMessage);
      } else {
        throw new Error(errorMessage);
      }
    }

    const soulContent = await paymentResponse.text();
    
    let txHash = 'pending';
    const paymentResponseB64 = paymentResponse.headers.get('PAYMENT-RESPONSE');
    if (paymentResponseB64) {
      try {
        const paymentResult = JSON.parse(atob(paymentResponseB64));
        txHash = paymentResult.txHash || 'pending';
      } catch (e) {
        console.warn('Failed to parse payment response');
      }
    }

    showPaymentSuccess(soulContent, txHash, soulId);
    showToast('Soul acquired successfully!', 'success');

  } catch (error) {
    console.error('Purchase failed:', error);
    showToast('Purchase failed: ' + (error.message || 'Unknown error'), 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Buy Soul';
    }
  }
}

async function createPaymentPayload(requirements) {
  const message = JSON.stringify(requirements.payload);
  
  // Sign with ethers signer (works with all wallet types)
  const signature = await signer.signMessage(message);

  return {
    scheme: requirements.scheme,
    network: requirements.network,
    payload: requirements.payload,
    signature,
    from: walletAddress
  };
}

function showPaymentSuccess(content, txHash, soulId) {
  const purchaseCard = document.getElementById('purchaseCard');
  if (purchaseCard) {
    purchaseCard.style.display = 'none';
  }

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
        txHashEl.textContent = 'Transaction: ';
        const link = document.createElement('a');
        link.href = `https://basescan.org/tx/${txHash}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = txHash.slice(0, 10) + '...' + txHash.slice(-8);
        link.style.color = 'var(--accent-secondary)';
        txHashEl.appendChild(link);
      } else {
        txHashEl.textContent = 'Transaction: Pending confirmation';
      }
    }
  }
}

/**
 * Utility Functions
 */

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
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Request timed out. Please try again.');
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
  
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });
  
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
  // Check for existing connection
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
