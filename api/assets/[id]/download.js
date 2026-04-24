import { assetIdsResolved, getAssetResolved, loadAssetContent } from '../../_lib/catalog.js';
import {
  classifyClientMode,
  classifyRedownloadHeaders,
  normalizeAssetTransferMethod,
  resolveAssetTransferMethodForRequest
} from '../../_lib/asset_download_modes.js';
import { applySuccessfulAssetDelivery } from '../../_lib/asset_download_delivery.js';
import { handleAssetPurchaseRequest } from '../../_lib/asset_download_purchase.js';
import { resolveRedownloadEntitlement } from '../../_lib/asset_download_redownload.js';
import {
  getTransferMethodFromSubmittedPayment,
  PURCHASE_RECEIPT_SECURITY_HINT,
  validatePaymentPayloadContract
} from '../../_lib/asset_download_x402.js';
import { getSellerAddress, resolveSiweIdentity, setCors, verifyWalletAuth } from '../../_lib/payments.js';
import { buildSiweChallengeFields } from '../../_lib/siwe.js';
import { recordTelemetryEvent } from '../../_lib/telemetry.js';
import { setDiscoveryHeaders } from '../../_lib/discovery.js';

export {
  classifyClientMode,
  classifyRedownloadHeaders,
  normalizeAssetTransferMethod,
  resolveAssetTransferMethodForRequest
} from '../../_lib/asset_download_modes.js';
export {
  canonicalizeSubmittedPayment,
  getTransferMethodFromSubmittedPayment,
  validatePaymentPayloadContract
} from '../../_lib/asset_download_x402.js';

function recordDownloadTelemetry(event = {}) {
  void recordTelemetryEvent({
    source: 'download',
    eventType: event.eventType || 'download.request',
    route: event.route || '/api/assets/{id}/download',
    httpMethod: 'GET',
    action: event.action || null,
    walletAddress: event.walletAddress || null,
    assetId: event.assetId || null,
    assetType: event.assetType || null,
    success: typeof event.success === 'boolean' ? event.success : null,
    statusCode: event.statusCode ?? null,
    errorCode: event.errorCode || null,
    errorMessage: event.errorMessage || null,
    metadata: event.metadata || {}
  });
}

function normalizeDownloadFileName(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return 'SOUL.md';
  if (candidate.includes('/') || candidate.includes('\\')) return 'SOUL.md';
  if (!/^[A-Za-z0-9._-]+$/.test(candidate)) return 'SOUL.md';
  if (!/\.md$/i.test(candidate)) return 'SOUL.md';
  return candidate;
}

function normalizeAssetType(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  return normalized || 'soul';
}

function resolveDeliveryMetadata(asset, assetId) {
  const fileName = normalizeDownloadFileName(asset?.fileName || asset?.file_name || 'SOUL.md');
  return {
    assetType: normalizeAssetType(asset?.assetType || asset?.asset_type || 'soul'),
    fileName,
    downloadFileName: `${String(assetId || 'asset')}-${fileName}`
  };
}

function resolveSiweIdentityFromRequest(req) {
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').trim();
  const proto = String(req?.headers?.['x-forwarded-proto'] || 'https').trim();
  return resolveSiweIdentity({ host, proto });
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);
  setDiscoveryHeaders(res, req);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const telemetryRoute = '/api/assets/{id}/download';
  const startMs = Date.now();
  const siweIdentity = resolveSiweIdentityFromRequest(req);
  const assetId = req.query.id;
  const asset = await getAssetResolved(assetId);
  if (!asset) {
    const availableIds = await assetIdsResolved();
    recordDownloadTelemetry({
      eventType: 'download.not_found',
      route: telemetryRoute,
      assetId,
      success: false,
      statusCode: 404,
      errorCode: 'asset_not_found'
    });
    return res.status(404).json({
      error: 'Asset not found',
      available_assets: availableIds,
      available_souls: availableIds
    });
  }

  const delivery = resolveDeliveryMetadata(asset, assetId);
  const sellerAddress = asset.sellerAddress || getSellerAddress();
  if (!sellerAddress) {
    recordDownloadTelemetry({
      eventType: 'download.config_error',
      route: telemetryRoute,
      assetId,
      assetType: delivery.assetType,
      success: false,
      statusCode: 500,
      errorCode: 'missing_seller_address'
    });
    return res.status(500).json({ error: 'Server configuration error: SELLER_ADDRESS is required' });
  }

  const { rawMode: clientModeRaw, strictAgentMode } = classifyClientMode({ headers: req.headers, query: req.query });
  const walletHintForQuote = String(req.headers['x-wallet-address'] || req.query?.wallet_address || '').trim();
  const {
    wallet,
    authSignature,
    authTimestamp,
    redownloadSignature,
    redownloadTimestamp,
    blockchainTransaction,
    receipt,
    redownloadSessionToken,
    paymentSignature,
    legacyPaymentHeader,
    hasAnyRedownloadHeaders,
    hasReceiptRedownloadHeaders,
    hasTransactionRedownloadHeaders,
    hasSessionRecoveryHeaders,
    hasSignedRecoveryHeaders,
    hasAgentRedownloadChallengeHeaders,
    hasAnyValidEntitlementHeaders
  } = classifyRedownloadHeaders({
    headers: req.headers,
    cookieHeader: req.headers.cookie,
    assetId
  });

  if (legacyPaymentHeader) {
    return res.status(410).json({
      error: 'Deprecated payment header',
      code: 'deprecated_payment_header',
      flow_hint:
        'PAYMENT and X-PAYMENT are no longer supported. Use PAYMENT-SIGNATURE with base64-encoded JSON x402 payload.',
      required_header: 'PAYMENT-SIGNATURE'
    });
  }

  if (strictAgentMode) {
    if (!paymentSignature && !hasAnyRedownloadHeaders && !walletHintForQuote) {
      return res.status(400).json({
        error: 'Wallet hint required for strict agent purchase quote',
        code: 'agent_wallet_hint_required',
        flow_hint:
          'Strict agent purchase quotes require X-WALLET-ADDRESS (or wallet_address query) so server can select the correct transfer method.',
        required_headers: ['X-CLIENT-MODE: agent', 'X-WALLET-ADDRESS'],
        optional_headers: ['X-ASSET-TRANSFER-METHOD']
      });
    }
    if (paymentSignature && !hasAnyRedownloadHeaders && !walletHintForQuote) {
      return res.status(400).json({
        error: 'Wallet hint required for strict agent paid retry',
        code: 'agent_wallet_hint_required_paid_retry',
        flow_hint:
          'Strict agent paid retries require X-WALLET-ADDRESS (or wallet_address query) to avoid transfer-method mismatches.',
        required_headers: ['X-CLIENT-MODE: agent', 'X-WALLET-ADDRESS', 'PAYMENT-SIGNATURE'],
        optional_headers: ['X-ASSET-TRANSFER-METHOD']
      });
    }
    if (hasSessionRecoveryHeaders || hasSignedRecoveryHeaders) {
      return res.status(400).json({
        error: 'Unsupported headers for strict agent mode',
        code: 'agent_mode_disallows_session_auth',
        client_mode: clientModeRaw || 'agent',
        flow_hint:
          'Strict agent mode requires receipt or blockchain transaction reference plus wallet signature challenge for redownload.',
        required_headers: ['X-WALLET-ADDRESS', 'X-REDOWNLOAD-SIGNATURE', 'X-REDOWNLOAD-TIMESTAMP'],
        one_of: [['X-PURCHASE-RECEIPT'], ['X-BLOCKCHAIN-TRANSACTION']],
        disallowed_headers: ['X-REDOWNLOAD-SESSION', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP']
      });
    }
    if ((hasReceiptRedownloadHeaders || hasTransactionRedownloadHeaders) && !hasAgentRedownloadChallengeHeaders) {
      recordDownloadTelemetry({
        eventType: 'redownload.failed',
        route: telemetryRoute,
        action: 'redownload',
        walletAddress: wallet,
        assetId,
        assetType: delivery.assetType,
        success: false,
        statusCode: 401,
        errorCode: 'agent_redownload_signature_required'
      });
      return res.status(401).json({
        error: 'Wallet signature required for strict agent redownload',
        code: 'agent_redownload_signature_required',
        client_mode: clientModeRaw || 'agent',
        flow_hint:
          'Strict agent redownload now requires proof-of-wallet-control: send X-REDOWNLOAD-SIGNATURE + X-REDOWNLOAD-TIMESTAMP with X-WALLET-ADDRESS plus either X-PURCHASE-RECEIPT or X-BLOCKCHAIN-TRANSACTION.',
        required_headers: ['X-WALLET-ADDRESS', 'X-REDOWNLOAD-SIGNATURE', 'X-REDOWNLOAD-TIMESTAMP'],
        one_of: [['X-PURCHASE-RECEIPT'], ['X-BLOCKCHAIN-TRANSACTION']],
        ...buildSiweChallengeFields({
          wallet: wallet || '0x<your-wallet>',
          soulId: assetId,
          action: 'redownload',
          siweIdentity
        })
      });
    }
    if (hasReceiptRedownloadHeaders && hasAgentRedownloadChallengeHeaders) {
      const verify = await verifyWalletAuth({
        wallet,
        soulId: assetId,
        action: 'redownload',
        timestamp: redownloadTimestamp,
        signature: redownloadSignature,
        domain: siweIdentity.domain,
        uri: siweIdentity.uri
      });
      if (!verify.ok) {
        recordDownloadTelemetry({
          eventType: 'redownload.failed',
          route: telemetryRoute,
          action: 'redownload',
          walletAddress: wallet,
          assetId,
          assetType: delivery.assetType,
          success: false,
          statusCode: 401,
          errorCode: 'invalid_agent_redownload_signature'
        });
        return res.status(401).json({
          error: 'Invalid strict agent redownload signature',
          code: 'invalid_agent_redownload_signature',
          flow_hint: 'Re-sign the redownload auth message with the same wallet and retry.',
          required_headers: ['X-WALLET-ADDRESS', 'X-REDOWNLOAD-SIGNATURE', 'X-REDOWNLOAD-TIMESTAMP'],
          one_of: [['X-PURCHASE-RECEIPT'], ['X-BLOCKCHAIN-TRANSACTION']],
          ...buildSiweChallengeFields({
            wallet: wallet || '0x<your-wallet>',
            soulId: assetId,
            action: 'redownload',
            siweIdentity
          }),
          ...(verify.auth_debug ? { auth_debug: verify.auth_debug } : {})
        });
      }
    }
    if (hasAnyRedownloadHeaders && !hasReceiptRedownloadHeaders && !hasTransactionRedownloadHeaders && !paymentSignature) {
      recordDownloadTelemetry({
        eventType: 'redownload.failed',
        route: telemetryRoute,
        action: 'redownload',
        walletAddress: wallet,
        assetId,
        assetType: delivery.assetType,
        success: false,
        statusCode: 401,
        errorCode: 'receipt_required_agent_mode'
      });
      return res.status(401).json({
        error: 'Receipt or blockchain transaction required for strict agent redownload',
        code: 'receipt_or_transaction_required_agent_mode',
        client_mode: clientModeRaw || 'agent',
        flow_hint:
          'Strict agent mode does not use session/auth recovery. Persist X-PURCHASE-RECEIPT or the on-chain settlement transaction hash and provide X-REDOWNLOAD-SIGNATURE + X-REDOWNLOAD-TIMESTAMP with X-WALLET-ADDRESS.',
        purchase_receipt_security_hint: PURCHASE_RECEIPT_SECURITY_HINT,
        required_headers: ['X-WALLET-ADDRESS', 'X-REDOWNLOAD-SIGNATURE', 'X-REDOWNLOAD-TIMESTAMP'],
        one_of: [['X-PURCHASE-RECEIPT'], ['X-BLOCKCHAIN-TRANSACTION']]
      });
    }
  }

  if (hasAnyRedownloadHeaders && !hasAnyValidEntitlementHeaders && !paymentSignature) {
    const walletForTemplate = typeof wallet === 'string' && wallet ? wallet : '0x<your-wallet>';
    recordDownloadTelemetry({
      eventType: 'redownload.failed',
      route: telemetryRoute,
      action: 'redownload',
      walletAddress: walletForTemplate,
      assetId,
      assetType: delivery.assetType,
      success: false,
      statusCode: 401,
      errorCode: 'incomplete_redownload_header_set'
    });
    return res.status(401).json({
      error: 'Incomplete re-download header set',
      flow_hint:
        'Re-download requires either agent primary mode (X-WALLET-ADDRESS + X-PURCHASE-RECEIPT or X-BLOCKCHAIN-TRANSACTION) or recovery mode (X-WALLET-ADDRESS + auth/session for prior buyers and creators). No payment retry was attempted.',
      received_headers: {
        has_wallet: Boolean(wallet),
        has_receipt: Boolean(receipt),
        has_blockchain_transaction: Boolean(blockchainTransaction),
        has_session_token: Boolean(redownloadSessionToken),
        has_auth_signature: Boolean(authSignature),
        has_auth_timestamp: Boolean(authTimestamp),
        has_payment_header: Boolean(paymentSignature)
      },
      expected_header_sets: {
        agent_primary_mode: ['X-WALLET-ADDRESS', 'X-PURCHASE-RECEIPT'],
        agent_transaction_mode: ['X-WALLET-ADDRESS', 'X-BLOCKCHAIN-TRANSACTION'],
        human_session_recovery_mode: ['X-WALLET-ADDRESS', 'X-REDOWNLOAD-SESSION'],
        human_signed_recovery_mode: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP']
      },
      redownload_session_bootstrap: {
        endpoint: '/api/auth/session',
        headers: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP'],
        ...buildSiweChallengeFields({
          wallet: walletForTemplate,
          soulId: '*',
          action: 'session',
          siweIdentity
        })
      },
      ...buildSiweChallengeFields({
        wallet: walletForTemplate,
        soulId: assetId,
        action: 'redownload',
        siweIdentity
      })
    });
  }

  if (hasAnyValidEntitlementHeaders) {
    const entitlementResult = await resolveRedownloadEntitlement({
      asset,
      assetId,
      blockchainTransaction,
      clientModeRaw,
      delivery,
      receipt,
      redownloadSessionToken,
      redownloadHeaders: {
        hasReceiptRedownloadHeaders,
        hasTransactionRedownloadHeaders
      },
      sellerAddress,
      siweIdentity,
      strictAgentMode,
      wallet,
      authSignature,
      authTimestamp
    });
    if (!entitlementResult.ok) {
      recordDownloadTelemetry({
        eventType: 'redownload.failed',
        route: telemetryRoute,
        action: 'redownload',
        walletAddress: String(wallet || '').toLowerCase() || null,
        assetId,
        assetType: delivery.assetType,
        success: false,
        statusCode: entitlementResult.status,
        errorCode: entitlementResult.telemetry?.errorCode || null,
        errorMessage: entitlementResult.telemetry?.errorMessage || null
      });
      return res.status(entitlementResult.status).json(entitlementResult.body);
    }

    const { authWallet, entitlementSource, entitlementTransaction, usedSignedAuth } = entitlementResult;
    const content = await loadAssetContent(assetId, { asset });
    if (!content) {
      recordDownloadTelemetry({
        eventType: 'redownload.failed',
        route: telemetryRoute,
        action: 'redownload',
        walletAddress: authWallet,
        assetId,
        assetType: delivery.assetType,
        success: false,
        statusCode: 500,
        errorCode: 'asset_unavailable'
      });
      return res.status(500).json({
        error: 'Asset unavailable'
      });
    }

    recordDownloadTelemetry({
      eventType: 'redownload.success',
      route: telemetryRoute,
      action: 'redownload',
      walletAddress: authWallet,
      assetId,
      assetType: delivery.assetType,
      success: true,
      statusCode: 200,
      metadata: {
        entitlement_source: entitlementSource,
        duration_ms: Date.now() - startMs
      }
    });
    return applySuccessfulAssetDelivery({
      res,
      content,
      delivery,
      assetId,
      wallet: authWallet,
      transaction: entitlementTransaction,
      entitlementSource,
      strictAgentMode,
      reqHost: req.headers.host,
      includeReceipt: entitlementSource !== 'receipt',
      includeRedownloadSession: usedSignedAuth
    });
  }

  return handleAssetPurchaseRequest({
    asset,
    assetId,
    clientModeRaw,
    delivery,
    hasAnyRedownloadHeaders,
    recordDownloadTelemetry,
    req,
    res,
    sellerAddress,
    siweIdentity,
    startMs,
    strictAgentMode,
    telemetryRoute,
    wallet,
    walletHintForQuote
  });
}
