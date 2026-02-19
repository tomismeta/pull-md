(function attachPullMdSettlementVerify(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  const DEFAULT_BASE_RPC_URL = 'https://mainnet.base.org';
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const transferInterface = new ethers.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const providerCache = new Map();

  function getBaseRpcProvider(rpcUrl = DEFAULT_BASE_RPC_URL) {
    const normalizedRpcUrl = String(rpcUrl || DEFAULT_BASE_RPC_URL).trim();
    if (!providerCache.has(normalizedRpcUrl)) {
      providerCache.set(normalizedRpcUrl, new ethers.JsonRpcProvider(normalizedRpcUrl));
    }
    return providerCache.get(normalizedRpcUrl);
  }

  function normalizeAddressLower(value) {
    try {
      return ethers.getAddress(String(value || '').trim()).toLowerCase();
    } catch (_) {
      return null;
    }
  }

  function parseBigInt(value) {
    try {
      if (value === null || value === undefined || value === '') return null;
      return BigInt(String(value));
    } catch (_) {
      return null;
    }
  }

  function isTransactionHash(value) {
    return /^0x[a-fA-F0-9]{64}$/.test(String(value || ''));
  }

  function formatMicroUsdc(value) {
    const amount = parseBigInt(value);
    if (amount === null) return '-';
    const whole = amount / 1000000n;
    const fractional = (amount % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
    return fractional ? `${whole}.${fractional} USDC` : `${whole} USDC`;
  }

  async function verifySettlementOnchain(txHash, expectedSettlement, { rpcUrl = DEFAULT_BASE_RPC_URL } = {}) {
    const expected = {
      token: normalizeAddressLower(expectedSettlement?.token),
      payTo: normalizeAddressLower(expectedSettlement?.payTo),
      payer: normalizeAddressLower(expectedSettlement?.payer),
      amount: parseBigInt(expectedSettlement?.amount),
      network: String(expectedSettlement?.network || '')
    };

    if (!isTransactionHash(txHash)) {
      return { verified: false, reason: 'Missing or invalid transaction hash.', expected };
    }

    if (expected.network && expected.network !== 'eip155:8453') {
      return { verified: false, reason: `Unexpected network: ${expected.network}`, expected };
    }

    const receipt = await getBaseRpcProvider(rpcUrl).getTransactionReceipt(txHash);
    if (!receipt) {
      return { verified: false, reason: 'Transaction receipt not found yet.', expected };
    }
    if (Number(receipt.status) !== 1) {
      return { verified: false, reason: 'Transaction reverted on-chain.', expected };
    }

    const transfers = [];
    for (const log of receipt.logs || []) {
      if (normalizeAddressLower(log.address) !== expected.token) continue;
      if (!Array.isArray(log.topics) || String(log.topics[0] || '').toLowerCase() !== transferTopic.toLowerCase()) continue;
      try {
        const parsed = transferInterface.parseLog(log);
        if (!parsed || parsed.name !== 'Transfer') continue;
        transfers.push({
          from: normalizeAddressLower(parsed.args.from),
          to: normalizeAddressLower(parsed.args.to),
          amount: parseBigInt(parsed.args.value)
        });
      } catch (_) {}
    }

    if (!transfers.length) {
      return { verified: false, reason: 'No USDC transfer log found for expected token in this transaction.', expected };
    }

    const exact = transfers.find((entry) => {
      if (!entry.from || !entry.to || entry.amount === null) return false;
      if (expected.payTo && entry.to !== expected.payTo) return false;
      if (expected.payer && entry.from !== expected.payer) return false;
      if (expected.amount !== null && entry.amount < expected.amount) return false;
      return true;
    });

    if (exact) {
      return { verified: true, expected, actual: exact };
    }

    const mismatch = [];
    const best = transfers[0];
    if (expected.payTo && !transfers.some((entry) => entry.to === expected.payTo)) mismatch.push('seller address mismatch');
    if (expected.payer && !transfers.some((entry) => entry.from === expected.payer)) mismatch.push('payer mismatch');
    if (expected.amount !== null && !transfers.some((entry) => entry.amount !== null && entry.amount >= expected.amount)) {
      mismatch.push('amount below expected value');
    }

    return {
      verified: false,
      expected,
      actual: best || null,
      reason: mismatch.length ? mismatch.join('; ') : 'Transfer log found but fields did not match expected payment details.'
    };
  }

  globalScope.PullMdSettlementVerify = {
    formatMicroUsdc,
    verifySettlementOnchain
  };
})(typeof window !== 'undefined' ? window : globalThis);
