import { ethers } from 'ethers';

const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_CHAIN_ID = 8453;
const TRANSFER_IFACE = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

let receiptProvider = null;

function receiptRpcUrl() {
  return (
    String(process.env.BASE_RPC_URL || '').trim() ||
    String(process.env.AUTH_RPC_URL || '').trim() ||
    String(process.env.RPC_URL || '').trim() ||
    'https://mainnet.base.org'
  );
}

function getReceiptProvider() {
  if (receiptProvider) return receiptProvider;
  receiptProvider = new ethers.JsonRpcProvider(receiptRpcUrl(), BASE_CHAIN_ID);
  return receiptProvider;
}

function normalizeWalletAddress(value) {
  const wallet = String(value || '').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/i.test(wallet) ? wallet : '';
}

export function normalizeTransactionHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  return /^0x[a-f0-9]{64}$/i.test(hash) ? hash : '';
}

function normalizeAmount(value) {
  try {
    return BigInt(String(value || '0'));
  } catch (_) {
    return 0n;
  }
}

export function isTransactionHash(value) {
  return Boolean(normalizeTransactionHash(value));
}

export async function verifyBlockchainEntitlementReceipt({
  transactionHash,
  walletAddress,
  sellerAddress,
  minAmount,
  assetContract = BASE_MAINNET_USDC,
  provider = null
} = {}) {
  const txHash = normalizeTransactionHash(transactionHash);
  const wallet = normalizeWalletAddress(walletAddress);
  const seller = normalizeWalletAddress(sellerAddress);
  const asset = normalizeWalletAddress(assetContract);
  const requiredAmount = normalizeAmount(minAmount);

  if (!txHash) {
    return { ok: false, code: 'invalid_transaction_hash', error: 'Invalid blockchain transaction hash' };
  }
  if (!wallet) {
    return { ok: false, code: 'invalid_wallet_address', error: 'Invalid wallet address for blockchain receipt check' };
  }
  if (!seller) {
    return { ok: false, code: 'invalid_seller_address', error: 'Invalid seller address for blockchain receipt check' };
  }
  if (!asset) {
    return { ok: false, code: 'invalid_asset_contract', error: 'Invalid asset contract for blockchain receipt check' };
  }
  if (requiredAmount <= 0n) {
    return { ok: false, code: 'invalid_required_amount', error: 'Invalid minimum amount for blockchain receipt check' };
  }

  const rpc = provider || getReceiptProvider();
  let receipt;
  try {
    receipt = await rpc.getTransactionReceipt(txHash);
  } catch (error) {
    return {
      ok: false,
      code: 'transaction_receipt_lookup_failed',
      error: error instanceof Error ? error.message : String(error)
    };
  }

  if (!receipt) {
    return { ok: false, code: 'transaction_receipt_not_found', error: 'Transaction receipt not found on Base' };
  }
  if (Number(receipt.status) !== 1) {
    return {
      ok: false,
      code: 'transaction_receipt_failed',
      error: 'Transaction receipt exists but status is not successful',
      receipt: {
        transaction_hash: receipt.hash || receipt.transactionHash || txHash,
        block_number: receipt.blockNumber ?? null,
        status: receipt.status ?? null
      }
    };
  }

  const matchingLog = (receipt.logs || []).find((log) => {
    if (String(log?.address || '').toLowerCase() !== asset) return false;
    if (!Array.isArray(log?.topics) || log.topics[0] !== TRANSFER_TOPIC) return false;
    try {
      const parsed = TRANSFER_IFACE.decodeEventLog('Transfer', log.data, log.topics);
      const from = normalizeWalletAddress(parsed.from);
      const to = normalizeWalletAddress(parsed.to);
      const value = normalizeAmount(parsed.value);
      return from === wallet && to === seller && value >= requiredAmount;
    } catch (_) {
      return false;
    }
  });

  if (!matchingLog) {
    return {
      ok: false,
      code: 'transaction_receipt_no_matching_transfer',
      error: 'Transaction receipt does not contain the expected USDC transfer'
    };
  }

  const parsed = TRANSFER_IFACE.decodeEventLog('Transfer', matchingLog.data, matchingLog.topics);
  return {
    ok: true,
    transaction: txHash,
    network: `eip155:${BASE_CHAIN_ID}`,
    receipt: {
      transaction_hash: receipt.hash || receipt.transactionHash || txHash,
      block_number: receipt.blockNumber ?? null,
      status: receipt.status ?? null
    },
    transfer: {
      asset: asset,
      from: normalizeWalletAddress(parsed.from),
      to: normalizeWalletAddress(parsed.to),
      value: normalizeAmount(parsed.value).toString(),
      log_index: matchingLog.index ?? matchingLog.logIndex ?? null
    }
  };
}
