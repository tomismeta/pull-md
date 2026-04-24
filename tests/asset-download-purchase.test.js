import test from 'node:test';
import assert from 'node:assert/strict';

import { handleAssetPurchaseRequest } from '../api/_lib/asset_download_purchase.js';

function encodeHeader(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

function decodeHeader(value) {
  return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));
}

function makeMockResponse() {
  const headers = new Map();
  return {
    headers,
    statusCode: null,
    body: null,
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
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    }
  };
}

function makeBaseArgs(overrides = {}) {
  return {
    asset: {
      id: 'the-rock-v1',
      priceMicroUsdc: '10000',
      priceDisplay: '0.01 USDC'
    },
    assetId: 'the-rock-v1',
    clientModeRaw: 'agent',
    delivery: {
      assetType: 'soul',
      fileName: 'SOUL.md',
      downloadFileName: 'the-rock-v1-SOUL.md'
    },
    hasAnyRedownloadHeaders: false,
    recordDownloadTelemetry: () => {},
    req: {
      headers: {
        host: 'pull.md',
        'x-wallet-address': '0xa7d395faf5e0a77a8d42d68ea01d2336671e5f55'
      }
    },
    res: makeMockResponse(),
    sellerAddress: '0x7F46aCB709cd8DF5879F84915CA431fB740989E4',
    siweIdentity: {
      domain: 'pull.md',
      uri: 'https://pull.md'
    },
    startMs: Date.now(),
    strictAgentMode: true,
    telemetryRoute: '/api/assets/{id}/download',
    wallet: '0xa7d395faf5e0a77a8d42d68ea01d2336671e5f55',
    walletHintForQuote: '0xa7d395faf5e0a77a8d42d68ea01d2336671e5f55',
    ...overrides
  };
}

test('handleAssetPurchaseRequest rejects paid retry when submitted transfer method mismatches quote', async () => {
  const req = {
    headers: {
      host: 'pull.md',
      'x-wallet-address': '0xa7d395faf5e0a77a8d42d68ea01d2336671e5f55',
      'payment-signature': encodeHeader({
        accepted: {
          extra: {
            assetTransferMethod: 'permit2'
          }
        }
      })
    }
  };
  const res = makeMockResponse();

  await handleAssetPurchaseRequest(
    makeBaseArgs({ req, res }),
    {
      createRequestContext: () => ({ paymentHeader: req.headers['payment-signature'] }),
      getX402HTTPServer: async () => {
        throw new Error('getX402HTTPServer should not be called on mismatch');
      },
      resolveAssetTransferMethodForRequest: async () => ({ method: 'eip3009', source: 'strict_agent_default' }),
      rewriteIncomingPaymentHeader: () => {}
    }
  );

  assert.equal(res.statusCode, 402);
  assert.equal(res.body?.code, 'x402_method_mismatch');
  assert.equal(res.body?.expected_transfer_method, 'eip3009');
  assert.equal(res.body?.submitted_transfer_method, 'permit2');
});

test('handleAssetPurchaseRequest shapes strict-agent paywall responses with redownload contract hints', async () => {
  const res = makeMockResponse();
  const paymentRequired = {
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '10000',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0x7F46aCB709cd8DF5879F84915CA431fB740989E4',
        maxTimeoutSeconds: 300,
        extra: {
          assetTransferMethod: 'eip3009',
          name: 'USD Coin',
          version: '2'
        }
      }
    ]
  };

  await handleAssetPurchaseRequest(
    makeBaseArgs({ res }),
    {
      createRequestContext: () => ({ paymentHeader: null }),
      getX402HTTPServer: async () => ({
        processHTTPRequest: async () => ({
          type: 'payment-error',
          response: {
            status: 402,
            headers: {
              'Content-Type': 'application/json',
              'PAYMENT-REQUIRED': encodeHeader(paymentRequired)
            },
            body: { error: 'Payment required' }
          }
        })
      }),
      resolveAssetTransferMethodForRequest: async () => ({ method: 'eip3009', source: 'strict_agent_default' }),
      rewriteIncomingPaymentHeader: () => {}
    }
  );

  assert.equal(res.statusCode, 402);
  assert.equal(res.body?.client_mode, 'agent');
  assert.equal(res.body?.transfer_method_selection?.method, 'eip3009');
  assert.deepEqual(res.body?.redownload_contract?.one_of, [['X-PURCHASE-RECEIPT'], ['X-BLOCKCHAIN-TRANSACTION']]);
  assert.ok(res.body?.payment_signing_instructions);
});

test('handleAssetPurchaseRequest returns normalized delivery contract for existing entitlements', async () => {
  const priorSecret = process.env.PURCHASE_RECEIPT_SECRET;
  process.env.PURCHASE_RECEIPT_SECRET = 'test-secret';

  try {
    const res = makeMockResponse();

    await handleAssetPurchaseRequest(
      makeBaseArgs({ res }),
      {
        createRequestContext: () => ({ paymentHeader: null }),
        getAssetEntitlement: async () => ({
          wallet_address: '0xa7d395faf5e0a77a8d42d68ea01d2336671e5f55',
          asset_id: 'the-rock-v1',
          transaction_ref: '0x' + '12'.repeat(32),
          source: 'entitlement_record'
        }),
        getPayerFromPaymentPayload: () => '0xa7d395faf5e0a77a8d42d68ea01d2336671e5f55',
        getX402HTTPServer: async () => ({
          processHTTPRequest: async () => ({
            type: 'payment-verified',
            paymentPayload: { payload: { authorization: { from: '0xa7d395faf5e0a77a8d42d68ea01d2336671e5f55' } } },
            paymentRequirements: {
              extra: {
                assetTransferMethod: 'eip3009'
              }
            }
          })
        }),
        loadAssetContent: async () => '# asset content',
        resolveAssetTransferMethodForRequest: async () => ({ method: 'eip3009', source: 'strict_agent_default' }),
        rewriteIncomingPaymentHeader: () => {},
        validatePaymentPayloadContract: () => ({ ok: true })
      }
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '# asset content');
    assert.ok(res.getHeader('X-PURCHASE-RECEIPT'));
    assert.equal(res.getHeader('X-BLOCKCHAIN-TRANSACTION'), '0x' + '12'.repeat(32));

    const paymentResponse = decodeHeader(res.getHeader('PAYMENT-RESPONSE'));
    assert.equal(paymentResponse.assetDelivered, 'the-rock-v1');
    assert.equal(paymentResponse.transaction, '0x' + '12'.repeat(32));
    assert.equal(paymentResponse.entitlementSource, 'entitlement_record');
  } finally {
    if (typeof priorSecret === 'string') {
      process.env.PURCHASE_RECEIPT_SECRET = priorSecret;
    } else {
      delete process.env.PURCHASE_RECEIPT_SECRET;
    }
  }
});
