/**
 * SoulStarter - x402 Payment Integration (SECURE VERSION)
 * Handles wallet connection and secure soul purchases
 * 
 * SECURITY FIXES:
 * - XSS protection via HTML escaping
 * - Base64 error handling
 * - Chain change monitoring
 * - Fetch timeouts
 */

// Configuration
const CONFIG = {
  network: 'eip155:8453',
  usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  chainId: '0x2105',
  apiBase: '/api',
  requestTimeout: 30000 // 30 second timeout
};

// State
let wallet = null;
let walletAddress = null;
let currentChainId = null;

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Safe base64 decode with error handling
 */
function safeBase64Decode(str) {
  try {
    return atob(str);
  } catch (e) {
    console.error('Base64 decode failed:', e);
    throw new Error('Invalid payment data received');
  }
}

/**
 * Fetch with timeout
 */
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

/**
 * Initialize wallet connection
 */
async function connectWallet() {
  try {
    if (!window.ethereum) {
      showToast('Please install MetaMask to purchase souls', 'error');
      // Use direct link instead of window.open to avoid popup blockers
      const installLink = document.createElement('a');
      installLink.href = 'https://metamask.io';
      installLink.target = '_blank';
      installLink.rel = 'noopener noreferrer';
      installLink.click();
      return;
    }

    // Request account access
    const accounts = await window.ethereum.request({ 
      method: 'eth_requestAccounts' 
    });

    if (accounts.length === 0) {
      showToast('No accounts found', 'error');
      return;
    }

    walletAddress = accounts[0];
    wallet = window.ethereum;

    // Get current chain
    currentChainId = await window.ethereum.request({ method: 'eth_chainId' });

    // Switch to Base if needed
    if (currentChainId !== CONFIG.chainId) {
      await switchToBase();
    }

    // Update UI
    updateWalletUI();
    showToast('Wallet connected!', 'success');

    // Listen for account changes
    window.ethereum.on('accountsChanged', handleAccountsChanged);
    
    // Listen for chain changes
    window.ethereum.on('chainChanged', handleChainChanged);

  } catch (error) {
    console.error('Wallet connection failed:', error);
    showToast('Failed to connect wallet: ' + (error.message || 'Unknown error'), 'error');
  }
}

/**
 * Handle account changes
 */
function handleAccountsChanged(newAccounts) {
  walletAddress = newAccounts[0] || null;
  if (!walletAddress) {
    showToast('Wallet disconnected', 'warning');
  }
  updateWalletUI();
}

/**
 * Handle chain changes
 */
function handleChainChanged(newChainId) {
  currentChainId = newChainId;
  if (newChainId !== CONFIG.chainId) {
    showToast('Please switch to Base network to continue', 'warning');
    updateWalletUI();
  } else {
    showToast('Connected to Base network', 'success');
  }
}

/**
 * Switch to Base network
 */
async function switchToBase() {
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: CONFIG.chainId }]
    });
    currentChainId = CONFIG.chainId;
  } catch (switchError) {
    if (switchError.code === 4902) {
      // Add Base network
      try {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: CONFIG.chainId,
            chainName: 'Base',
            nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://mainnet.base.org'],
            blockExplorerUrls: ['https://basescan.org']
          }]
        });
      } catch (addError) {
        throw new Error('Failed to add Base network to wallet');
      }
    } else if (switchError.code === 4001) {
      // User rejected
      throw new Error('Please approve the network switch to Base');
    } else {
      throw switchError;
    }
  }
}

/**
 * Update wallet button UI
 */
function updateWalletUI() {
  const btn = document.getElementById('walletBtn');
  const text = document.getElementById('walletText');
  
  if (!btn || !text) return;
  
  if (walletAddress) {
    const isCorrectNetwork = currentChainId === CONFIG.chainId;
    text.textContent = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
    btn.classList.add('connected');
    
    if (!isCorrectNetwork) {
      btn.classList.add('wrong-network');
      text.textContent += ' (Wrong Network)';
    } else {
      btn.classList.remove('wrong-network');
    }
  } else {
    text.textContent = 'Connect Wallet';
    btn.classList.remove('connected', 'wrong-network');
  }
}

/**
 * Validate network before payment
 */
async function validateNetwork() {
  if (!walletAddress) {
    throw new Error('Please connect your wallet first');
  }
  
  currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
  
  if (currentChainId !== CONFIG.chainId) {
    showToast('Switching to Base network...', 'info');
    await switchToBase();
  }
}

/**
 * Purchase a soul via x402
 */
async function purchaseSoul(soulId) {
  const btn = document.getElementById('buyBtn');
  
  try {
    // Validate inputs
    if (!soulId || typeof soulId !== 'string') {
      throw new Error('Invalid soul ID');
    }
    
    // Validate network
    await validateNetwork();
    
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Processing...';
    }

    // Step 1: Request payment requirements
    showToast('Requesting payment details...', 'info');
    const response = await fetchWithTimeout(
      `${CONFIG.apiBase}/souls/${encodeURIComponent(soulId)}/download`,
      {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      }
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

    // Parse payment requirements safely
    const paymentRequiredB64 = response.headers.get('PAYMENT-REQUIRED');
    if (!paymentRequiredB64) {
      throw new Error('No payment requirements received');
    }

    let requirements;
    try {
      requirements = JSON.parse(safeBase64Decode(paymentRequiredB64));
    } catch (e) {
      throw new Error('Invalid payment requirements');
    }
    
    // Validate requirements
    if (!requirements.payload || !requirements.payload.amount) {
      throw new Error('Invalid payment data');
    }
    
    // Step 2: Create and sign payment
    showToast('Please sign the payment in your wallet', 'info');
    const paymentPayload = await createPaymentPayload(requirements);
    
    // Step 3: Send payment and get soul content
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
      } catch (e) {
        // Use default message
      }
      
      if (paymentResponse.status === 402) {
        throw new Error('Payment was rejected: ' + errorMessage);
      } else if (paymentResponse.status === 400) {
        throw new Error('Invalid payment: ' + errorMessage);
      } else {
        throw new Error(errorMessage);
      }
    }

    // Get soul content
    const soulContent = await paymentResponse.text();
    
    // Get transaction hash from response header
    let txHash = 'pending';
    const paymentResponseB64 = paymentResponse.headers.get('PAYMENT-RESPONSE');
    if (paymentResponseB64) {
      try {
        const paymentResult = JSON.parse(safeBase64Decode(paymentResponseB64));
        txHash = paymentResult.txHash || 'pending';
      } catch (e) {
        console.warn('Failed to parse payment response');
      }
    }

    // Show success and trigger download
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

/**
 * Create payment payload for x402
 */
async function createPaymentPayload(requirements) {
  const paymentData = {
    scheme: requirements.scheme,
    network: requirements.network,
    payload: requirements.payload
  };

  // Create message to sign
  const message = JSON.stringify(paymentData.payload);
  
  // Sign with wallet
  const signature = await window.ethereum.request({
    method: 'personal_sign',
    params: [message, walletAddress]
  });

  return {
    ...paymentData,
    signature,
    from: walletAddress
  };
}

/**
 * Show payment success UI and trigger download
 */
function showPaymentSuccess(content, txHash, soulId) {
  // Hide purchase card
  const purchaseCard = document.getElementById('purchaseCard');
  if (purchaseCard) {
    purchaseCard.style.display = 'none';
  }

  // Show success card
  const successCard = document.getElementById('successCard');
  if (successCard) {
    successCard.style.display = 'block';
    
    // Set download link
    const downloadLink = document.getElementById('downloadLink');
    if (downloadLink) {
      const blob = new Blob([content], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      downloadLink.href = url;
      downloadLink.download = `${escapeHtml(soulId)}-SOUL.md`;
      
      // Auto-trigger download
      setTimeout(() => downloadLink.click(), 500);
    }
    
    // Show transaction hash
    const txHashEl = document.getElementById('txHash');
    if (txHashEl) {
      if (txHash && txHash !== 'pending') {
        // Use textContent to avoid XSS
        txHashEl.textContent = 'Transaction: ';
        const link = document.createElement('a');
        link.href = `https://basescan.org/tx/${encodeURIComponent(txHash)}`;
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
 * Show toast notification (XSS-safe)
 */
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  
  const toast = document.createElement('div');
  toast.className = `toast toast-${escapeHtml(type)}`;
  toast.textContent = message; // Safe: uses textContent
  
  container.appendChild(toast);
  
  // Animate in
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });
  
  // Remove after 4 seconds
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

/**
 * Load soul cards on index page (XSS-safe)
 */
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

  // Clear grid
  grid.innerHTML = '';
  
  // Create cards safely
  souls.forEach(soul => {
    const card = document.createElement('article');
    card.className = 'soul-card';
    
    card.innerHTML = `
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
    `;
    
    const link = document.createElement('a');
    link.href = '/soul.html';
    link.className = 'btn btn-primary btn-full';
    link.textContent = 'View Soul';
    card.appendChild(link);
    
    grid.appendChild(card);
  });
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Check for existing wallet connection
  if (window.ethereum && window.ethereum.selectedAddress) {
    walletAddress = window.ethereum.selectedAddress;
    wallet = window.ethereum;
    window.ethereum.request({ method: 'eth_chainId' }).then(chainId => {
      currentChainId = chainId;
      updateWalletUI();
    });
  }
  
  // Load souls if on index page
  loadSouls();
});

// Expose functions globally
window.connectWallet = connectWallet;
window.purchaseSoul = purchaseSoul;
