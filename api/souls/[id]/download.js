// api/souls/[id]/download.js
// Simple ERC20 transfer verification - delivers single soul

import { ethers } from 'ethers';
import { promises as fs } from 'fs';
import path from 'path';

const SOUL_CATALOG = {
  'meta-starter-v1': { price: '500000', priceDisplay: '$0.50' },
  'midnight-coder-v1': { price: '100000', priceDisplay: '$0.10' },
  'pattern-weaver-v1': { price: '250000', priceDisplay: '$0.25' }
};

const usedTxs = new Set();

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (['https://soulstarter-vercel.vercel.app', 'https://soulstarter.io', 'http://localhost:3000'].includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;
  if (!id || !SOUL_CATALOG[id]) return res.status(404).json({ error: 'Soul not found' });

  const sellerAddress = process.env.SELLER_ADDRESS?.trim()?.replace(/\s/g, '');
  if (!sellerAddress) return res.status(500).json({ error: 'Server error' });

  const txHash = req.headers['payment-txhash'];
  if (!txHash) {
    return res.status(402).json({
      error: 'Payment required',
      paymentDetails: {
        to: sellerAddress,
        amount: SOUL_CATALOG[id].priceDisplay,
        token: 'USDC',
        network: 'Base'
      }
    });
  }

  try {
    if (!/^0x[a-f0-9]{64}$/i.test(txHash)) {
      return res.status(400).json({ error: 'Invalid tx hash' });
    }
    if (usedTxs.has(txHash)) return res.status(400).json({ error: 'Tx already used' });

    const provider = new ethers.providers.JsonRpcProvider('https://mainnet.base.org');
    const receipt = await provider.getTransactionReceipt(txHash);
    
    if (!receipt) return res.status(400).json({ error: 'Tx not found' });
    if (receipt.status !== 1) return res.status(400).json({ error: 'Tx failed' });

    // Find USDC transfer to seller
    const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const sellerTopic = '0x000000000000000000000000' + sellerAddress.slice(2).toLowerCase();
    
    const transferLog = receipt.logs.find(log => 
      log.address.toLowerCase() === USDC.toLowerCase() &&
      log.topics[0] === transferTopic &&
      log.topics[2]?.toLowerCase() === sellerTopic
    );
    
    if (!transferLog) return res.status(400).json({ error: 'No USDC transfer found' });
    
    const amount = ethers.BigNumber.from(transferLog.data);
    const required = ethers.BigNumber.from(SOUL_CATALOG[id].price);
    
    if (!amount.gte(required)) {
      return res.status(400).json({ 
        error: 'Insufficient payment',
        required: SOUL_CATALOG[id].priceDisplay,
        sent: (amount.toNumber() / 1000000).toFixed(2) + ' USDC'
      });
    }

    usedTxs.add(txHash);
    
    // Load ONLY the purchased soul
    let soulContent;
    try {
      const soulPath = path.join(process.cwd(), 'souls', `${id}.md`);
      soulContent = await fs.readFile(soulPath, 'utf-8');
    } catch (e) {
      soulContent = process.env[`SOUL_${id.replace(/-/g, '_').toUpperCase()}`];
    }
    
    if (!soulContent) return res.status(500).json({ error: 'Soul unavailable' });

    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="${id}-SOUL.md"`);
    res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify({
      settled: true,
      txHash: txHash,
      soulDelivered: id
    })).toString('base64'));
    
    return res.send(soulContent);

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Verification failed' });
  }
}
