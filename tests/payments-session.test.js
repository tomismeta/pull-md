import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

import {
  buildSiweAuthMessage,
  createPurchaseReceipt,
  createRedownloadSessionToken,
  verifyPurchaseReceipt,
  verifyRedownloadSessionToken,
  verifyWalletAuth
} from '../api/_lib/payments.js';

test('wallet session auth plain message is rejected (SIWE-only)', async () => {
  const wallet = ethers.Wallet.createRandom();
  const timestamp = Date.now();
  const message = [
    'SoulStarter Wallet Authentication',
    `address:${wallet.address.toLowerCase()}`,
    'soul:*',
    'action:session',
    `timestamp:${timestamp}`
  ].join('\n');
  const signature = await wallet.signMessage(message);

  const checked = await verifyWalletAuth({
    wallet: wallet.address,
    soulId: '*',
    action: 'session',
    timestamp,
    signature
  });

  assert.equal(checked.ok, false);
  assert.match(String(checked.error || ''), /SIWE/i);
});

test('wallet session auth typed-data signature is rejected (SIWE-only)', async () => {
  const wallet = ethers.Wallet.createRandom();
  const timestamp = Date.now();
  const typed = {
    domain: { name: 'SoulStarter Authentication', version: '1' },
    types: {
      SoulStarterAuth: [
        { name: 'wallet', type: 'address' },
        { name: 'soul', type: 'string' },
        { name: 'action', type: 'string' },
        { name: 'timestamp', type: 'uint256' },
        { name: 'statement', type: 'string' }
      ]
    },
    message: {
      wallet: ethers.getAddress(wallet.address),
      soul: '*',
      action: 'session',
      timestamp: Number(timestamp),
      statement: 'Authentication only. No token transfer or approval.'
    }
  };
  const signature = await wallet.signTypedData(typed.domain, typed.types, typed.message);

  const checked = await verifyWalletAuth({
    wallet: wallet.address,
    soulId: '*',
    action: 'session',
    timestamp,
    signature
  });

  assert.equal(checked.ok, false);
  assert.match(String(checked.error || ''), /SIWE/i);
});

test('wallet session auth SIWE signature verifies with action=session', async () => {
  const wallet = ethers.Wallet.createRandom();
  const timestamp = Date.now();
  const message = buildSiweAuthMessage({
    wallet: wallet.address,
    soulId: '*',
    action: 'session',
    timestamp
  });
  const signature = await wallet.signMessage(message);

  const checked = await verifyWalletAuth({
    wallet: wallet.address,
    soulId: '*',
    action: 'session',
    timestamp,
    signature
  });

  assert.equal(checked.ok, true);
  assert.equal(checked.wallet, wallet.address.toLowerCase());
  assert.equal(checked.auth_format, 'siwe');
});

test('redownload auth plain message is rejected (SIWE-only)', async () => {
  const wallet = ethers.Wallet.createRandom();
  const timestamp = Date.now();
  const message = [
    'SoulStarter Wallet Authentication',
    `address:${wallet.address.toLowerCase()}`,
    'soul:sassy-starter-v1',
    'action:redownload',
    `timestamp:${timestamp}`
  ].join('\n');
  const signature = await wallet.signMessage(message);
  const checked = await verifyWalletAuth({
    wallet: wallet.address,
    soulId: 'sassy-starter-v1',
    action: 'redownload',
    timestamp,
    signature
  });
  assert.equal(checked.ok, false);
  assert.match(String(checked.error || ''), /SIWE/i);
});

test('redownload auth SIWE signature verifies', async () => {
  const wallet = ethers.Wallet.createRandom();
  const timestamp = Date.now();
  const message = buildSiweAuthMessage({
    wallet: wallet.address,
    soulId: 'sassy-starter-v1',
    action: 'redownload',
    timestamp
  });
  const signature = await wallet.signMessage(message);
  const checked = await verifyWalletAuth({
    wallet: wallet.address,
    soulId: 'sassy-starter-v1',
    action: 'redownload',
    timestamp,
    signature
  });
  assert.equal(checked.ok, true);
  assert.equal(checked.auth_format, 'siwe');
});

test('redownload session token binds to wallet and expires', async () => {
  const originalSecret = process.env.PURCHASE_RECEIPT_SECRET;
  process.env.PURCHASE_RECEIPT_SECRET = 'test-secret-value-1';
  try {
    const wallet = ethers.Wallet.createRandom().address.toLowerCase();
    const token = createRedownloadSessionToken({ wallet });

    const okCheck = verifyRedownloadSessionToken({ token, wallet });
    assert.equal(okCheck.ok, true);
    assert.ok(Number.isFinite(okCheck.exp));

    const otherWallet = ethers.Wallet.createRandom().address.toLowerCase();
    const mismatchCheck = verifyRedownloadSessionToken({ token, wallet: otherWallet });
    assert.equal(mismatchCheck.ok, false);
    assert.match(String(mismatchCheck.error || ''), /wallet mismatch/i);
  } finally {
    if (originalSecret === undefined) delete process.env.PURCHASE_RECEIPT_SECRET;
    else process.env.PURCHASE_RECEIPT_SECRET = originalSecret;
  }
});

test('purchase receipt verifies with legacy secret fallback', () => {
  const originalSecret = process.env.PURCHASE_RECEIPT_SECRET;
  const originalPrevious = process.env.PURCHASE_RECEIPT_SECRET_PREVIOUS;
  process.env.PURCHASE_RECEIPT_SECRET = 'current-secret-value';
  process.env.PURCHASE_RECEIPT_SECRET_PREVIOUS = '';
  try {
    const wallet = ethers.Wallet.createRandom().address.toLowerCase();
    const soulId = 'sassy-starter-v1';
    const receipt = createPurchaseReceipt({ wallet, soulId, transaction: '0xtest' });

    process.env.PURCHASE_RECEIPT_SECRET = 'new-secret-after-rotation';
    process.env.PURCHASE_RECEIPT_SECRET_PREVIOUS = 'current-secret-value';

    const checked = verifyPurchaseReceipt({ receipt, wallet, soulId });
    assert.equal(checked.ok, true);
  } finally {
    if (originalSecret === undefined) delete process.env.PURCHASE_RECEIPT_SECRET;
    else process.env.PURCHASE_RECEIPT_SECRET = originalSecret;
    if (originalPrevious === undefined) delete process.env.PURCHASE_RECEIPT_SECRET_PREVIOUS;
    else process.env.PURCHASE_RECEIPT_SECRET_PREVIOUS = originalPrevious;
  }
});
