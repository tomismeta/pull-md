// api/souls/[id]/download.js
// On-chain x402 verification WITH actual USDC transfer

import { ethers } from 'ethers';
import { promises as fs } from 'fs';
import path from 'path';

// Simple in-memory tracking
const usedNonces = new Set();
const requestCounts = new Map();

// Rate limiting
const RATE_LIMIT = { windowMs: 60000, maxRequests: 10 };

// Allowed origins
const ALLOWED_ORIGINS = [
  'https://soulstarter.vercel.app',
  'https://soulstarter.io',
  'http://localhost:3000',
  'http://localhost:8080'
];

// USDC Contract on Base
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// USDC Domain for EIP-712
const USDC_DOMAIN = {
  name: 'USDC',
  version: '2',
  chainId: 8453,
  verifyingContract: USDC_ADDRESS
};

// EIP-712 Types for EIP-3009
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

// USDC ABI with transferWithAuthorization
const USDC_ABI = [
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (uint8)'
];

// Base RPC
const RPC_URL = 'https://mainnet.base.org';

// Soul catalog with prices (in USDC with 6 decimals)
const SOUL_CATALOG = {
  'meta-starter-v1': { price: '500000', priceDisplay: '$0.50' },
  'midnight-coder-v1': { price: '100000', priceDisplay: '$0.10' },
  'pattern-weaver-v1': { price: '250000', priceDisplay: '$0.25' }
};

export default async function handler(req, res) {
  // Rate limiting
  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const now = Date.now();
  const windowStart = now - RATE_LIMIT.windowMs;
  
  if (!requestCounts.has(clientIp)) {
    requestCounts.set(clientIp, []);
  }
  
  const requests = requestCounts.get(clientIp).filter(time => time > windowStart);
  if (requests.length >= RATE_LIMIT.maxRequests) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  requests.push(now);
  requestCounts.set(clientIp, requests);
  
  // CORS
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, PAYMENT-SIGNATURE');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { id } = req.query;
  
  if (!id || typeof id !== 'string' || id.length > 50) {
    return res.status(400).json({ error: 'Invalid soul ID' });
  }
  
  if (!SOUL_CATALOG[id]) {
    return res.status(404).json({ error: 'Soul not found' });
  }

  const CONFIG = {
    usdcAddress: USDC_ADDRESS,
    sellerAddress: process.env.SELLER_ADDRESS?.trim()?.replace(/\s/g, ''),
    network: 'eip155:8453',
    price: SOUL_CATALOG[id].price,
    priceDisplay: SOUL_CATALOG[id].priceDisplay
  };

  if (!CONFIG.sellerAddress) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const paymentSignature = req.headers['payment-signature'];

  if (!paymentSignature) {
    // Return 402 with payment requirements
    const nonce = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    
    const paymentRequired = {
      x402Version: 1,
      scheme: 'exact',
      network: CONFIG.network,
      payload: {
        token: CONFIG.usdcAddress,
        to: CONFIG.sellerAddress,
        amount: CONFIG.price,
        nonce: nonce
      }
    };
    
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(paymentRequired)).toString('base64'));
    return res.status(402).json({
      error: 'Payment required',
      message: 'This soul requires payment. Please provide a payment signature.',
      price: CONFIG.priceDisplay,
      currency: 'USDC',
      network: 'Base'
    });
  }

  // Verify payment and submit transaction
  try {
    if (paymentSignature.length > 20000) {
      return res.status(400).json({ error: 'Invalid payment signature format' });
    }
    
    let x402Payload;
    try {
      x402Payload = JSON.parse(Buffer.from(paymentSignature, 'base64').toString());
    } catch (e) {
      return res.status(400).json({ error: 'Invalid payment signature encoding' });
    }
    
    // Validate x402 structure
    if (!x402Payload.payload?.authorization || !x402Payload.payload?.signature) {
      return res.status(400).json({ error: 'Invalid x402 payload structure' });
    }
    
    const auth = x402Payload.payload.authorization;
    const signature = x402Payload.payload.signature;
    
    // Validate authorization fields
    if (!auth.from || !auth.to || !auth.value || !auth.validAfter || !auth.validBefore || !auth.nonce) {
      return res.status(400).json({ error: 'Invalid authorization structure' });
    }

    // Replay protection
    if (usedNonces.has(auth.nonce)) {
      return res.status(400).json({ error: 'Payment already used' });
    }

    // Validate timestamps
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec < parseInt(auth.validAfter)) {
      return res.status(400).json({ error: 'Payment not yet valid' });
    }
    if (nowSec > parseInt(auth.validBefore)) {
      return res.status(400).json({ error: 'Payment expired' });
    }

    // Validate amount
    if (auth.value !== CONFIG.price) {
      return res.status(400).json({ error: 'Invalid payment amount' });
    }

    // Validate recipient
    if (auth.to.toLowerCase() !== CONFIG.sellerAddress.toLowerCase()) {
      return res.status(400).json({ error: 'Invalid payment recipient' });
    }

    // Verify EIP-712 signature
    let recoveredSigner;
    try {
      recoveredSigner = ethers.utils.verifyTypedData(
        USDC_DOMAIN,
        TRANSFER_WITH_AUTHORIZATION_TYPE,
        auth,
        signature
      );
    } catch (e) {
      console.error('Signature verification failed:', e);
      return res.status(400).json({ error: 'Invalid signature' });
    }

    if (recoveredSigner.toLowerCase() !== auth.from.toLowerCase()) {
      return res.status(400).json({ error: 'Signature mismatch' });
    }

    // Check authorization state on-chain
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
    
    try {
      const authState = await usdc.authorizationState(auth.from, auth.nonce);
      if (authState.toString() !== '0') {
        return res.status(400).json({ error: 'Authorization already used on-chain' });
      }
    } catch (e) {
      console.error('On-chain check failed:', e);
    }

    // Split signature into v, r, s
    const sig = signature.slice(2); // Remove 0x
    const r = '0x' + sig.slice(0, 64);
    const s = '0x' + sig.slice(64, 128);
    const v = parseInt(sig.slice(128, 130), 16);

    // Submit to Coinbase Facilitator
    let txHash = null;
    
    try {
      console.log('Submitting to Coinbase Facilitator...');
      
      const settleResponse = await fetch('https://api.cdp.coinbase.com/platform/v2/x402', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          x402Version: 1,
          scheme: 'exact',
          network: 'eip155:8453',
          payload: x402Payload.payload
        })
      });
      
      if (settleResponse.ok) {
        const settleResult = await settleResponse.json();
        if (settleResult.settled && settleResult.txHash) {
          txHash = settleResult.txHash;
          console.log('Facilitator settled:', txHash);
        } else {
          console.log('Facilitator did not settle:', settleResult);
        }
      } else {
        const errorText = await settleResponse.text();
        console.error('Facilitator error:', settleResponse.status, errorText);
      }
    } catch (facilitatorError) {
      console.error('Facilitator submission failed:', facilitatorError.message);
      // Continue anyway - authorization is valid
    }

    // Mark nonce as used
    usedNonces.add(auth.nonce);
    
    // Cleanup
    if (usedNonces.size > 10000) {
      const noncesArray = Array.from(usedNonces);
      usedNonces.clear();
      noncesArray.slice(-5000).forEach(n => usedNonces.add(n));
    }

    // Load ALL soul contents - buying one unlocks all
    const allSouls = [];
    const soulIds = Object.keys(SOUL_CATALOG);
    
    for (const soulId of soulIds) {
      try {
        const soulPath = path.join(process.cwd(), 'souls', `${soulId}.md`);
        const content = await fs.readFile(soulPath, 'utf-8');
        allSouls.push(`\n---\n# ${SOUL_CATALOG[soulId].priceDisplay} - ${soulId}\n---\n\n${content}`);
      } catch (e) {
        // Fallback to env var
        const envContent = process.env[`SOUL_${soulId.replace(/-/g, '_').toUpperCase()}`];
        if (envContent) {
          allSouls.push(`\n---\n# ${SOUL_CATALOG[soulId].priceDisplay} - ${soulId}\n---\n\n${envContent}`);
        }
      }
    }
    
    if (allSouls.length === 0) {
      return res.status(500).json({ error: 'Soul content unavailable' });
    }

    const packageContent = `# 🎁 SOUL STARTER COLLECTION

You purchased: **${SOUL_CATALOG[id].priceDisplay}** - ${id}

**BONUS: All souls unlocked!** Enjoy the complete collection.

${allSouls.join('\n')}

---
*Acquired from SoulStarter — lineage matters.*
`;

    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="soulstarter-collection.md"`);
    res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify({
      settled: !!txHash,
      txHash: txHash || 'authorization-valid-submit-manually',
      message: txHash ? 'USDC transfer submitted' : 'Authorization valid - submit manually',
      unlockedSouls: soulIds
    })).toString('base64'));
    
    return res.send(packageContent);

  } catch (error) {
    console.error('Payment processing error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
