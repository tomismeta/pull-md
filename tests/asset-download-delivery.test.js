import test from 'node:test';
import assert from 'node:assert/strict';

import { applySuccessfulAssetDelivery, buildDownloadPaymentResponse } from '../api/_lib/asset_download_delivery.js';

function makeMockResponse() {
  const headers = new Map();
  return {
    headers,
    body: null,
    statusCode: null,
    getHeader(name) {
      return headers.get(name);
    },
    setHeader(name, value) {
      headers.set(name, value);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
}

function decodePaymentResponse(value) {
  return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));
}

test('buildDownloadPaymentResponse keeps delivery payload aligned across success paths', () => {
  const payload = buildDownloadPaymentResponse({
    assetId: 'the-rock-v1',
    assetType: 'soul',
    entitlementSource: 'purchase',
    fileName: 'SOUL.md',
    transaction: '0x' + '12'.repeat(32)
  });

  assert.equal(payload.success, true);
  assert.equal(payload.assetDelivered, 'the-rock-v1');
  assert.equal(payload.soulDelivered, 'the-rock-v1');
  assert.equal(payload.blockchain_transaction, '0x' + '12'.repeat(32));
  assert.equal(payload.entitlementSource, 'purchase');
});

test('applySuccessfulAssetDelivery emits receipt, session cookie, and normalized PAYMENT-RESPONSE', async () => {
  const priorSecret = process.env.PURCHASE_RECEIPT_SECRET;
  process.env.PURCHASE_RECEIPT_SECRET = 'test-secret';

  try {
    const res = makeMockResponse();
    const delivery = {
      assetType: 'soul',
      fileName: 'SOUL.md',
      downloadFileName: 'the-rock-v1-SOUL.md'
    };

    applySuccessfulAssetDelivery({
      res,
      content: '# paid content',
      delivery,
      assetId: 'the-rock-v1',
      wallet: '0xa7d395faf5e0a77a8d42d68ea01d2336671e5f55',
      transaction: '0x' + '34'.repeat(32),
      entitlementSource: 'purchase',
      strictAgentMode: false,
      reqHost: 'pull.md',
      includeReceipt: true,
      includeRedownloadSession: true
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '# paid content');
    assert.equal(res.getHeader('Content-Type'), 'text/markdown');
    assert.equal(res.getHeader('X-BLOCKCHAIN-TRANSACTION'), '0x' + '34'.repeat(32));
    assert.ok(res.getHeader('X-PURCHASE-RECEIPT'));
    assert.ok(res.getHeader('X-PURCHASE-RECEIPT-HINT'));
    assert.ok(Array.isArray(res.getHeader('Set-Cookie')));
    assert.equal(res.getHeader('Set-Cookie').length, 2);

    const paymentResponse = decodePaymentResponse(res.getHeader('PAYMENT-RESPONSE'));
    assert.equal(paymentResponse.transaction, '0x' + '34'.repeat(32));
    assert.equal(paymentResponse.blockchain_transaction, '0x' + '34'.repeat(32));
    assert.equal(paymentResponse.entitlementSource, 'purchase');
    assert.equal(paymentResponse.assetDelivered, 'the-rock-v1');
  } finally {
    if (typeof priorSecret === 'string') {
      process.env.PURCHASE_RECEIPT_SECRET = priorSecret;
    } else {
      delete process.env.PURCHASE_RECEIPT_SECRET;
    }
  }
});
