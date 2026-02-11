// api/souls/[id]/download.js
// PROPER x402 implementation with EIP-3009 authorization verification

// Simple in-memory nonce tracking
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

// Coinbase Facilitator
const FACILITATOR_URL = 'https://api.cdp.coinbase.com/x402/facilitator/v1';

// USDC Contract ABI (minimal for transferWithAuthorization)
const USDC_ABI = [
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external',
  'function authorizationState(address authorizer, bytes32 nonce) external view returns (uint8)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)'
];

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
  
  const validSouls = ['meta-starter-v1'];
  if (!validSouls.includes(id)) {
    return res.status(404).json({ error: 'Soul not found' });
  }

  const CONFIG = {
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    sellerAddress: process.env.SELLER_ADDRESS?.trim(),
    network: 'eip155:8453',
    price: '500000'
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
      price: '$0.50',
      currency: 'USDC',
      network: 'Base'
    });
  }

  // Verify payment
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

    // Verify with Coinbase Facilitator
    const verifyResponse = await fetch(`${FACILITATOR_URL}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: CONFIG.network,
        payload: x402Payload.payload
      })
    });

    if (!verifyResponse.ok) {
      const error = await verifyResponse.json().catch(() => ({}));
      console.error('Facilitator verify error:', error);
      return res.status(402).json({
        error: 'Payment verification failed',
        message: error.message || 'Invalid payment'
      });
    }

    const verification = await verifyResponse.json();
    
    if (!verification.valid) {
      return res.status(402).json({
        error: 'Invalid payment',
        message: 'Payment could not be verified'
      });
    }

    // Settle payment
    const settleResponse = await fetch(`${FACILITATOR_URL}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: CONFIG.network,
        payload: x402Payload.payload
      })
    });

    if (!settleResponse.ok) {
      const error = await settleResponse.json().catch(() => ({}));
      console.error('Facilitator settle error:', error);
      throw new Error('Settlement failed');
    }

    const settlement = await settleResponse.json();
    
    if (!settlement.settled) {
      throw new Error('Payment not settled');
    }

    // Mark nonce as used
    usedNonces.add(auth.nonce);
    
    // Cleanup
    if (usedNonces.size > 10000) {
      const noncesArray = Array.from(usedNonces);
      usedNonces.clear();
      noncesArray.slice(-5000).forEach(n => usedNonces.add(n));
    }

    // Return soul content
    const soulContent = process.env[`SOUL_${id.replace(/-/g, '_').toUpperCase()}`];
    
    if (!soulContent) {
      return res.status(500).json({ error: 'Soul content unavailable' });
    }

    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="${id}-SOUL.md"`);
    res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify({
      settled: true,
      txHash: settlement.txHash || 'confirmed'
    })).toString('base64'));
    
    return res.send(soulContent);

  } catch (error) {
    console.error('Payment processing error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Import ethers for validation
import { ethers } from 'ethers';
