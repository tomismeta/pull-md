import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SELLER = '0x7F46aCB709cd8DF5879F84915CA431fB740989E4';

function encodeHeader(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

function decodePaymentSignatureHeader(value) {
  return JSON.parse(Buffer.from(String(value), 'base64').toString('utf8'));
}

function stripEip712Domain(types) {
  const out = {};
  for (const [key, value] of Object.entries(types || {})) {
    if (key === 'EIP712Domain') continue;
    out[key] = value;
  }
  return out;
}

function makePaymentRequired({ accepts }) {
  return {
    x402Version: 2,
    error: 'Payment required',
    resource: {
      url: 'https://soulstarter.vercel.app/api/souls/the-rock-v1/download',
      description: 'Soul purchase for the-rock-v1',
      mimeType: 'text/markdown'
    },
    accepts
  };
}

function makeAccept({ method = 'eip3009', amount = '10000' } = {}) {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    amount,
    asset: BASE_USDC,
    payTo: SELLER,
    maxTimeoutSeconds: 300,
    extra: {
      name: 'USD Coin',
      version: '2',
      assetTransferMethod: method
    }
  };
}

test('x402 SDK fetch wrapper performs 402 -> sign -> retry and preserves settlement response', async () => {
  const wallet = ethers.Wallet.createRandom();
  const signer = toClientEvmSigner({
    address: wallet.address,
    signTypedData: async ({ domain, types, message }) =>
      wallet.signTypedData(domain || {}, stripEip712Domain(types), message || {})
  });

  const paymentRequired = makePaymentRequired({ accepts: [makeAccept({ method: 'eip3009' })] });
  const paymentResponse = {
    success: true,
    transaction: '0x' + '12'.repeat(32),
    network: 'eip155:8453'
  };

  const calls = [];
  const mockFetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push(request);
    if (calls.length === 1) {
      return new Response(JSON.stringify({ error: 'Payment required' }), {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'PAYMENT-REQUIRED': encodeHeader(paymentRequired)
        }
      });
    }
    return new Response('# SOUL.md', {
      status: 200,
      headers: {
        'content-type': 'text/markdown',
        'PAYMENT-RESPONSE': encodeHeader(paymentResponse)
      }
    });
  };

  const paidFetch = wrapFetchWithPaymentFromConfig(mockFetch, {
    schemes: [{ network: 'eip155:*', client: new ExactEvmScheme(signer) }]
  });

  const response = await paidFetch('https://soulstarter.vercel.app/api/souls/the-rock-v1/download', {
    method: 'GET',
    headers: {
      'X-WALLET-ADDRESS': wallet.address.toLowerCase(),
      'X-ASSET-TRANSFER-METHOD': 'eip3009'
    }
  });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);

  const second = calls[1];
  const paymentSignature = second.headers.get('PAYMENT-SIGNATURE');
  assert.ok(paymentSignature, 'PAYMENT-SIGNATURE should be set on paid retry');
  const paymentPayload = decodePaymentSignatureHeader(paymentSignature);
  assert.equal(paymentPayload.x402Version, 2);
  assert.equal(paymentPayload.accepted?.extra?.assetTransferMethod, 'eip3009');
  assert.ok(paymentPayload.payload?.authorization);
  assert.ok(paymentPayload.payload?.signature);
  assert.equal(paymentPayload.payload?.permit2Authorization, undefined);

  const decodedSettlement = decodePaymentResponseHeader(response.headers.get('PAYMENT-RESPONSE'));
  assert.equal(decodedSettlement?.success, true);
  assert.equal(decodedSettlement?.transaction, paymentResponse.transaction);
});

test('x402 SDK selector enforces eip3009 default when multiple methods are offered', async () => {
  const wallet = ethers.Wallet.createRandom();
  const signer = toClientEvmSigner({
    address: wallet.address,
    signTypedData: async ({ domain, types, message }) =>
      wallet.signTypedData(domain || {}, stripEip712Domain(types), message || {})
  });

  const paymentRequired = makePaymentRequired({
    accepts: [makeAccept({ method: 'permit2', amount: '15000' }), makeAccept({ method: 'eip3009', amount: '10000' })]
  });

  const calls = [];
  const mockFetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push(request);
    if (calls.length === 1) {
      return new Response(JSON.stringify({ error: 'Payment required' }), {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'PAYMENT-REQUIRED': encodeHeader(paymentRequired)
        }
      });
    }
    return new Response('# SOUL.md', { status: 200, headers: { 'content-type': 'text/markdown' } });
  };

  const paidFetch = wrapFetchWithPaymentFromConfig(mockFetch, {
    schemes: [{ network: 'eip155:*', client: new ExactEvmScheme(signer) }],
    paymentRequirementsSelector: (_version, accepts) => {
      const selected = (accepts || []).find(
        (option) => String(option?.extra?.assetTransferMethod || 'eip3009').toLowerCase() === 'eip3009'
      );
      if (!selected) throw new Error('No eip3009 payment option available');
      return selected;
    }
  });

  const response = await paidFetch('https://soulstarter.vercel.app/api/souls/the-rock-v1/download', {
    method: 'GET',
    headers: {
      'X-WALLET-ADDRESS': wallet.address.toLowerCase()
    }
  });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  const paymentPayload = decodePaymentSignatureHeader(calls[1].headers.get('PAYMENT-SIGNATURE'));
  assert.equal(paymentPayload.accepted?.extra?.assetTransferMethod, 'eip3009');
});

