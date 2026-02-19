(function attachPullMdX402Browser(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  const sdkModulePromiseByVersion = new Map();

  function normalizeAddress(address) {
    try {
      return ethers.getAddress(String(address || '').trim());
    } catch (_) {
      return null;
    }
  }

  function normalizeTypedDataTypesForEthers(types) {
    const source = types && typeof types === 'object' ? types : {};
    const result = {};
    for (const [key, value] of Object.entries(source)) {
      if (key === 'EIP712Domain') continue;
      result[key] = value;
    }
    return result;
  }

  async function loadSdkModules({
    fetchSdkVersion,
    evmSdkVersion
  } = {}) {
    const fetchVersion = String(fetchSdkVersion || '').trim();
    const evmVersion = String(evmSdkVersion || '').trim();
    if (!fetchVersion || !evmVersion) {
      throw new Error('Missing x402 SDK versions');
    }
    const cacheKey = `${fetchVersion}|${evmVersion}`;
    if (!sdkModulePromiseByVersion.has(cacheKey)) {
      sdkModulePromiseByVersion.set(
        cacheKey,
        Promise.all([
          import(`https://esm.sh/@x402/fetch@${fetchVersion}?bundle`),
          import(`https://esm.sh/@x402/evm@${evmVersion}?bundle`)
        ]).then(([fetchSdk, evmSdk]) => ({
          x402Client: fetchSdk.x402Client,
          x402HTTPClient: fetchSdk.x402HTTPClient,
          ExactEvmScheme: evmSdk.ExactEvmScheme,
          toClientEvmSigner: evmSdk.toClientEvmSigner
        }))
      );
    }
    return sdkModulePromiseByVersion.get(cacheKey);
  }

  function selectPaymentRequirement({
    accepts,
    expectedSeller,
    defaultExpectedSeller = null,
    preferredAssetTransferMethod = 'eip3009'
  } = {}) {
    const options = Array.isArray(accepts) ? accepts : [];
    if (options.length === 0) {
      throw new Error('No payment requirements available');
    }

    const expected = normalizeAddress(expectedSeller || defaultExpectedSeller);
    const sellerMatches = options.filter((option) => normalizeAddress(option?.payTo) === expected);
    if (expected && sellerMatches.length === 0) {
      throw new Error(
        `Security check failed: payment recipient mismatch. Expected ${expected}. Do not continue.`
      );
    }

    const method = String(preferredAssetTransferMethod || 'eip3009').trim().toLowerCase();
    const targetMethod = method === 'permit2' ? 'permit2' : 'eip3009';
    const candidates = sellerMatches.length ? sellerMatches : options;
    const preferredMatches = candidates.filter(
      (option) => String(option?.extra?.assetTransferMethod || 'eip3009').toLowerCase() === targetMethod
    );
    if (preferredMatches.length > 0) return preferredMatches[0];

    const availableMethods = [
      ...new Set(candidates.map((option) => String(option?.extra?.assetTransferMethod || 'eip3009').toLowerCase()))
    ];
    throw new Error(
      `No ${targetMethod} payment option available for this quote. Available methods: ${availableMethods.join(', ') || 'none'}.`
    );
  }

  async function createSdkEngine({
    wallet,
    signer,
    expectedSeller,
    defaultExpectedSeller = null,
    preferredAssetTransferMethod = 'eip3009',
    fetchSdkVersion,
    evmSdkVersion
  } = {}) {
    const activeWallet = String(wallet || '').trim();
    if (!activeWallet || !signer || typeof signer.signTypedData !== 'function') {
      throw new Error('Wallet signer is required');
    }

    const sdk = await loadSdkModules({ fetchSdkVersion, evmSdkVersion });
    const clientSigner = sdk.toClientEvmSigner({
      address: activeWallet,
      signTypedData: async ({ domain, types, message }) => {
        const normalizedTypes = normalizeTypedDataTypesForEthers(types);
        return signer.signTypedData(domain || {}, normalizedTypes, message || {});
      }
    });

    const paymentRequirementsSelector = (_version, accepts) =>
      selectPaymentRequirement({
        accepts,
        expectedSeller,
        defaultExpectedSeller,
        preferredAssetTransferMethod
      });

    const client = sdk.x402Client.fromConfig({
      schemes: [
        {
          network: 'eip155:*',
          client: new sdk.ExactEvmScheme(clientSigner)
        }
      ],
      paymentRequirementsSelector
    });

    return {
      client,
      httpClient: new sdk.x402HTTPClient(client)
    };
  }

  async function decodePaymentRequiredWithSdk(response, httpClient) {
    let body;
    try {
      const text = await response.clone().text();
      if (text) {
        body = JSON.parse(text);
      }
    } catch (_) {}
    return httpClient.getPaymentRequiredResponse((name) => response.headers.get(name), body);
  }

  async function createPaymentPayload({
    paymentRequired,
    expectedSeller,
    defaultExpectedSeller = null,
    preferredAssetTransferMethod = 'eip3009',
    engine = null,
    wallet,
    signer,
    fetchSdkVersion,
    evmSdkVersion
  } = {}) {
    if (!paymentRequired || paymentRequired.x402Version !== 2) {
      throw new Error('Unsupported x402 version');
    }
    const accepted = Array.isArray(paymentRequired.accepts) ? paymentRequired.accepts : [];
    if (accepted.length === 0) {
      throw new Error('No payment requirements available');
    }

    const selected = selectPaymentRequirement({
      accepts: accepted,
      expectedSeller,
      defaultExpectedSeller,
      preferredAssetTransferMethod
    });

    const activeEngine =
      engine ||
      (await createSdkEngine({
        wallet,
        signer,
        expectedSeller,
        defaultExpectedSeller,
        preferredAssetTransferMethod,
        fetchSdkVersion,
        evmSdkVersion
      }));

    const normalizedPaymentRequired = {
      ...paymentRequired,
      accepts: [selected]
    };

    const payload = await activeEngine.client.createPaymentPayload(normalizedPaymentRequired);
    return { payload, selected, engine: activeEngine };
  }

  globalScope.PullMdX402Browser = {
    normalizeAddress,
    loadSdkModules,
    selectPaymentRequirement,
    createSdkEngine,
    decodePaymentRequiredWithSdk,
    createPaymentPayload
  };
})(typeof window !== 'undefined' ? window : globalThis);
