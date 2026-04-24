import { isTransactionHash, normalizeTransactionHash } from './blockchain_receipts.js';
import { PURCHASE_RECEIPT_SECURITY_HINT } from './asset_download_x402.js';
import {
  buildPurchaseReceiptSetCookie,
  buildRedownloadSessionSetCookie,
  createPurchaseReceipt,
  createRedownloadSessionToken
} from './payments.js';

function appendSetCookieHeader(res, cookieValue) {
  if (!cookieValue) return;
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookieValue);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieValue]);
    return;
  }
  res.setHeader('Set-Cookie', [existing, cookieValue]);
}

export function setPurchaseReceiptSecurityHintHeader(res) {
  res.setHeader('X-PURCHASE-RECEIPT-HINT', PURCHASE_RECEIPT_SECURITY_HINT);
}

export function setBlockchainTransactionHeader(res, transaction) {
  if (!isTransactionHash(transaction)) return;
  res.setHeader('X-BLOCKCHAIN-TRANSACTION', normalizeTransactionHash(transaction));
}

export function buildDownloadPaymentResponse({
  assetId,
  assetType,
  entitlementSource,
  fileName,
  transaction
}) {
  return {
    success: true,
    transaction: transaction || null,
    blockchain_transaction: isTransactionHash(transaction) ? normalizeTransactionHash(transaction) : null,
    network: 'eip155:8453',
    soulDelivered: assetId,
    assetDelivered: assetId,
    assetType,
    fileName,
    entitlementSource,
    purchase_receipt_security_hint: PURCHASE_RECEIPT_SECURITY_HINT
  };
}

export function setPaymentResponseHeader(res, payload) {
  res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(payload)).toString('base64'));
}

function issuePurchaseReceipt({
  res,
  assetId,
  reqHost,
  strictAgentMode,
  transaction,
  wallet
}) {
  if (!wallet) return null;
  try {
    const receiptToken = createPurchaseReceipt({
      wallet,
      assetId,
      transaction
    });
    setPurchaseReceiptSecurityHintHeader(res);
    res.setHeader('X-PURCHASE-RECEIPT', receiptToken);
    if (!strictAgentMode) {
      appendSetCookieHeader(
        res,
        buildPurchaseReceiptSetCookie({ assetId, receipt: receiptToken, reqHost })
      );
    }
    return receiptToken;
  } catch (_) {
    return null;
  }
}

function issueRedownloadSession({ res, reqHost, strictAgentMode, wallet }) {
  if (!wallet || strictAgentMode) return null;
  try {
    const sessionToken = createRedownloadSessionToken({ wallet });
    appendSetCookieHeader(res, buildRedownloadSessionSetCookie({ token: sessionToken, reqHost }));
    return sessionToken;
  } catch (_) {
    return null;
  }
}

export function applySuccessfulAssetDelivery({
  res,
  content,
  delivery,
  assetId,
  wallet,
  transaction,
  entitlementSource,
  strictAgentMode,
  reqHost,
  includeReceipt = true,
  includeRedownloadSession = false
}) {
  if (includeReceipt) {
    issuePurchaseReceipt({
      res,
      assetId,
      reqHost,
      strictAgentMode,
      transaction,
      wallet
    });
  }
  if (includeRedownloadSession) {
    issueRedownloadSession({
      res,
      reqHost,
      strictAgentMode,
      wallet
    });
  }

  setPaymentResponseHeader(
    res,
    buildDownloadPaymentResponse({
      assetId,
      assetType: delivery.assetType,
      entitlementSource,
      fileName: delivery.fileName,
      transaction
    })
  );
  setBlockchainTransactionHeader(res, transaction);
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="${delivery.downloadFileName}"`);
  return res.status(200).send(content);
}
