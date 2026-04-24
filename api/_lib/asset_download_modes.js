import { parseCookieHeader, purchaseReceiptCookieName } from './payments.js';

export function normalizeAssetTransferMethod(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'permit2') return 'permit2';
  if (raw === 'eip3009') return 'eip3009';
  return null;
}

export function resolveAssetTransferMethodForRequest(req, { strictAgentMode } = {}) {
  const explicit =
    normalizeAssetTransferMethod(req.headers['x-asset-transfer-method']) ||
    normalizeAssetTransferMethod(req.query?.asset_transfer_method);
  if (explicit) return { method: explicit, source: 'explicit' };

  if (strictAgentMode) {
    return { method: 'eip3009', source: 'strict_agent_default' };
  }
  return { method: null, source: 'default' };
}

export function classifyRedownloadHeaders({ headers = {}, cookieHeader = '', assetId = '', soulId = '' } = {}) {
  const cookies = parseCookieHeader(cookieHeader);
  const resolvedAssetId = String(assetId || soulId || '').trim();
  const wallet = headers['x-wallet-address'];
  const authSignature = headers['x-auth-signature'];
  const authTimestamp = headers['x-auth-timestamp'];
  const redownloadSignature = headers['x-redownload-signature'];
  const redownloadTimestamp = headers['x-redownload-timestamp'];
  const blockchainTransaction = headers['x-blockchain-transaction'] || headers['x-settlement-transaction'] || null;
  const receiptCookie = cookies[purchaseReceiptCookieName(resolvedAssetId)] || null;
  const receipt = headers['x-purchase-receipt'] || null;
  const redownloadSessionToken = headers['x-redownload-session'] || null;
  const paymentSignature = headers['payment-signature'] || headers['PAYMENT-SIGNATURE'];
  const legacyPaymentHeader = headers.payment || headers['x-payment'] || headers['PAYMENT'] || headers['X-PAYMENT'];

  const hasAnyRedownloadHeaders = Boolean(
    (wallet && receipt) ||
      (wallet && redownloadSessionToken) ||
      (wallet && authSignature) ||
      (wallet && authTimestamp) ||
      (wallet && blockchainTransaction) ||
      (wallet && redownloadSignature) ||
      (wallet && redownloadTimestamp)
  );
  const hasReceiptRedownloadHeaders = Boolean(wallet && receipt);
  const hasTransactionRedownloadHeaders = Boolean(wallet && blockchainTransaction && !receipt);
  const hasSessionRecoveryHeaders = Boolean(wallet && !receipt && redownloadSessionToken && !authSignature && !authTimestamp);
  const hasSignedRecoveryHeaders = Boolean(wallet && !receipt && authSignature && authTimestamp);
  const hasAgentRedownloadChallengeHeaders = Boolean(wallet && redownloadSignature && redownloadTimestamp);
  const hasAnyValidEntitlementHeaders =
    hasReceiptRedownloadHeaders || hasTransactionRedownloadHeaders || hasSessionRecoveryHeaders || hasSignedRecoveryHeaders;

  let mode = 'none';
  if (hasReceiptRedownloadHeaders) mode = 'agent_primary_receipt';
  else if (hasTransactionRedownloadHeaders) mode = 'transaction_reference';
  else if (hasSessionRecoveryHeaders) mode = 'human_recovery_session';
  else if (hasSignedRecoveryHeaders) mode = 'human_recovery_signed';
  else if (hasAnyRedownloadHeaders) mode = 'invalid';

  return {
    wallet,
    authSignature,
    authTimestamp,
    redownloadSignature,
    redownloadTimestamp,
    blockchainTransaction,
    receipt,
    receiptCookie,
    redownloadSessionToken,
    paymentSignature,
    legacyPaymentHeader,
    hasAnyRedownloadHeaders,
    hasReceiptRedownloadHeaders,
    hasTransactionRedownloadHeaders,
    hasSessionRecoveryHeaders,
    hasSignedRecoveryHeaders,
    hasAgentRedownloadChallengeHeaders,
    hasAnyValidEntitlementHeaders,
    mode
  };
}

export function classifyClientMode({ headers = {}, query = {} } = {}) {
  const rawMode = String(headers['x-client-mode'] || query.client_mode || '')
    .trim()
    .toLowerCase();
  const strictAgentMode = rawMode === 'agent' || rawMode === 'headless-agent' || rawMode === 'strict-agent';
  return { rawMode, strictAgentMode };
}
