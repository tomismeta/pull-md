// api/souls/[id]/download.js
// SECURE endpoint - returns soul content only after verified x402 payment
// Uses Coinbase Facilitator for payment verification

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

// Facilitator config
const FACILITATOR_URL = 'https://api.cdp.coinbase.com/x402/facilitator/v1';

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
    const nonce = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    
    const paymentRequired = {
      scheme: 'exact',
      network: CONFIG.network,
      payload: {
        token: CONFIG.usdcAddress,
        to: CONFIG.sellerAddress,
        amount: CONFIG.price,
        timestamp: Date.now(),
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
    if (paymentSignature.length > 10000) {
      return res.status(400).json({ error: 'Invalid payment signature format' });
    }
    
    let paymentPayload;
    try {
      paymentPayload = JSON.parse(Buffer.from(paymentSignature, 'base64').toString());
    } catch (e) {
      return res.status(400).json({ error: 'Invalid payment signature encoding' });
    }
    
    if (!paymentPayload.signature || !paymentPayload.payload || !paymentPayload.payload.nonce) {
      return res.status(400).json({ error: 'Invalid payment payload structure' });
    }

    // Replay protection
    if (usedNonces.has(paymentPayload.payload.nonce)) {
      return res.status(400).json({ error: 'Payment already used' });
    }

    // Validate nonce timestamp
    const nonceParts = paymentPayload.payload.nonce.split('-');
    if (nonceParts.length !== 2) {
      return res.status(400).json({ error: 'Invalid nonce format' });
    }
    
    const nonceTimestamp = parseInt(nonceParts[0]);
    if (isNaN(nonceTimestamp) || Date.now() - nonceTimestamp > 300000) {
      return res.status(400).json({ error: 'Payment expired' });
    }

    // Verify with Coinbase Facilitator
    const verifyResponse = await fetch(`${FACILITATOR_URL}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment: paymentPayload,
        requirements: {
          scheme: 'exact',
          network: CONFIG.network,
          payload: {
            token: CONFIG.usdcAddress,
            to: CONFIG.sellerAddress,
            amount: CONFIG.price
          }
        }
      })
    });

    if (!verifyResponse.ok) {
      const error = await verifyResponse.json().catch(() => ({}));
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
        payment: paymentPayload,
        requirements: {
          scheme: 'exact',
          network: CONFIG.network,
          payload: {
            token: CONFIG.usdcAddress,
            to: CONFIG.sellerAddress,
            amount: CONFIG.price
          }
        }
      })
    });

    if (!settleResponse.ok) {
      throw new Error('Settlement failed');
    }

    const settlement = await settleResponse.json();
    
    if (!settlement.settled) {
      throw new Error('Payment not settled');
    }

    // Mark nonce as used
    usedNonces.add(paymentPayload.payload.nonce);
    
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
