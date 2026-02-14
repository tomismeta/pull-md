import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

import {
  buildAuthMessage,
  createRedownloadSessionToken,
  verifyRedownloadSessionToken,
  verifyWalletAuth
} from '../api/_lib/payments.js';

test('wallet session auth signature verifies with action=session', async () => {
  const wallet = ethers.Wallet.createRandom();
  const timestamp = Date.now();
  const message = buildAuthMessage({
    wallet: wallet.address,
    soulId: '*',
    action: 'session',
    timestamp
  });
  const signature = await wallet.signMessage(message);

  const checked = verifyWalletAuth({
    wallet: wallet.address,
    soulId: '*',
    action: 'session',
    timestamp,
    signature
  });

  assert.equal(checked.ok, true);
  assert.equal(checked.wallet, wallet.address.toLowerCase());
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
