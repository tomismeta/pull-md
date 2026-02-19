(function attachSoulStarterSiwe(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  function getWalletCommon() {
    const helper = globalScope.SoulStarterWalletCommon;
    if (!helper || typeof helper.sha256Hex !== 'function') {
      throw new Error('Wallet common helper unavailable');
    }
    return helper;
  }

  async function createNonce(seed) {
    const digest = await getWalletCommon().sha256Hex(seed);
    return String(digest || '').slice(0, 16);
  }

  async function buildSoulActionMessage({
    domain,
    uri,
    chainId,
    wallet,
    soulId,
    action,
    timestamp
  }) {
    const ts = Number(timestamp);
    const normalizedSoulId = String(soulId || '*');
    const normalizedAction = String(action || '');
    const nonceSeed = `${normalizedSoulId}|${normalizedAction}|${String(ts)}`;
    const nonce = await createNonce(nonceSeed);
    return [
      `${String(domain || '')} wants you to sign in with your Ethereum account:`,
      String(wallet || '').toLowerCase(),
      '',
      'Authenticate wallet ownership for PULL.md. No token transfer or approval.',
      '',
      `URI: ${String(uri || '')}`,
      'Version: 1',
      `Chain ID: ${String(chainId || '')}`,
      `Nonce: ${nonce}`,
      `Issued At: ${new Date(ts).toISOString()}`,
      `Expiration Time: ${new Date(ts + 5 * 60 * 1000).toISOString()}`,
      `Request ID: ${String(action || 'auth')}:${normalizedSoulId}`,
      'Resources:',
      `- urn:pullmd:action:${normalizedAction}`,
      `- urn:pullmd:asset:${normalizedSoulId}`
    ].join('\n');
  }

  async function buildScopedMessage({
    domain,
    uri,
    chainId,
    wallet,
    scope,
    action,
    timestamp
  }) {
    const ts = Number(timestamp);
    const normalizedScope = String(scope || '');
    const normalizedAction = String(action || '');
    const nonceSeed = `${normalizedScope}|${normalizedAction}|${String(ts)}`;
    const nonce = await createNonce(nonceSeed);
    return [
      `${String(domain || '')} wants you to sign in with your Ethereum account:`,
      String(wallet || '').toLowerCase(),
      '',
      'Authenticate wallet ownership for PULL.md. No token transfer or approval.',
      '',
      `URI: ${String(uri || '')}`,
      'Version: 1',
      `Chain ID: ${String(chainId || '')}`,
      `Nonce: ${nonce}`,
      `Issued At: ${new Date(ts).toISOString()}`,
      `Expiration Time: ${new Date(ts + 5 * 60 * 1000).toISOString()}`,
      `Request ID: ${String(action || normalizedScope)}:${normalizedScope}`,
      'Resources:',
      `- urn:pullmd:action:${normalizedAction}`,
      `- urn:pullmd:scope:${normalizedScope}`
    ].join('\n');
  }

  globalScope.SoulStarterSiwe = {
    buildSoulActionMessage,
    buildScopedMessage
  };
})(typeof window !== 'undefined' ? window : globalThis);
