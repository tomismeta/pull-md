import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

import {
  canonicalizeSubmittedPayment,
  getTransferMethodFromSubmittedPayment,
  normalizeAssetTransferMethod,
  resolveAssetTransferMethodForRequest,
  validatePaymentPayloadContract
} from '../api/souls/[id]/download.js';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SELLER = '0x7F46aCB709cd8DF5879F84915CA431fB740989E4';

function makePaymentRequirements(overrides = {}) {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '10000',
    asset: BASE_USDC,
    payTo: SELLER,
    extra: {
      name: 'USD Coin',
      version: '2',
      assetTransferMethod: 'eip3009'
    },
    ...overrides
  };
}

test('normalizeAssetTransferMethod recognizes only eip3009 and permit2', () => {
  assert.equal(normalizeAssetTransferMethod('eip3009'), 'eip3009');
  assert.equal(normalizeAssetTransferMethod('PERMIT2'), 'permit2');
  assert.equal(normalizeAssetTransferMethod('unknown'), null);
});

test('strict agent transfer method defaults to eip3009 unless explicitly overridden', () => {
  const strictDefault = resolveAssetTransferMethodForRequest(
    { headers: {}, query: {} },
    { strictAgentMode: true }
  );
  assert.deepEqual(strictDefault, { method: 'eip3009', source: 'strict_agent_default' });

  const explicitPermit2 = resolveAssetTransferMethodForRequest(
    { headers: { 'x-asset-transfer-method': 'permit2' }, query: {} },
    { strictAgentMode: true }
  );
  assert.deepEqual(explicitPermit2, { method: 'permit2', source: 'explicit' });

  const nonStrictDefault = resolveAssetTransferMethodForRequest(
    { headers: {}, query: {} },
    { strictAgentMode: false }
  );
  assert.deepEqual(nonStrictDefault, { method: null, source: 'default' });
});

test('getTransferMethodFromSubmittedPayment resolves branch deterministically', () => {
  assert.equal(
    getTransferMethodFromSubmittedPayment({
      accepted: { extra: { assetTransferMethod: 'permit2' } },
      payload: { authorization: {}, signature: '0xabc' }
    }),
    'permit2'
  );
  assert.equal(
    getTransferMethodFromSubmittedPayment({
      payload: { permit2Authorization: { from: '0xabc' } }
    }),
    'permit2'
  );
  assert.equal(
    getTransferMethodFromSubmittedPayment({
      payload: { authorization: { from: '0xabc' }, signature: '0xabc' }
    }),
    'eip3009'
  );
});

test('canonicalizeSubmittedPayment normalizes malformed eip3009 nested signature', () => {
  const submitted = {
    x402Version: 2,
    payload: {
      scheme: 'exact',
      network: 'eip155:8453',
      authorization: {
        from: '0x123',
        signature: '0xdeadbeef'
      },
      permit2Authorization: { bad: true },
      transaction: { bad: true }
    }
  };
  const canonical = canonicalizeSubmittedPayment(submitted);
  assert.equal(canonical.scheme, 'exact');
  assert.equal(canonical.network, 'eip155:8453');
  assert.equal(canonical.payload.signature, '0xdeadbeef');
  assert.equal(canonical.payload.authorization.signature, undefined);
  assert.equal(canonical.payload.permit2Authorization, undefined);
  assert.equal(canonical.payload.transaction, undefined);
});

test('canonicalizeSubmittedPayment normalizes malformed permit2 alias field', () => {
  const submitted = {
    accepted: { extra: { assetTransferMethod: 'permit2' } },
    payload: {
      permit2: { from: '0xabc' },
      authorization: { should: 'drop' },
      signature: '0xsig'
    }
  };
  const canonical = canonicalizeSubmittedPayment(submitted);
  assert.deepEqual(canonical.payload.permit2Authorization, { from: '0xabc' });
  assert.equal(canonical.payload.permit2, undefined);
  assert.equal(canonical.payload.authorization, undefined);
});

test('validatePaymentPayloadContract rejects missing payload object', () => {
  const result = validatePaymentPayloadContract({
    paymentPayload: {},
    paymentRequirements: makePaymentRequirements()
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_payload_object');
});

test('validatePaymentPayloadContract rejects eip3009 signature nested under authorization', () => {
  const result = validatePaymentPayloadContract({
    paymentPayload: {
      payload: {
        authorization: {
          from: '0xa7d395faf5e0a77a8d42d68ea01d2336671e5f55',
          to: SELLER,
          value: '10000',
          validAfter: '1',
          validBefore: '2',
          nonce: '0x' + '11'.repeat(32),
          signature: '0x' + '22'.repeat(65)
        }
      }
    },
    paymentRequirements: makePaymentRequirements()
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_eip3009_payload_shape');
});

test('validatePaymentPayloadContract accepts valid eip3009 signature shape', async () => {
  const wallet = ethers.Wallet.createRandom();
  const authorization = {
    from: wallet.address,
    to: SELLER,
    value: '10000',
    validAfter: '1',
    validBefore: String(Math.floor(Date.now() / 1000) + 300),
    nonce: '0x' + 'ab'.repeat(32)
  };
  const domain = {
    name: 'USD Coin',
    version: '2',
    chainId: 8453,
    verifyingContract: BASE_USDC
  };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' }
    ]
  };
  const signature = await wallet.signTypedData(domain, types, authorization);
  const result = validatePaymentPayloadContract({
    paymentPayload: {
      payload: {
        authorization,
        signature
      }
    },
    paymentRequirements: makePaymentRequirements()
  });
  assert.equal(result.ok, true);
});

test('validatePaymentPayloadContract rejects signer mismatch for eip3009', async () => {
  const signerWallet = ethers.Wallet.createRandom();
  const claimedWallet = ethers.Wallet.createRandom();
  const authorization = {
    from: claimedWallet.address,
    to: SELLER,
    value: '10000',
    validAfter: '1',
    validBefore: String(Math.floor(Date.now() / 1000) + 300),
    nonce: '0x' + 'cd'.repeat(32)
  };
  const domain = {
    name: 'USD Coin',
    version: '2',
    chainId: 8453,
    verifyingContract: BASE_USDC
  };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' }
    ]
  };
  const signature = await signerWallet.signTypedData(domain, types, authorization);
  const result = validatePaymentPayloadContract({
    paymentPayload: {
      payload: {
        authorization,
        signature
      }
    },
    paymentRequirements: makePaymentRequirements()
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'signature_authorizer_mismatch');
});

