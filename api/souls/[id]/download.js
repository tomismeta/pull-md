// api/souls/[id]/download.js
// Simple ERC20 transfer approach (reliable but not gasless)

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
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
    sellerAddress: process.env.SELLER_ADDRESS?.trim()?.replace(/\s/g, ''),
    price: SOUL_CATALOG[id].price,
    priceDisplay: SOUL_CATALOG[id].priceDisplay
  };

  if (!CONFIG.sellerAddress) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Check for txHash proof of payment
  const txHash = req.headers['payment-txhash'];

  if (!txHash) {
    // Return 402 with payment instructions
    return res.status(402).json({
      error: 'Payment required',
      message: `Send ${CONFIG.priceDisplay} USDC on Base to ${CONFIG.sellerAddress}, then provide the transaction hash.`,
      paymentDetails: {
        token: 'USDC',
        network: 'Base',
        chainId: 8453,
        tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        to: CONFIG.sellerAddress,
        amount: CONFIG.priceDisplay,
        amountRaw: CONFIG.price,
        instructions: `Send ${CONFIG.priceDisplay} USDC on Base to ${CONFIG.sellerAddress}, then call this endpoint with header: PAYMENT-TXHASH: <your-tx-hash>`
      }
    });
  }

  // Verify the transaction
  try {
    if (!/^0x[a-f0-9]{64}$/i.test(txHash)) {
      return res.status(400).json({ error: 'Invalid transaction hash format' });
    }

    if (usedNonces.has(txHash)) {
      return res.status(400).json({ error: 'Transaction already used' });
    }

    // Verify on-chain
    const RPC_URL = 'https://mainnet.base.org';
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    
    const receipt = await provider.getTransactionReceipt(txHash);
    
    if (!receipt) {
      return res.status(400).json({ error: 'Transaction not found. Wait for confirmation and try again.' });
    }
    
    if (receipt.status !== 1) {
      return res.status(400).json({ error: 'Transaction failed on-chain' });
    }
    
    // Verify USDC transfer in logs (handle smart contract wallets)
    const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    
    // Look for USDC Transfer event to seller
    const transferLog = receipt.logs.find(log => 
      log.address.toLowerCase() === USDC_ADDRESS.toLowerCase() &&
      log.topics[0] === transferTopic &&
      log.topics[2] && log.topics[2].toLowerCase() === '0x000000000000000000000000' + CONFIG.sellerAddress.slice(2).toLowerCase()
    );
    
    if (!transferLog) {
      return res.status(400).json({ 
        error: 'No USDC transfer to seller found in transaction logs',
        hint: 'Transaction may be a smart contract interaction. Looking for Transfer event to: ' + CONFIG.sellerAddress
      });
    }
    
    // Verify amount
    const amount = ethers.BigNumber.from(transferLog.data);
    const expectedAmount = ethers.BigNumber.from(CONFIG.price);
    
    if (!amount.gte(expectedAmount)) {
      return res.status(400).json({ 
        error: 'Insufficient payment amount',
        expected: CONFIG.priceDisplay,
        received: (amount.toNumber() / 1000000).toFixed(2) + ' USDC'
      });
    }

    // Mark as used
    usedNonces.add(txHash);
    
    // Load ALL souls
    const allSouls = [];
    const soulIds = Object.keys(SOUL_CATALOG);
    
    for (const soulId of soulIds) {
      try {
        const soulPath = path.join(process.cwd(), 'souls', `${soulId}.md`);
        const content = await fs.readFile(soulPath, 'utf-8');
        allSouls.push(`\n---\n# ${SOUL_CATALOG[soulId].priceDisplay} - ${soulId}\n---\n\n${content}`);
      } catch (e) {
        const envContent = process.env[`SOUL_${soulId.replace(/-/g, '_').toUpperCase()}`];
        if (envContent) {
          allSouls.push(`\n---\n# ${SOUL_CATALOG[soulId].priceDisplay} - ${soulId}\n---\n\n${envContent}`);
        }
      }
    }

    const packageContent = `# 🎁 SOUL STARTER COLLECTION

Payment verified on-chain!
Transaction: https://basescan.org/tx/${txHash}

You purchased: **${CONFIG.priceDisplay}** - ${id}

**BONUS: All souls unlocked!** Enjoy the complete collection.

${allSouls.join('\n')}

---
*Acquired from SoulStarter — lineage matters.*
`;

    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="soulstarter-collection.md"`);
    res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify({
      settled: true,
      txHash: txHash,
      verified: true,
      unlockedSouls: soulIds
    })).toString('base64'));
    
    return res.send(packageContent);

  } catch (error) {
    console.error('Payment verification error:', error);
    return res.status(500).json({ error: 'Failed to verify payment' });
  }
}
