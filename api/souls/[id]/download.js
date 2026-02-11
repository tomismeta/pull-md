// api/souls/[id]/download.js
// SECURE endpoint - returns soul content only after verified x402 payment
// FIXED: Replay protection, CORS restrictions, rate limiting

// Simple in-memory nonce tracking (use Redis/Vercel KV in production)
const usedNonces = new Set();
const requestCounts = new Map();

// Rate limiting configuration
const RATE_LIMIT = {
  windowMs: 60000, // 1 minute
  maxRequests: 10  // per IP per window
};

// Allowed origins (update with your actual domains)
const ALLOWED_ORIGINS = [
  'https://soulstarter.vercel.app',
  'https://soulstarter.io',
  'http://localhost:3000',
  'http://localhost:8080'
];

export default async function handler(req, res) {
  // Get client IP for rate limiting
  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  
  // Rate limiting check
  const now = Date.now();
  const windowStart = now - RATE_LIMIT.windowMs;
  
  if (!requestCounts.has(clientIp)) {
    requestCounts.set(clientIp, []);
  }
  
  const requests = requestCounts.get(clientIp).filter(time => time > windowStart);
  
  if (requests.length >= RATE_LIMIT.maxRequests) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: 'Too many requests. Please try again later.'
    });
  }
  
  requests.push(now);
  requestCounts.set(clientIp, requests);
  
  // CORS - Restrict to allowed origins only
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, PAYMENT-SIGNATURE');
  res.setHeader('Vary', 'Origin');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { id } = req.query;
  
  // Input validation
  if (!id || typeof id !== 'string' || id.length > 50) {
    return res.status(400).json({ error: 'Invalid soul ID' });
  }
  
  // Validate soul ID against whitelist
  const validSouls = ['meta-starter-v1'];
  if (!validSouls.includes(id)) {
    return res.status(404).json({ error: 'Soul not found' });
  }

  // Configuration
  const CONFIG = {
    facilitator: 'https://api.cdp.coinbase.com/x402/facilitator/v1',
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    sellerAddress: process.env.SELLER_ADDRESS,
    network: 'eip155:8453',
    price: '500000' // $0.50 = 500000 micro-USDC
  };

  // Validate seller address configured
  if (!CONFIG.sellerAddress) {
    console.error('SELLER_ADDRESS not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Check for payment signature
  const paymentSignature = req.headers['payment-signature'];

  if (!paymentSignature) {
    // Generate unique nonce
    const nonce = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    
    // Return 402 with payment requirements
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
    // Validate signature format
    if (paymentSignature.length > 10000) {
      return res.status(400).json({ error: 'Invalid payment signature format' });
    }
    
    let paymentPayload;
    try {
      paymentPayload = JSON.parse(Buffer.from(paymentSignature, 'base64').toString());
    } catch (e) {
      return res.status(400).json({ error: 'Invalid payment signature encoding' });
    }
    
    // Validate payload structure
    if (!paymentPayload.signature || !paymentPayload.payload || !paymentPayload.payload.nonce) {
      return res.status(400).json({ error: 'Invalid payment payload structure' });
    }

    // REPLAY ATTACK PROTECTION: Check if nonce was already used
    if (usedNonces.has(paymentPayload.payload.nonce)) {
      return res.status(400).json({
        error: 'Payment already used',
        message: 'This payment has already been redeemed'
      });
    }

    // REPLAY ATTACK PROTECTION: Validate nonce format and timestamp
    const nonceParts = paymentPayload.payload.nonce.split('-');
    if (nonceParts.length !== 2) {
      return res.status(400).json({ error: 'Invalid nonce format' });
    }
    
    const nonceTimestamp = parseInt(nonceParts[0]);
    if (isNaN(nonceTimestamp) || Date.now() - nonceTimestamp > 300000) { // 5 minute expiry
      return res.status(400).json({ error: 'Payment expired' });
    }

    // Verify via Coinbase Facilitator
    let verification;
    try {
      const verifyResponse = await fetch(`${CONFIG.facilitator}/verify`, {
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

      verification = await verifyResponse.json();
      
      if (!verification.valid) {
        return res.status(402).json({
          error: 'Invalid payment',
          message: 'Payment could not be verified'
        });
      }
    } catch (verifyError) {
      console.error('Facilitator verification error:', verifyError);
      return res.status(503).json({
        error: 'Payment verification service unavailable',
        message: 'Please try again later'
      });
    }

    // Mark nonce as used (REPLAY PROTECTION)
    usedNonces.add(paymentPayload.payload.nonce);
    
    // Clean up old nonces periodically (keep last 10000)
    if (usedNonces.size > 10000) {
      const noncesArray = Array.from(usedNonces);
      usedNonces.clear();
      noncesArray.slice(-5000).forEach(n => usedNonces.add(n));
    }

    // CRITICAL: Wait for settlement before delivering content
    let settlement;
    try {
      const settleResponse = await fetch(`${CONFIG.facilitator}/settle`, {
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

      settlement = await settleResponse.json();
      
      if (!settlement.settled) {
        throw new Error('Payment not settled');
      }
    } catch (settleError) {
      console.error('Settlement error:', settleError);
      // Mark nonce as unused so they can retry
      usedNonces.delete(paymentPayload.payload.nonce);
      return res.status(502).json({
        error: 'Payment settlement failed',
        message: 'Payment was verified but settlement failed. Please retry.'
      });
    }

    // Get soul content from environment variable
    const soulContent = process.env[`SOUL_${id.replace(/-/g, '_').toUpperCase()}`];
    
    if (!soulContent) {
      console.error(`Soul content not found for ${id}`);
      return res.status(500).json({ error: 'Soul content unavailable' });
    }

    // Return soul content with security headers
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="${id}-SOUL.md"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
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
