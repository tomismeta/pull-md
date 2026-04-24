import test from 'node:test';
import assert from 'node:assert/strict';

import { createRedownloadSessionToken } from '../api/_lib/payments.js';
import { resolveRedownloadEntitlement } from '../api/_lib/asset_download_redownload.js';

const CREATOR_WALLET = '0xa7d395faf5e0a77a8d42d68ea01d2336671e5f55';

test('resolveRedownloadEntitlement grants creator recovery via signed session token', async () => {
  const priorSecret = process.env.PURCHASE_RECEIPT_SECRET;
  process.env.PURCHASE_RECEIPT_SECRET = 'test-secret';

  try {
    const result = await resolveRedownloadEntitlement({
      asset: {
        publishedBy: CREATOR_WALLET,
        priceMicroUsdc: '10000'
      },
      assetId: 'the-rock-v1',
      blockchainTransaction: null,
      clientModeRaw: '',
      delivery: { assetType: 'soul' },
      receipt: null,
      redownloadSessionToken: createRedownloadSessionToken({ wallet: CREATOR_WALLET }),
      sellerAddress: '0x7F46aCB709cd8DF5879F84915CA431fB740989E4',
      siweIdentity: {
        domain: 'pull.md',
        uri: 'https://pull.md'
      },
      strictAgentMode: false,
      wallet: CREATOR_WALLET,
      authSignature: null,
      authTimestamp: null,
      redownloadHeaders: {
        hasReceiptRedownloadHeaders: false,
        hasTransactionRedownloadHeaders: false
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.authWallet, CREATOR_WALLET);
    assert.equal(result.entitlementSource, 'creator');
    assert.equal(result.entitlementTransaction, 'creator-entitlement');
  } finally {
    if (typeof priorSecret === 'string') {
      process.env.PURCHASE_RECEIPT_SECRET = priorSecret;
    } else {
      delete process.env.PURCHASE_RECEIPT_SECRET;
    }
  }
});

test('resolveRedownloadEntitlement returns a structured strict-agent error for invalid receipts', async () => {
  const result = await resolveRedownloadEntitlement({
    asset: {
      publishedBy: '0x1111111111111111111111111111111111111111',
      priceMicroUsdc: '10000'
    },
    assetId: 'the-rock-v1',
    blockchainTransaction: null,
    clientModeRaw: 'agent',
    delivery: { assetType: 'soul' },
    receipt: 'invalid-receipt',
    redownloadSessionToken: null,
    sellerAddress: '0x7F46aCB709cd8DF5879F84915CA431fB740989E4',
    siweIdentity: {
      domain: 'pull.md',
      uri: 'https://pull.md'
    },
    strictAgentMode: true,
    wallet: CREATOR_WALLET,
    authSignature: null,
    authTimestamp: null,
    redownloadHeaders: {
      hasReceiptRedownloadHeaders: true,
      hasTransactionRedownloadHeaders: false
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.telemetry?.errorCode, 'invalid_receipt_agent_mode');
  assert.equal(result.body?.code, 'invalid_receipt_agent_mode');
  assert.deepEqual(result.body?.one_of, [['X-PURCHASE-RECEIPT'], ['X-BLOCKCHAIN-TRANSACTION']]);
});
