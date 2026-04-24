import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

import { normalizeTransactionHash, verifyBlockchainEntitlementReceipt } from '../api/_lib/blockchain_receipts.js';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SELLER = '0x7F46aCB709cd8DF5879F84915CA431fB740989E4';
const BUYER = '0xa7d395faf5e0a77a8d42d68ea01d2336671e5f55';
const TRANSFER_IFACE = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);

function buildTransferLog({ from, to, value }) {
  const event = TRANSFER_IFACE.getEvent('Transfer');
  const encoded = TRANSFER_IFACE.encodeEventLog(event, [from, to, value]);
  return {
    address: BASE_USDC,
    topics: encoded.topics,
    data: encoded.data,
    index: 7
  };
}

test('normalizeTransactionHash accepts canonical transaction hashes only', () => {
  assert.equal(normalizeTransactionHash('0x' + 'ab'.repeat(32)), '0x' + 'ab'.repeat(32));
  assert.equal(normalizeTransactionHash('0x1234'), '');
  assert.equal(normalizeTransactionHash('not-a-hash'), '');
});

test('verifyBlockchainEntitlementReceipt validates matching USDC transfer in successful receipt', async () => {
  const txHash = '0x' + '12'.repeat(32);
  const provider = {
    getTransactionReceipt: async () => ({
      hash: txHash,
      status: 1,
      blockNumber: 123,
      logs: [buildTransferLog({ from: BUYER, to: SELLER, value: '1000000' })]
    })
  };

  const result = await verifyBlockchainEntitlementReceipt({
    transactionHash: txHash,
    walletAddress: BUYER,
    sellerAddress: SELLER,
    minAmount: '1000000',
    provider
  });

  assert.equal(result.ok, true);
  assert.equal(result.transaction, txHash);
  assert.equal(result.transfer?.from, BUYER);
  assert.equal(result.transfer?.to, SELLER.toLowerCase());
  assert.equal(result.transfer?.value, '1000000');
});

test('verifyBlockchainEntitlementReceipt rejects receipts without matching seller transfer', async () => {
  const txHash = '0x' + '34'.repeat(32);
  const provider = {
    getTransactionReceipt: async () => ({
      hash: txHash,
      status: 1,
      blockNumber: 456,
      logs: [buildTransferLog({ from: BUYER, to: '0x1111111111111111111111111111111111111111', value: '1000000' })]
    })
  };

  const result = await verifyBlockchainEntitlementReceipt({
    transactionHash: txHash,
    walletAddress: BUYER,
    sellerAddress: SELLER,
    minAmount: '1000000',
    provider
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'transaction_receipt_no_matching_transfer');
});
