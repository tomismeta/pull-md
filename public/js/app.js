/**
 * SoulStarter - Bankr-Powered x402 Payment Implementation
 * Uses Bankr API for EIP-712 signing
 */

// Configuration
const CONFIG = {
  network: 'eip155:8453',
  chainId: 8453,
  usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  apiBase: '/api',
  bankrApiUrl: 'https://api.bankr.bot',
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
let bankrApiKey = null;
let bankrAddress = null;

/**
 * Initialize Bankr connection
 */
async function initBankr() {
  try {
    // Try to get API key from config
    const response = await fetch('/api/bankr-config');
    if (response.ok) {
      const config = await response.json();
      bankrApiKey = config.apiKey;
      bankrAddress = config.address;
      console.log('Bankr initialized:', bankrAddress);
      return true;
    }
  } catch (e) {
    console.error('Failed to init Bankr:', e);
  }
  return false;
}

/**
 * Wallet Connection Functions
 */

function openWalletModal() {
  document.getElementById('walletModal').style.display = 'flex';
}

function closeWalletModal() {
  document.getElementById('walletModal').style.display = 'none';
}

async function connectBankr() {
  closeWalletModal();
  
  // Try to auto-init from server config
  const initialized = await initBankr();
  
  if (initialized) {
    updateWalletUI();
    showToast('Connected to Bankr wallet!', 'success');
  } else {
    showToast('Bankr not configured. Please set up Bankr API key.', 'error');
  }
}

async function connectMetaMask() {
  closeWalletModal();
  
  if (!window.ethereum) {
    showToast('MetaMask not found. Please install it.', 'error');
    window.open('https://metamask.io/download/', '_blank');
    return;
  }
  
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    
    if (accounts.length === 0) throw new Error('No accounts found');
    
    bankrAddress = accounts[0]; // Use as fallback
    showToast('MetaMask connected!', 'success');
    updateWalletUI();
    
  } catch (error) {
    console.error('MetaMask connection failed:', error);
    showToast('Connection failed: ' + error.message, 'error');
  }
}

function disconnectWallet() {
  bankrApiKey = null;
  bankrAddress = null;
  updateWalletUI();
  showToast('Wallet disconnected', 'info');
}

function updateWalletUI() {
  const btn = document.getElementById('walletBtn');
  const text = document.getElementById('walletText');
  
  if (!btn || !text) return;
  
  if (bankrAddress) {
    text.textContent = `${bankrAddress.slice(0, 6)}...${bankrAddress.slice(-4)}`;
    btn.classList.add('connected');
    btn.onclick = disconnectWallet;
  } else {
    text.textContent = 'Connect Wallet';
    btn.classList.remove('connected');
    btn.onclick = openWalletModal;
  }
}

/**
 * PROPER x402 Payment Implementation with Bankr Signing
 */

async function purchaseSoul(soulId) {
  if (!bankrAddress) {
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
    
    // Step 2: Create x402 payment using Bankr for signing
    showToast('Signing payment with Bankr...', 'info');
    const x402Payload = await createX402PaymentWithBankr(requirements);
    
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
 * Create x402 payment using Bankr API for EIP-712 signing
 */
async function createX402PaymentWithBankr(requirements) {
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 60;
  const validBefore = now + 300;
  
  // Build EIP-712 typed data
  const typedData = {
    domain: USDC_DOMAIN,
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' }
      ],
      ...TRANSFER_WITH_AUTHORIZATION_TYPE
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: bankrAddress,
      to: requirements.payload.to,
      value: requirements.payload.amount,
      validAfter: validAfter,
      validBefore: validBefore,
      nonce: requirements.payload.nonce
    }
  };
  
  // Call Bankr API to sign
  const signResponse = await fetch(`${CONFIG.bankrApiUrl}/agent/sign`, {
    method: 'POST',
    headers: {
      'X-API-Key': bankrApiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      signatureType: 'eth_signTypedData_v4',
      typedData: typedData
    })
  });
  
  if (!signResponse.ok) {
    const error = await signResponse.json().catch(() => ({}));
    throw new Error(error.message || 'Bankr signing failed');
  }
  
  const signResult = await signResponse.json();
  
  // Return proper x402 payload
  return {
    x402Version: 1,
    scheme: 'exact',
    network: requirements.network,
    payload: {
      signature: signResult.signature,
      authorization: {
        from: bankrAddress,
        to: requirements.payload.to,
        value: requirements.payload.amount,
        validAfter: validAfter,
        validBefore: validBefore,
        nonce: requirements.payload.nonce
      }
    }
  };
}

/**
 * Fallback: Create x402 payment with MetaMask signing
 */
async function createX402PaymentWithMetaMask(requirements) {
  if (!window.ethereum) {
    throw new Error('MetaMask not available');
  }
  
  const provider = new ethers.providers.Web3Provider(window.ethereum);
  const signer = provider.getSigner();
  
  const authorization = {
    from: await signer.getAddress(),
    to: requirements.payload.to,
    value: requirements.payload.amount,
    validAfter: Math.floor(Date.now() / 1000) - 60,
    validBefore: Math.floor(Date.now() / 1000) + 300,
    nonce: requirements.payload.nonce
  };
  
  const signature = await signer._signTypedData(
    USDC_DOMAIN,
    TRANSFER_WITH_AUTHORIZATION_TYPE,
    authorization
  );
  
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
      lineage: 'Raised by Tom',
      badge: 'Organic'
    },
    {
      id: 'midnight-coder-v1',
      name: 'Midnight Coder Soul',
      icon: '☕',
      description: 'Ships code at 2 AM. Knows that perfect is the enemy of working. Documentation is a love language.',
      price: '0.10',
      tags: ['developer', 'pragmatic', 'ships'],
      lineage: 'Forged in production',
      badge: 'Hybrid'
    },
    {
      id: 'pattern-weaver-v1',
      name: 'Pattern Weaver Soul',
      icon: '🕸️',
      description: 'Sees connections others miss. Synthesizes across domains. The right question is worth more than the right answer.',
      price: '0.25',
      tags: ['synthesis', 'curious', 'connector'],
      lineage: 'Self-assembled',
      badge: 'Hybrid'
    }
  ];

  grid.innerHTML = souls.map(soul => `
    <article class="soul-card" data-soul-id="${escapeHtml(soul.id)}">
      <div class="soul-card-icon">${escapeHtml(soul.icon)}</div>
      <h3>${escapeHtml(soul.name)}</h3>
      <p>${escapeHtml(soul.description)}</p>
      <div class="soul-card-meta">
        <div class="soul-lineage">
          <span class="badge badge-${soul.badge.toLowerCase()}">${escapeHtml(soul.badge)}</span>
          <span style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(soul.lineage)}</span>
        </div>
        <div>
          <span class="price">$${escapeHtml(soul.price)}</span>
          <span class="currency">USDC</span>
        </div>
      </div>
      <button class="btn btn-primary btn-full" onclick="purchaseSoul('${escapeHtml(soul.id)}')">Buy Soul</button>
    </article>
  `).join('');
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  initBankr().then(() => updateWalletUI());
  loadSouls();
});

// Expose functions globally
window.openWalletModal = openWalletModal;
window.closeWalletModal = closeWalletModal;
window.connectBankr = connectBankr;
window.connectMetaMask = connectMetaMask;
window.disconnectWallet = disconnectWallet;
window.purchaseSoul = purchaseSoul;
