import { getSoulResolved, loadSoulContent, soulIdsResolved } from '../../_lib/catalog.js';
import { ethers } from 'ethers';
import {
  buildPurchaseReceiptSetCookie,
  buildRedownloadSessionSetCookie,
  buildSiweAuthMessage,
  createRedownloadSessionToken,
  createPurchaseReceipt,
  detectWalletType,
  getSellerAddress,
  parseCookieHeader,
  purchaseReceiptCookieName,
  setCors,
  verifyPurchaseReceipt,
  verifyRedownloadSessionToken,
  verifyWalletAuth
} from '../../_lib/payments.js';
import {
  applyInstructionResponse,
  buildCdpRequestDebug,
  createRequestContext,
  getX402HTTPServer,
  inspectFacilitatorVerify
} from '../../_lib/x402.js';

const SETTLE_RETRY_DELAYS_MS = String(process.env.X402_SETTLE_RETRY_DELAYS_MS || '')
  .split(',')
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v >= 0);
const SETTLE_INITIAL_DELAY_MS = Number(process.env.X402_SETTLE_INITIAL_DELAY_MS || '0');
const inFlightSettlements = new Map();
const entitlementCache = new Map();
const ENTITLEMENT_CACHE_TTL_MS = Number(process.env.ENTITLEMENT_CACHE_TTL_MS || String(7 * 24 * 60 * 60 * 1000));
const onchainEntitlementCache = new Map();
const ONCHAIN_ENTITLEMENT_POSITIVE_TTL_MS = Number(
  process.env.ONCHAIN_ENTITLEMENT_POSITIVE_TTL_MS || String(24 * 60 * 60 * 1000)
);
const ONCHAIN_ENTITLEMENT_NEGATIVE_TTL_MS = Number(
  process.env.ONCHAIN_ENTITLEMENT_NEGATIVE_TTL_MS || String(5 * 60 * 1000)
);
const ONCHAIN_ENTITLEMENT_SCAN_FROM_BLOCK = Number(process.env.ONCHAIN_ENTITLEMENT_SCAN_FROM_BLOCK || '0');
const ONCHAIN_ENTITLEMENT_LOG_CHUNK_SIZE = Number(process.env.ONCHAIN_ENTITLEMENT_LOG_CHUNK_SIZE || '2000000');
const ONCHAIN_ENTITLEMENT_UNAVAILABLE_TTL_MS = Number(process.env.ONCHAIN_ENTITLEMENT_UNAVAILABLE_TTL_MS || '30000');
const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ERC20_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

function normalizeAssetTransferMethod(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'permit2') return 'permit2';
  if (raw === 'eip3009') return 'eip3009';
  return null;
}

async function resolveAssetTransferMethodForRequest(req, { strictAgentMode, wallet }) {
  const explicit =
    normalizeAssetTransferMethod(req.headers['x-asset-transfer-method']) ||
    normalizeAssetTransferMethod(req.query?.asset_transfer_method);
  if (explicit) return { method: explicit, source: 'explicit' };

  const walletHint = String(wallet || req.headers['x-wallet-address'] || req.query?.wallet_address || '').trim();
  if (!walletHint) return { method: null, source: 'default' };

  const walletType = await detectWalletType(walletHint);
  if (walletType === 'contract') {
    return { method: 'permit2', source: strictAgentMode ? 'wallet_type_contract_agent' : 'wallet_type_contract' };
  }
  if (walletType === 'eoa') {
    return { method: 'eip3009', source: 'wallet_type_eoa' };
  }
  return { method: null, source: 'default' };
}

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

export function classifyRedownloadHeaders({ headers = {}, cookieHeader = '', soulId = '' } = {}) {
  const cookies = parseCookieHeader(cookieHeader);
  const wallet = headers['x-wallet-address'];
  const authSignature = headers['x-auth-signature'];
  const authTimestamp = headers['x-auth-timestamp'];
  const redownloadSignature = headers['x-redownload-signature'];
  const redownloadTimestamp = headers['x-redownload-timestamp'];
  const receiptCookie = cookies[purchaseReceiptCookieName(soulId)] || null;
  const receipt = headers['x-purchase-receipt'] || receiptCookie;
  const redownloadSessionToken = headers['x-redownload-session'] || cookies.soulstarter_redownload_session || null;
  const paymentSignature = headers['payment-signature'] || headers['PAYMENT-SIGNATURE'];
  const legacyPaymentHeader = headers.payment || headers['x-payment'] || headers['PAYMENT'] || headers['X-PAYMENT'];

  // Session token alone (from cookie) is not enough to enter re-download flow.
  // It must be bound to an explicit wallet header, otherwise fresh purchase requests get blocked.
  const hasAnyRedownloadHeaders = Boolean(
    wallet ||
      authSignature ||
      authTimestamp ||
      (wallet && receipt) ||
      (wallet && redownloadSessionToken)
  );
  const hasReceiptRedownloadHeaders = Boolean(wallet && receipt);
  const hasSessionRecoveryHeaders = Boolean(wallet && !receipt && redownloadSessionToken && !authSignature && !authTimestamp);
  const hasSignedRecoveryHeaders = Boolean(wallet && !receipt && authSignature && authTimestamp);
  const hasAgentRedownloadChallengeHeaders = Boolean(wallet && redownloadSignature && redownloadTimestamp);
  const hasAnyValidEntitlementHeaders =
    hasReceiptRedownloadHeaders || hasSessionRecoveryHeaders || hasSignedRecoveryHeaders;

  let mode = 'none';
  if (hasReceiptRedownloadHeaders) mode = 'agent_primary_receipt';
  else if (hasSessionRecoveryHeaders) mode = 'human_recovery_session';
  else if (hasSignedRecoveryHeaders) mode = 'human_recovery_signed';
  else if (hasAnyRedownloadHeaders) mode = 'invalid';

  return {
    wallet,
    authSignature,
    authTimestamp,
    redownloadSignature,
    redownloadTimestamp,
    receipt,
    redownloadSessionToken,
    paymentSignature,
    legacyPaymentHeader,
    legacyPaymentHeader,
    hasAnyRedownloadHeaders,
    hasReceiptRedownloadHeaders,
    hasSessionRecoveryHeaders,
    hasSignedRecoveryHeaders,
    hasAgentRedownloadChallengeHeaders,
    hasAnyValidEntitlementHeaders,
    mode
  };
}

export function classifyClientMode({ headers = {}, query = {} } = {}) {
  const rawMode = String(
    headers['x-client-mode'] || headers['x-soulstarter-client-mode'] || query.client_mode || ''
  )
    .trim()
    .toLowerCase();
  const strictAgentMode = rawMode === 'agent' || rawMode === 'headless-agent' || rawMode === 'strict-agent';
  return { rawMode, strictAgentMode };
}

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const soulId = req.query.id;
  const soul = await getSoulResolved(soulId);
  if (!soul) {
    return res.status(404).json({ error: 'Soul not found', available_souls: await soulIdsResolved() });
  }

  const sellerAddress = soul.sellerAddress || getSellerAddress();
  if (!sellerAddress) {
    return res.status(500).json({ error: 'Server configuration error: SELLER_ADDRESS is required' });
  }
  const { rawMode: clientModeRaw, strictAgentMode } = classifyClientMode({ headers: req.headers, query: req.query });
  const walletHintForQuote = String(req.headers['x-wallet-address'] || req.query?.wallet_address || '').trim();

  // Re-download path: wallet re-auth + signed purchase receipt.
  const {
    wallet,
    authSignature,
    authTimestamp,
    redownloadSignature,
    redownloadTimestamp,
    receipt,
    redownloadSessionToken,
    paymentSignature,
    legacyPaymentHeader,
    hasAnyRedownloadHeaders,
    hasReceiptRedownloadHeaders,
    hasSessionRecoveryHeaders,
    hasSignedRecoveryHeaders,
    hasAgentRedownloadChallengeHeaders,
    hasAnyValidEntitlementHeaders
  } = classifyRedownloadHeaders({
    headers: req.headers,
    cookieHeader: req.headers.cookie,
    soulId
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
          'Strict agent mode requires receipt + wallet signature challenge for redownload.',
        required_headers: ['X-WALLET-ADDRESS', 'X-PURCHASE-RECEIPT', 'X-REDOWNLOAD-SIGNATURE', 'X-REDOWNLOAD-TIMESTAMP'],
        disallowed_headers: ['X-REDOWNLOAD-SESSION', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP']
      });
    }
    if (hasReceiptRedownloadHeaders && !hasAgentRedownloadChallengeHeaders) {
      return res.status(401).json({
        error: 'Wallet signature required for strict agent redownload',
        code: 'agent_redownload_signature_required',
        client_mode: clientModeRaw || 'agent',
        flow_hint:
          'Strict agent redownload now requires proof-of-wallet-control: send X-REDOWNLOAD-SIGNATURE + X-REDOWNLOAD-TIMESTAMP with X-WALLET-ADDRESS + X-PURCHASE-RECEIPT.',
        required_headers: ['X-WALLET-ADDRESS', 'X-PURCHASE-RECEIPT', 'X-REDOWNLOAD-SIGNATURE', 'X-REDOWNLOAD-TIMESTAMP'],
        auth_message_template: buildSiweAuthMessage({
          wallet: wallet || '0x<your-wallet>',
          soulId,
          action: 'redownload',
          timestamp: Date.now()
        })
      });
    }
    if (hasReceiptRedownloadHeaders && hasAgentRedownloadChallengeHeaders) {
      const verify = await verifyWalletAuth({
        wallet,
        soulId,
        action: 'redownload',
        timestamp: redownloadTimestamp,
        signature: redownloadSignature
      });
      if (!verify.ok) {
        return res.status(401).json({
          error: 'Invalid strict agent redownload signature',
          code: 'invalid_agent_redownload_signature',
          flow_hint: 'Re-sign the redownload auth message with the same wallet and retry.',
          required_headers: ['X-WALLET-ADDRESS', 'X-PURCHASE-RECEIPT', 'X-REDOWNLOAD-SIGNATURE', 'X-REDOWNLOAD-TIMESTAMP'],
          auth_message_template: buildSiweAuthMessage({
            wallet: wallet || '0x<your-wallet>',
            soulId,
            action: 'redownload',
            timestamp: Date.now()
          }),
          ...(verify.auth_debug ? { auth_debug: verify.auth_debug } : {})
        });
      }
    }
    if (hasAnyRedownloadHeaders && !hasReceiptRedownloadHeaders && !paymentSignature) {
      return res.status(401).json({
        error: 'Receipt required for strict agent redownload',
        code: 'receipt_required_agent_mode',
        client_mode: clientModeRaw || 'agent',
        flow_hint:
          'Strict agent mode does not use session/auth recovery. Persist X-PURCHASE-RECEIPT and provide X-REDOWNLOAD-SIGNATURE + X-REDOWNLOAD-TIMESTAMP with X-WALLET-ADDRESS.',
        required_headers: ['X-WALLET-ADDRESS', 'X-PURCHASE-RECEIPT', 'X-REDOWNLOAD-SIGNATURE', 'X-REDOWNLOAD-TIMESTAMP']
      });
    }
  }

  // Guardrail: partial re-download header sets should never fall through into purchase flow.
  // This prevents accidental repurchase when clients intended entitlement-based access.
  if (hasAnyRedownloadHeaders && !hasAnyValidEntitlementHeaders && !paymentSignature) {
    const walletForTemplate = typeof wallet === 'string' && wallet ? wallet : '0x<your-wallet>';
    return res.status(401).json({
      error: 'Incomplete re-download header set',
      flow_hint:
        'Re-download requires either agent primary mode (X-WALLET-ADDRESS + X-PURCHASE-RECEIPT) or recovery mode (X-WALLET-ADDRESS + auth/session for prior buyers and creators). No payment retry was attempted.',
      received_headers: {
        has_wallet: Boolean(wallet),
        has_receipt: Boolean(receipt),
        has_session_token: Boolean(redownloadSessionToken),
        has_auth_signature: Boolean(authSignature),
        has_auth_timestamp: Boolean(authTimestamp),
        has_payment_header: Boolean(paymentSignature)
      },
      expected_header_sets: {
        agent_primary_mode: ['X-WALLET-ADDRESS', 'X-PURCHASE-RECEIPT'],
        human_session_recovery_mode: ['X-WALLET-ADDRESS', 'X-REDOWNLOAD-SESSION'],
        human_signed_recovery_mode: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP']
      },
      redownload_session_bootstrap: {
        endpoint: '/api/auth/session',
        headers: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP'],
        auth_message_template: buildSiweAuthMessage({
          wallet: walletForTemplate,
          soulId: '*',
          action: 'session',
          timestamp: Date.now()
        })
      },
      auth_message_template: buildSiweAuthMessage({
        wallet: walletForTemplate,
        soulId,
        action: 'redownload',
        timestamp: Date.now()
      })
    });
  }

  if (hasAnyValidEntitlementHeaders) {
    let authWallet = String(wallet || '').toLowerCase();
    let usedSignedAuth = false;
    let entitlementSource = 'receipt';
    let entitlementTransaction = 'prior-entitlement';
    if (hasReceiptRedownloadHeaders) {
      const receiptCheck = verifyPurchaseReceipt({
        receipt,
        wallet: authWallet,
        soulId
      });

      if (!receiptCheck.ok) {
        if (strictAgentMode) {
          return res.status(401).json({
            error: receiptCheck.error,
            code: 'invalid_receipt_agent_mode',
            client_mode: clientModeRaw || 'agent',
            flow_hint:
              'Strict agent redownload requires a valid receipt. Reuse the original X-PURCHASE-RECEIPT from purchase success.',
            required_headers: ['X-WALLET-ADDRESS', 'X-PURCHASE-RECEIPT', 'X-REDOWNLOAD-SIGNATURE', 'X-REDOWNLOAD-TIMESTAMP']
          });
        }
        const onchainEntitlement = await resolveOnchainEntitlement({
          wallet: authWallet,
          soulId,
          soul,
          sellerAddress
        });
        if (!onchainEntitlement.ok) {
          if (isOnchainServiceUnavailableReason(onchainEntitlement.reason)) {
            return res.status(503).json({
              error: 'On-chain entitlement verification temporarily unavailable',
              flow_hint:
                'Receipt verification failed and on-chain verifier is temporarily unavailable. Retry shortly or provide a valid X-PURCHASE-RECEIPT.',
              onchain_entitlement: {
                checked: true,
                entitled: false,
                unavailable: true,
                reason: onchainEntitlement.reason || null
              }
            });
          }
          return res.status(401).json({
            error: receiptCheck.error,
            flow_hint:
              'Receipt verification failed and no on-chain entitlement was found for this wallet+soul. Ensure wallet matches original buyer or submit PAYMENT-SIGNATURE for new purchase.',
            onchain_entitlement: {
              checked: true,
              entitled: false,
              reason: onchainEntitlement.reason || null
            }
          });
        }
        entitlementSource = 'onchain';
        entitlementTransaction = onchainEntitlement.transaction || 'onchain-entitlement';
      } else {
        entitlementSource = 'receipt';
        entitlementTransaction = receiptCheck.transaction || 'prior-entitlement';
      }
    } else {
      if (authSignature && authTimestamp) {
        const authCheck = await verifyWalletAuth({
          wallet,
          soulId,
          action: 'redownload',
          timestamp: authTimestamp,
          signature: authSignature
        });

        if (!authCheck.ok) {
          return res.status(401).json({
            error: authCheck.error,
            auth_debug: authCheck.auth_debug || null
          });
        }
        authWallet = authCheck.wallet;
        usedSignedAuth = true;
      } else {
        const sessionCheck = verifyRedownloadSessionToken({
          token: String(redownloadSessionToken || ''),
          wallet: authWallet
        });
        if (!sessionCheck.ok) {
          return res.status(401).json({ error: sessionCheck.error });
        }
      }

      const creatorEntitled = isCreatorWalletForSoul({ wallet: authWallet, soul });
      if (!creatorEntitled) {
        const onchainEntitlement = await resolveOnchainEntitlement({
          wallet: authWallet,
          soulId,
          soul,
          sellerAddress
        });
        if (!onchainEntitlement.ok) {
          if (isOnchainServiceUnavailableReason(onchainEntitlement.reason)) {
            return res.status(503).json({
              error: 'On-chain entitlement verification temporarily unavailable',
              flow_hint:
                'Session/signed recovery requires on-chain entitlement when no receipt is provided. Verifier is temporarily unavailable; retry shortly.',
              onchain_entitlement: {
                checked: true,
                entitled: false,
                unavailable: true,
                reason: onchainEntitlement.reason || null
              }
            });
          }
          return res.status(401).json({
            error: 'No receipt provided and wallet has no prior entitlement for this soul',
            flow_hint:
              'Session-only mode works for prior buyers/creators. This wallet has no verified ownership for this soul yet.',
            onchain_entitlement: {
              checked: true,
              entitled: false,
              reason: onchainEntitlement.reason || null
            }
          });
        }
        entitlementSource = 'onchain';
        entitlementTransaction = onchainEntitlement.transaction || 'onchain-entitlement';
      } else {
        entitlementSource = 'creator';
        entitlementTransaction = 'creator-entitlement';
      }
    }

    if (entitlementSource === 'creator') {
      // Creator access is explicitly wallet-bound to publishedBy and requires wallet auth/session.
    } else if (entitlementSource === 'onchain') {
      // On-chain ownership fallback allows session-only redownloads when receipts are missing/legacy.
    } else if (entitlementSource !== 'receipt') {
        return res.status(401).json({
          error: 'Unsupported entitlement source'
        });
      }

    const content = await loadSoulContent(soulId, { soul });
    if (!content) {
      return res.status(500).json({ error: 'Soul unavailable' });
    }
    cacheEntitlement({
      wallet: authWallet,
      soulId,
      transaction: entitlementTransaction
    });
    if (usedSignedAuth) {
      try {
        const sessionToken = createRedownloadSessionToken({ wallet: authWallet });
        if (!strictAgentMode) {
          appendSetCookieHeader(
            res,
            buildRedownloadSessionSetCookie({ token: sessionToken, reqHost: req.headers.host })
          );
        }
      } catch (_) {}
    }
    if (entitlementSource !== 'receipt') {
      try {
        const receiptToken = createPurchaseReceipt({
          wallet: authWallet,
          soulId,
          transaction: entitlementTransaction
        });
        res.setHeader('X-PURCHASE-RECEIPT', receiptToken);
        if (!strictAgentMode) {
          appendSetCookieHeader(
            res,
            buildPurchaseReceiptSetCookie({ soulId, receipt: receiptToken, reqHost: req.headers.host })
          );
        }
      } catch (_) {}
    }

    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="${soulId}-SOUL.md"`);
    res.setHeader(
      'PAYMENT-RESPONSE',
      Buffer.from(
        JSON.stringify({
          success: true,
          transaction: entitlementTransaction,
          network: 'eip155:8453',
          soulDelivered: soulId,
          entitlementSource
        })
      ).toString('base64')
    );

    return res.status(200).send(content);
  }

  try {
    rewriteIncomingPaymentHeader(req);
    const context = createRequestContext(req);
    const submittedPayment = context.paymentHeader ? decodeSubmittedPayment(req) : null;
    const transferMethodSelection = await resolveAssetTransferMethodForRequest(req, {
      strictAgentMode,
      wallet
    });
    if (strictAgentMode && !hasAnyRedownloadHeaders && !transferMethodSelection.method) {
      return res.status(400).json({
        error: 'Unable to resolve transfer method for strict agent flow',
        code: 'agent_transfer_method_unresolved',
        flow_hint:
          'Provide X-WALLET-ADDRESS and retry. If wallet-type detection is unavailable, set X-ASSET-TRANSFER-METHOD explicitly to eip3009 or permit2.',
        required_headers: ['X-CLIENT-MODE: agent', 'X-WALLET-ADDRESS'],
        optional_headers: ['X-ASSET-TRANSFER-METHOD'],
        transfer_method_selection: transferMethodSelection
      });
    }
    if (strictAgentMode && submittedPayment && transferMethodSelection.method) {
      const submittedMethod = getTransferMethodFromSubmittedPayment(submittedPayment);
      if (submittedMethod !== transferMethodSelection.method) {
        return res.status(402).json({
          error: 'Payment transfer method mismatch',
          code: 'x402_method_mismatch',
          flow_hint:
            'The submitted PAYMENT-SIGNATURE method does not match this wallet quote. Refresh PAYMENT-REQUIRED and re-sign with the selected method.',
          expected_transfer_method: transferMethodSelection.method,
          submitted_transfer_method: submittedMethod,
          transfer_method_selection: transferMethodSelection,
          payment_signing_instructions: buildPaymentSigningInstructionsForMethod(transferMethodSelection.method)
        });
      }
    }
    const httpServer = await getX402HTTPServer({
      soulId,
      soul,
      sellerAddress,
      assetTransferMethod: transferMethodSelection.method
    });
    const result = await httpServer.processHTTPRequest(context);
    const includeDebug = shouldIncludeDebug(req);

    if (result.type === 'payment-error') {
      if (result.response?.body && typeof result.response.body === 'object') {
        const paymentRequired = decodePaymentRequiredHeader(result.response?.headers);
        const paymentSigningInstructions = buildPaymentSigningInstructions(paymentRequired);
        const paymentDebug = includeDebug ? buildPaymentDebug(req, paymentRequired) : null;
        if (paymentSigningInstructions) {
          result.response.body.payment_signing_instructions = paymentSigningInstructions;
        }

        if (!context.paymentHeader) {
          result.response.body.transfer_method_selection = transferMethodSelection;
          if (strictAgentMode) {
            result.response.body.flow_hint =
              'Strict agent mode purchase step: send PAYMENT-SIGNATURE with base64-encoded x402 payload.';
            result.response.body.client_mode = clientModeRaw || 'agent';
            result.response.body.redownload_contract = {
              required_headers: ['X-WALLET-ADDRESS', 'X-PURCHASE-RECEIPT', 'X-REDOWNLOAD-SIGNATURE', 'X-REDOWNLOAD-TIMESTAMP'],
              disallowed_headers: ['X-REDOWNLOAD-SESSION', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP']
            };
          } else {
            result.response.body.auth_message_template = buildSiweAuthMessage({
              wallet: '0x<your-wallet>',
              soulId,
              action: 'redownload',
              timestamp: Date.now()
            });
            result.response.body.flow_hint =
              'No payment header was detected. Send PAYMENT-SIGNATURE with base64-encoded x402 payload for purchase.';
          }
        } else {
          result.response.body.flow_hint =
            'Payment header was detected but could not be verified/settled. Regenerate PAYMENT-SIGNATURE from the latest PAYMENT-REQUIRED and retry.';
          if (includeDebug) {
            const submittedPayment = decodeSubmittedPayment(req);
            const facilitatorVerify = await inspectFacilitatorVerify({
              paymentPayload: submittedPayment,
              paymentRequirements: paymentRequired?.accepts?.[0] || null,
              x402Version: paymentRequired?.x402Version ?? submittedPayment?.x402Version ?? 2
            });
            const copyPastePayload = buildCopyPastePaymentPayloadTemplate(paymentRequired);
            result.response.body.accepted_copy_paste = paymentRequired?.accepts?.[0] || null;
            result.response.body.copy_paste_payment_payload = copyPastePayload;
            result.response.body.copy_paste_header_hint =
              'PAYMENT-SIGNATURE: base64(JSON.stringify(copy_paste_payment_payload))';
            result.response.body.payment_debug = {
              ...paymentDebug,
              transfer_method_selection: transferMethodSelection,
              facilitator_verify: facilitatorVerify
            };
          }
        }
      }
      return applyInstructionResponse(res, result.response);
    }

    if (result.type !== 'payment-verified') {
      return res.status(500).json({ error: 'Unexpected x402 processing state' });
    }

    const payloadContractCheck = validatePaymentPayloadContract({
      paymentPayload: result.paymentPayload,
      paymentRequirements: result.paymentRequirements
    });
    if (!payloadContractCheck.ok) {
      return res.status(402).json({
        error: 'Invalid payment payload contract',
        code: payloadContractCheck.code,
        flow_hint: payloadContractCheck.flowHint,
        contract_requirements: payloadContractCheck.required || null,
        payment_signing_instructions: buildPaymentSigningInstructions({ accepts: [result.paymentRequirements], x402Version: 2 }),
        mismatch_hints: payloadContractCheck.mismatchHints || [],
        ...(shouldIncludeDebug(req)
          ? {
              payment_payload_shape: payloadContractCheck.shape || null,
              payment_payload_preview: payloadContractCheck.preview || null
            }
          : {})
      });
    }

    const content = await loadSoulContent(soulId, { soul });
    if (!content) {
      return res.status(500).json({ error: 'Soul unavailable' });
    }

    const payerHint = getPayerFromPaymentPayload(result.paymentPayload);
    const cachedEntitlement = payerHint ? getCachedEntitlement(payerHint, soulId) : null;
    if (cachedEntitlement) {
      const receiptToken = createPurchaseReceipt({
        wallet: payerHint,
        soulId,
        transaction: cachedEntitlement.transaction || 'prior-entitlement'
      });
      res.setHeader('X-PURCHASE-RECEIPT', receiptToken);
      if (!strictAgentMode) {
        appendSetCookieHeader(
          res,
          buildPurchaseReceiptSetCookie({ soulId, receipt: receiptToken, reqHost: req.headers.host })
        );
      }
      res.setHeader(
        'PAYMENT-RESPONSE',
        Buffer.from(
          JSON.stringify({
            success: true,
            transaction: cachedEntitlement.transaction || 'prior-entitlement',
            network: 'eip155:8453',
            soulDelivered: soulId,
            entitlementSource: 'cache'
          })
        ).toString('base64')
      );
      res.setHeader('Content-Type', 'text/markdown');
      res.setHeader('Content-Disposition', `attachment; filename="${soulId}-SOUL.md"`);
      return res.status(200).send(content);
    }

    let settlementResult;
    try {
      const singleFlightKey = buildSettlementKey({
        soulId,
        paymentPayload: result.paymentPayload,
        paymentRequirements: result.paymentRequirements
      });
      settlementResult = await runSingleFlightSettlement(singleFlightKey, () =>
        processSettlementWithRetries(httpServer, {
          paymentPayload: result.paymentPayload,
          paymentRequirements: result.paymentRequirements,
          declaredExtensions: result.declaredExtensions
        })
      );
    } catch (error) {
      return res.status(402).json({
        error: 'Settlement threw an exception',
        settlement_debug: extractX402Error(error)
      });
    }

    const settlement = settlementResult.settlement;
    if (!settlement.success) {
      const includeDebug = shouldIncludeDebug(req);
      const settlementDiagnostics = includeDebug
        ? await buildSettlementDiagnostics({
            paymentPayload: result.paymentPayload,
            paymentRequirements: result.paymentRequirements
          })
        : null;
      const cdpSettleRequestDebug = includeDebug
        ? buildCdpRequestDebug({
            paymentPayload: result.paymentPayload,
            paymentRequirements: result.paymentRequirements,
            x402Version: result.paymentPayload?.x402Version ?? 2
          })
        : null;
      return res.status(402).json({
        error: 'Settlement failed',
        reason: settlement.errorReason,
        message: settlement.errorMessage,
        ...(includeDebug ? { settlement_diagnostics: settlementDiagnostics } : {}),
        settlement_attempts: settlementResult.attempts,
        ...(includeDebug
          ? {
              cdp_settle_request_preview: {
                top_level_x402Version: cdpSettleRequestDebug?.top_level_x402Version ?? null,
                transfer_method: cdpSettleRequestDebug?.transfer_method ?? null,
                paymentPayload_keys: cdpSettleRequestDebug?.paymentPayload_keys ?? [],
                paymentRequirements_keys: cdpSettleRequestDebug?.paymentRequirements_keys ?? [],
                paymentPayload_field_types: cdpSettleRequestDebug?.paymentPayload_field_types ?? null,
                paymentPayload_field_checks: cdpSettleRequestDebug?.paymentPayload_field_checks ?? null
              },
              cdp_settle_request_redacted: cdpSettleRequestDebug?.cdp_request_redacted ?? null
            }
          : {})
      });
    }

    for (const [key, value] of Object.entries(settlement.headers || {})) {
      if (value != null) {
        res.setHeader(key, value);
      }
    }

    const receiptToken = settlement.payer
      ? createPurchaseReceipt({
          wallet: settlement.payer,
          soulId,
          transaction: settlement.transaction
        })
      : null;

    if (settlement.success && settlement.payer) {
      cacheEntitlement({
        wallet: settlement.payer,
        soulId,
        transaction: settlement.transaction || 'prior-entitlement'
      });
    }

    if (receiptToken) {
      res.setHeader('X-PURCHASE-RECEIPT', receiptToken);
      if (!strictAgentMode) {
        appendSetCookieHeader(
          res,
          buildPurchaseReceiptSetCookie({ soulId, receipt: receiptToken, reqHost: req.headers.host })
        );
      }
    }
    if (settlement.success && settlement.payer) {
      try {
        const sessionToken = createRedownloadSessionToken({ wallet: settlement.payer });
        if (!strictAgentMode) {
          appendSetCookieHeader(
            res,
            buildRedownloadSessionSetCookie({ token: sessionToken, reqHost: req.headers.host })
          );
        }
      } catch (_) {}
    }

    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="${soulId}-SOUL.md"`);
    return res.status(200).send(content);
  } catch (error) {
    console.error('x402 processing failed:', error);
    return res.status(500).json({
      error: 'Payment processing failed',
      processing_debug: extractX402Error(error)
    });
  }
}

function runSingleFlightSettlement(key, run) {
  const safeKey = String(key || '');
  if (!safeKey) return run();
  const existing = inFlightSettlements.get(safeKey);
  if (existing) {
    return existing;
  }
  const promise = Promise.resolve()
    .then(run)
    .finally(() => {
      inFlightSettlements.delete(safeKey);
    });
  inFlightSettlements.set(safeKey, promise);
  return promise;
}

function buildSettlementKey({ soulId, paymentPayload, paymentRequirements }) {
  const transferMethod = String(paymentRequirements?.extra?.assetTransferMethod || 'eip3009').toLowerCase();
  const payer = getPayerFromPaymentPayload(paymentPayload) || 'unknown';
  if (transferMethod === 'permit2') {
    const nonce = String(paymentPayload?.payload?.permit2Authorization?.nonce || '');
    return `settle:${soulId}:${payer}:permit2:${nonce}`;
  }
  const nonce = String(paymentPayload?.payload?.authorization?.nonce || '');
  return `settle:${soulId}:${payer}:eip3009:${nonce}`;
}

function getPayerFromPaymentPayload(paymentPayload) {
  const direct =
    paymentPayload?.payload?.authorization?.from ||
    paymentPayload?.payload?.permit2Authorization?.from ||
    paymentPayload?.payload?.from ||
    null;
  if (typeof direct !== 'string') return null;
  if (!/^0x[a-fA-F0-9]{40}$/.test(direct)) return null;
  return direct.toLowerCase();
}

function entitlementKey(wallet, soulId) {
  return `${String(wallet || '').toLowerCase()}::${String(soulId || '')}`;
}

function getCachedEntitlement(wallet, soulId) {
  const key = entitlementKey(wallet, soulId);
  const hit = entitlementCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    entitlementCache.delete(key);
    return null;
  }
  return hit;
}

function cacheEntitlement({ wallet, soulId, transaction }) {
  if (!wallet || !soulId) return;
  entitlementCache.set(entitlementKey(wallet, soulId), {
    wallet: String(wallet).toLowerCase(),
    soulId: String(soulId),
    transaction: transaction || 'prior-entitlement',
    expiresAt: Date.now() + ENTITLEMENT_CACHE_TTL_MS
  });
}

function onchainEntitlementKey(wallet, soulId, sellerAddress) {
  return `${String(wallet || '').toLowerCase()}::${String(soulId || '')}::${String(sellerAddress || '').toLowerCase()}`;
}

function getCachedOnchainEntitlement(wallet, soulId, sellerAddress) {
  const key = onchainEntitlementKey(wallet, soulId, sellerAddress);
  const hit = onchainEntitlementCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    onchainEntitlementCache.delete(key);
    return null;
  }
  return hit;
}

function cacheOnchainEntitlement({ wallet, soulId, sellerAddress, ok, transaction, reason }) {
  if (!wallet || !soulId || !sellerAddress) return;
  const reasonText = String(reason || '');
  let ttlMs = ok ? ONCHAIN_ENTITLEMENT_POSITIVE_TTL_MS : ONCHAIN_ENTITLEMENT_NEGATIVE_TTL_MS;
  if (!ok && isOnchainServiceUnavailableReason(reasonText)) {
    ttlMs = Number.isFinite(ONCHAIN_ENTITLEMENT_UNAVAILABLE_TTL_MS) && ONCHAIN_ENTITLEMENT_UNAVAILABLE_TTL_MS > 0
      ? ONCHAIN_ENTITLEMENT_UNAVAILABLE_TTL_MS
      : 30000;
  }
  onchainEntitlementCache.set(onchainEntitlementKey(wallet, soulId, sellerAddress), {
    ok: Boolean(ok),
    transaction: transaction || null,
    reason: reasonText || null,
    expiresAt: Date.now() + ttlMs
  });
}

function isOnchainServiceUnavailableReason(reason) {
  const text = String(reason || '').toLowerCase();
  if (!text) return false;
  return (
    text.startsWith('onchain_providers_unavailable') ||
    text.includes('currently healthy') ||
    text.includes('temporarily unavailable') ||
    text.includes('timeout') ||
    text.includes('429') ||
    text.includes('503') ||
    text.includes('network error')
  );
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ''));
}

async function resolveOnchainEntitlement({ wallet, soulId, soul, sellerAddress }) {
  const normalizedWallet = String(wallet || '').toLowerCase();
  const normalizedSeller = String(sellerAddress || '').toLowerCase();
  const fromCache = getCachedOnchainEntitlement(normalizedWallet, soulId, normalizedSeller);
  if (fromCache) {
    return { ok: Boolean(fromCache.ok), transaction: fromCache.transaction || null, reason: fromCache.reason || null, cached: true };
  }

  if (!isAddress(normalizedWallet) || !isAddress(normalizedSeller)) {
    const reason = 'invalid_wallet_or_seller_address';
    cacheOnchainEntitlement({ wallet: normalizedWallet, soulId, sellerAddress: normalizedSeller, ok: false, reason });
    return { ok: false, reason };
  }

  let requiredAmount;
  try {
    requiredAmount = BigInt(String(soul?.priceMicroUsdc || '0'));
  } catch (_) {
    requiredAmount = 0n;
  }
  if (requiredAmount <= 0n) {
    const reason = 'invalid_soul_price';
    cacheOnchainEntitlement({ wallet: normalizedWallet, soulId, sellerAddress: normalizedSeller, ok: false, reason });
    return { ok: false, reason };
  }

  const rpcUrls = [
    ...String(process.env.BASE_RPC_URLS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    String(process.env.BASE_RPC_URL || '').trim(),
    'https://mainnet.base.org',
    'https://base-rpc.publicnode.com'
  ].filter(Boolean);
  const uniqueRpcUrls = [...new Set(rpcUrls)];
  const transferIface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  const providerErrors = [];
  const startBlock = Number.isFinite(ONCHAIN_ENTITLEMENT_SCAN_FROM_BLOCK) && ONCHAIN_ENTITLEMENT_SCAN_FROM_BLOCK >= 0
    ? ONCHAIN_ENTITLEMENT_SCAN_FROM_BLOCK
    : 0;
  const chunkSize = Number.isFinite(ONCHAIN_ENTITLEMENT_LOG_CHUNK_SIZE) && ONCHAIN_ENTITLEMENT_LOG_CHUNK_SIZE > 0
    ? Math.floor(ONCHAIN_ENTITLEMENT_LOG_CHUNK_SIZE)
    : 2_000_000;
  const fromTopic = ethers.zeroPadValue(normalizedWallet, 32);
  const toTopic = ethers.zeroPadValue(normalizedSeller, 32);

  for (const rpcUrl of uniqueRpcUrls) {
    const provider = new ethers.JsonRpcProvider(rpcUrl, 8453);
    try {
      const latest = await provider.getBlockNumber();
      for (let fromBlock = startBlock; fromBlock <= latest; fromBlock += chunkSize) {
        const toBlock = Math.min(latest, fromBlock + chunkSize - 1);
        const logs = await provider.getLogs({
          address: BASE_MAINNET_USDC,
          fromBlock,
          toBlock,
          topics: [ERC20_TRANSFER_TOPIC, fromTopic, toTopic]
        });

        for (const log of logs) {
          let value = 0n;
          try {
            const parsed = transferIface.parseLog({ topics: log.topics, data: log.data });
            value = BigInt(String(parsed?.args?.value ?? '0'));
          } catch (_) {
            try {
              value = BigInt(String(log?.data || '0x0'));
            } catch {
              value = 0n;
            }
          }
          if (value >= requiredAmount) {
            const transaction = log.transactionHash || null;
            cacheOnchainEntitlement({
              wallet: normalizedWallet,
              soulId,
              sellerAddress: normalizedSeller,
              ok: true,
              transaction
            });
            return { ok: true, transaction, reason: null, cached: false };
          }
        }
      }

      const reason = 'no_matching_payment_transfer_found';
      cacheOnchainEntitlement({
        wallet: normalizedWallet,
        soulId,
        sellerAddress: normalizedSeller,
        ok: false,
        reason
      });
      return { ok: false, reason, cached: false };
    } catch (error) {
      providerErrors.push(`${rpcUrl}:${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
  }

  const reason = `onchain_providers_unavailable:${providerErrors[0] || 'unknown'}`;
  cacheOnchainEntitlement({
    wallet: normalizedWallet,
    soulId,
    sellerAddress: normalizedSeller,
    ok: false,
    reason
  });
  return { ok: false, reason, cached: false };
}

function isCreatorWalletForSoul({ wallet, soul }) {
  const creator = String(soul?.publishedBy || '').toLowerCase();
  const candidate = String(wallet || '').toLowerCase();
  return Boolean(creator && candidate && creator === candidate);
}

function decodePaymentRequiredHeader(headers = {}) {
  const header = headers['PAYMENT-REQUIRED'] || headers['payment-required'];
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(String(header), 'base64').toString('utf-8'));
  } catch (_) {
    return null;
  }
}

async function processSettlementWithRetries(httpServer, { paymentPayload, paymentRequirements, declaredExtensions }) {
  const attempts = [];
  let settlement = null;
  const transferMethod = String(paymentRequirements?.extra?.assetTransferMethod || 'eip3009').toLowerCase();
  const initialDelayMs = transferMethod === 'eip3009' && Number.isFinite(SETTLE_INITIAL_DELAY_MS) ? SETTLE_INITIAL_DELAY_MS : 0;

  if (initialDelayMs > 0) {
    await sleep(initialDelayMs);
  }

  for (let i = 0; i <= SETTLE_RETRY_DELAYS_MS.length; i += 1) {
    try {
      settlement = await httpServer.processSettlement(paymentPayload, paymentRequirements, declaredExtensions);
      const transient = isTransientSettleError(settlement?.errorMessage || settlement?.errorReason || null);
      attempts.push({
        attempt: i + 1,
        ok: Boolean(settlement?.success),
        reason: settlement?.errorReason ?? null,
        message: settlement?.errorMessage ?? null,
        transient
      });
    } catch (error) {
      const extracted = extractX402Error(error);
      const transient = isTransientSettleError(extracted?.errorMessage || extracted?.message || null);
      attempts.push({
        attempt: i + 1,
        ok: false,
        threw: true,
        reason: extracted?.errorReason ?? null,
        message: extracted?.errorMessage ?? extracted?.message ?? null,
        transient
      });
      const delayMs = SETTLE_RETRY_DELAYS_MS[i];
      if (!transient || delayMs == null) {
        throw error;
      }
      await sleep(delayMs);
      continue;
    }

    if (settlement?.success) {
      return { settlement, attempts };
    }
    if (!isTransientSettleError(settlement?.errorMessage || settlement?.errorReason || null)) {
      return { settlement, attempts };
    }

    const delayMs = SETTLE_RETRY_DELAYS_MS[i];
    if (delayMs == null) {
      return { settlement, attempts };
    }
    await sleep(delayMs);
  }

  return { settlement, attempts };
}

function isTransientSettleError(message) {
  const text = String(message || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('unable to estimate gas') ||
    text.includes('execution reverted') ||
    text.includes('timeout') ||
    text.includes('temporarily unavailable') ||
    text.includes('network error')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeSubmittedPayment(req) {
  const raw = req.headers['payment-signature'] || req.headers['PAYMENT-SIGNATURE'];
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(String(raw), 'base64').toString('utf-8'));
  } catch (_) {
    return null;
  }
}

function rewriteIncomingPaymentHeader(req) {
  const headerKey = req.headers['payment-signature']
    ? 'payment-signature'
    : req.headers['PAYMENT-SIGNATURE']
      ? 'PAYMENT-SIGNATURE'
      : null;
  if (!headerKey) return;

  const submitted = decodeSubmittedPayment(req);
  if (!submitted) return;

  const canonical = canonicalizeSubmittedPayment(submitted);
  if (!canonical || deepEqual(canonical, submitted)) return;

  req.headers[headerKey] = Buffer.from(JSON.stringify(canonical)).toString('base64');
}

function canonicalizeSubmittedPayment(submitted) {
  if (!submitted || typeof submitted !== 'object') return submitted;
  if (!submitted.payload || typeof submitted.payload !== 'object') return submitted;

  const transferMethod = getTransferMethodFromSubmittedPayment(submitted);
  const payload = { ...submitted.payload };
  const canonical = { ...submitted };

  // Normalize malformed agent submissions where scheme/network were nested under payload.
  if (!canonical.scheme && typeof payload.scheme === 'string') canonical.scheme = payload.scheme;
  if (!canonical.network && typeof payload.network === 'string') canonical.network = payload.network;
  delete payload.scheme;
  delete payload.network;

  if (transferMethod === 'permit2') {
    if (payload.permit2 && !payload.permit2Authorization) {
      payload.permit2Authorization = payload.permit2;
    }
    delete payload.permit2;
    delete payload.authorization;
  } else {
    // Normalize malformed eip3009 submissions where signature is nested under authorization.
    if (!payload.signature && payload.authorization?.signature) {
      payload.signature = payload.authorization.signature;
      delete payload.authorization.signature;
    }
    delete payload.transaction;
    delete payload.permit2Authorization;
    delete payload.permit2;
  }

  return {
    ...canonical,
    payload
  };
}

function getTransferMethodFromSubmittedPayment(submitted) {
  const fromAccepted = String(submitted?.accepted?.extra?.assetTransferMethod || '')
    .trim()
    .toLowerCase();
  if (fromAccepted === 'permit2' || fromAccepted === 'eip3009') return fromAccepted;
  if (submitted?.payload?.permit2Authorization || submitted?.payload?.permit2) return 'permit2';
  return 'eip3009';
}

function buildPaymentDebug(req, paymentRequired) {
  const submitted = decodeSubmittedPayment(req);
  const expected = paymentRequired?.accepts?.[0] || null;
  const auth = submitted?.payload?.authorization || null;
  const permit2Auth = submitted?.payload?.permit2Authorization || null;
  const transferMethod = String(expected?.extra?.assetTransferMethod || 'eip3009').toLowerCase();
  const expectedChainId = toChainId(expected?.network);
  const nowSec = Math.floor(Date.now() / 1000);

  const selectedHeader = req.headers['payment-signature']
    ? 'PAYMENT-SIGNATURE'
    : 'unknown';

  const info = {
    header_detected: selectedHeader,
    submitted_parse_ok: Boolean(submitted),
    submitted_fields: submitted
      ? {
          x402Version: submitted.x402Version ?? null,
          scheme: submitted.scheme ?? null,
          network: submitted.network ?? null,
          hasAccepted: Boolean(submitted.accepted),
          hasPayload: Boolean(submitted.payload),
          hasAuthorization: Boolean(submitted.payload?.authorization),
          hasPermit2Authorization: Boolean(submitted.payload?.permit2Authorization),
          hasSignature: Boolean(submitted.payload?.signature),
          hasTransaction: Boolean(submitted.payload?.transaction),
          signatureHexLength: typeof submitted.payload?.signature === 'string' ? submitted.payload.signature.length : null
        }
      : null,
    expected_fields: expected
        ? {
            x402Version: paymentRequired?.x402Version ?? null,
            scheme: expected.scheme ?? null,
            network: expected.network ?? null,
            amount: expected.amount ?? null,
            asset: expected.asset ?? null,
            payTo: expected.payTo ?? null,
            assetTransferMethod: expected?.extra?.assetTransferMethod ?? null
          }
        : null,
    accepted_exact_match: Boolean(expected && submitted?.accepted && deepEqual(submitted.accepted, expected)),
    accepted_diff: expected && submitted?.accepted ? diffObjects(submitted.accepted, expected) : null,
    authorization_checks:
      auth && expected
        ? {
            from: auth.from ?? null,
            to: auth.to ?? null,
            value: auth.value ?? null,
            validAfter: auth.validAfter ?? null,
            validBefore: auth.validBefore ?? null,
            nonce: auth.nonce ?? null,
            to_matches_payTo: equalAddress(auth.to, expected.payTo),
            value_gte_amount: isBigIntGte(auth.value, expected.amount),
            valid_after_not_future: isBigIntLte(auth.validAfter, String(nowSec)),
            valid_before_not_expired: isBigIntGt(auth.validBefore, String(nowSec + 6))
          }
        : null,
    permit2_checks:
      permit2Auth && expected
        ? {
            top_level_from: submitted?.payload?.from ?? null,
            from: permit2Auth.from ?? null,
            token: permit2Auth.permitted?.token ?? null,
            amount: permit2Auth.permitted?.amount ?? null,
            spender: permit2Auth.spender ?? null,
            spender_matches_proxy: equalAddress(permit2Auth.spender, '0x4020615294c913F045dc10f0a5cdEbd86c280001'),
            deadline: permit2Auth.deadline ?? null,
            witness_to: permit2Auth.witness?.to ?? null,
            witness_validAfter: permit2Auth.witness?.validAfter ?? null,
            has_transaction_object: Boolean(submitted?.payload?.transaction),
            transaction_to: submitted?.payload?.transaction?.to ?? null,
            transaction_data_empty: !submitted?.payload?.transaction?.data || submitted?.payload?.transaction?.data === '0x',
            token_matches_asset: equalAddress(permit2Auth.permitted?.token, expected.asset),
            witness_to_matches_payTo: equalAddress(permit2Auth.witness?.to, expected.payTo),
            amount_gte_required: isBigIntGte(permit2Auth.permitted?.amount, expected.amount),
            witness_valid_after_not_future: isBigIntLte(permit2Auth.witness?.validAfter, String(nowSec)),
            deadline_not_expired: isBigIntGt(permit2Auth.deadline, String(nowSec + 6))
          }
        : null,
    permit2_expected_payload_shape:
      transferMethod === 'permit2'
        ? {
            payload: {
              from: '<buyer_wallet>',
              permit2Authorization: {
                from: '<buyer_wallet>',
                permitted: { token: '<asset>', amount: '<amount>' },
                spender: '0x4020615294c913F045dc10f0a5cdEbd86c280001',
                nonce: '<uint256_string>',
                deadline: '<unix_sec>',
                witness: { to: '<payTo>', validAfter: '<unix_sec>', extra: '0x' }
              },
              signature: '0x<eip712_signature>',
              transaction: {
                to: '<asset>',
                data: '0x<erc20 approve(PERMIT2_ADDRESS, MAX_UINT256) calldata>'
              }
            }
          }
        : null,
    eip712_hint: expected
      ? {
          likely_primary_type: transferMethod === 'permit2' ? 'PermitWitnessTransferFrom' : 'TransferWithAuthorization',
          chainId: expectedChainId,
          verifyingContract:
            transferMethod === 'permit2' ? '0x000000000022D473030F116dDEE9F6B43aC78BA3' : expected.asset ?? null,
          domainName: transferMethod === 'permit2' ? 'Permit2' : expected?.extra?.name ?? 'USD Coin',
          domainVersion: transferMethod === 'permit2' ? null : expected?.extra?.version ?? '2',
          transferMethod,
          note: 'Sign against the exact accepted requirement and current timestamps/nonce.'
        }
      : null,
    mismatch_hints: []
  };

  if (!submitted) {
    info.mismatch_hints.push('Payment header exists but payload could not be base64-decoded as JSON.');
    return info;
  }

  if (!submitted.accepted) {
    info.mismatch_hints.push('Missing top-level accepted object for x402 v2 payload.');
    return info;
  }

  if (paymentRequired?.x402Version != null && submitted.x402Version !== paymentRequired.x402Version) {
    info.mismatch_hints.push(`x402Version mismatch: submitted=${submitted.x402Version} expected=${paymentRequired.x402Version}`);
  }
  if (expected?.scheme && submitted.scheme !== expected.scheme) {
    info.mismatch_hints.push(`scheme mismatch: submitted=${submitted.scheme} expected=${expected.scheme}`);
  }
  if (expected?.network && submitted.network !== expected.network) {
    info.mismatch_hints.push(`network mismatch: submitted=${submitted.network} expected=${expected.network}`);
  }
  if (!info.accepted_exact_match) {
    info.mismatch_hints.push(
      'accepted object must exactly match latest PAYMENT-REQUIRED.accepts[0], including maxTimeoutSeconds and extra fields.'
    );
  }

  if (transferMethod === 'permit2' && permit2Auth && expected) {
    if (submitted?.payload?.authorization) {
      info.mismatch_hints.push(
        'Permit2 mode detected but payload.authorization is also present. Remove payload.authorization so paymentPayload matches permit2 schema.'
      );
    }
    if (!equalAddress(permit2Auth.permitted?.token, expected.asset)) {
      info.mismatch_hints.push(
        `permit2.permitted.token mismatch: submitted=${permit2Auth.permitted?.token} expected=${expected.asset}`
      );
    }
    if (!equalAddress(permit2Auth.witness?.to, expected.payTo)) {
      info.mismatch_hints.push(`permit2.witness.to mismatch: submitted=${permit2Auth.witness?.to} expected=${expected.payTo}`);
    }
    if (submitted?.payload?.from && !equalAddress(submitted.payload.from, permit2Auth.from)) {
      info.mismatch_hints.push(`payload.from mismatch: submitted=${submitted.payload.from} permit2.from=${permit2Auth.from}`);
    }
    if (!equalAddress(permit2Auth.spender, '0x4020615294c913F045dc10f0a5cdEbd86c280001')) {
      info.mismatch_hints.push(
        `permit2.spender mismatch: submitted=${permit2Auth.spender} expected=0x4020615294c913F045dc10f0a5cdEbd86c280001`
      );
    }
    if (!isBigIntGte(permit2Auth.permitted?.amount, expected.amount)) {
      info.mismatch_hints.push(
        `permit2.permitted.amount too low: submitted=${permit2Auth.permitted?.amount} expected>=${expected.amount}`
      );
    }
    if (!isBigIntLte(permit2Auth.witness?.validAfter, String(nowSec))) {
      info.mismatch_hints.push(
        `permit2.witness.validAfter is in the future: submitted=${permit2Auth.witness?.validAfter} now=${nowSec}`
      );
    }
    if (!isBigIntGt(permit2Auth.deadline, String(nowSec + 6))) {
      info.mismatch_hints.push(
        `permit2.deadline expired/too close: submitted=${permit2Auth.deadline} now_plus_6=${nowSec + 6}`
      );
    }
    if (!submitted?.payload?.transaction) {
      info.mismatch_hints.push('Missing payload.transaction for permit2 payment.');
    } else if (!submitted?.payload?.transaction?.data || submitted.payload.transaction.data === '0x') {
      info.mismatch_hints.push('payload.transaction.data is empty. Provide ERC20 approve(PERMIT2_ADDRESS, MAX_UINT256) calldata.');
    }
    if (!submitted?.payload?.signature || typeof submitted.payload.signature !== 'string') {
      info.mismatch_hints.push('Missing payload.signature as top-level hex string for permit2 payment.');
    }
    if (submitted?.payload?.permit2 && !submitted?.payload?.permit2Authorization) {
      info.mismatch_hints.push('Use payload.permit2Authorization (not payload.permit2).');
    }
  } else if (transferMethod === 'permit2' && submitted?.payload && !permit2Auth) {
    info.mismatch_hints.push('Missing payload.permit2Authorization object for permit2 payment.');
    if (submitted?.payload?.permit2) {
      info.mismatch_hints.push('Detected payload.permit2. Rename this field to payload.permit2Authorization.');
    }
  } else if (auth && expected) {
    if (submitted?.payload?.permit2Authorization) {
      info.mismatch_hints.push(
        'EIP-3009 mode detected but payload.permit2Authorization is also present. Remove permit2Authorization so paymentPayload matches eip3009 schema.'
      );
    }
    if (!equalAddress(auth.to, expected.payTo)) {
      info.mismatch_hints.push(`authorization.to mismatch: submitted=${auth.to} expected=${expected.payTo}`);
    }
    if (!isBigIntGte(auth.value, expected.amount)) {
      info.mismatch_hints.push(`authorization.value too low: submitted=${auth.value} expected>=${expected.amount}`);
    }
    if (!isBigIntLte(auth.validAfter, String(nowSec))) {
      info.mismatch_hints.push(`authorization.validAfter is in the future: submitted=${auth.validAfter} now=${nowSec}`);
    }
    if (!isBigIntGt(auth.validBefore, String(nowSec + 6))) {
      info.mismatch_hints.push(
        `authorization.validBefore expired/too close: submitted=${auth.validBefore} now_plus_6=${nowSec + 6}`
      );
    }
  } else if (submitted.payload && !auth && !permit2Auth) {
    info.mismatch_hints.push('Missing payload.authorization object for exact/eip3009 payment.');
  }

  if (transferMethod === 'eip3009' && permit2Auth && !auth) {
    info.mismatch_hints.push(
      'Server currently expects eip3009 for this quote, but payload contains permit2Authorization only. Re-sign with TransferWithAuthorization using the latest PAYMENT-REQUIRED.'
    );
  }

  return info;
}

function buildPaymentSigningInstructions(paymentRequired) {
  const accepted = paymentRequired?.accepts?.[0];
  if (!accepted) return null;
  const transferMethod = String(accepted?.extra?.assetTransferMethod || 'eip3009').toLowerCase();
  const base = {
    x402_version: paymentRequired?.x402Version ?? 2,
    transfer_method: transferMethod,
    required_top_level_fields: ['x402Version', 'scheme', 'network', 'accepted', 'payload'],
    required_header: 'PAYMENT-SIGNATURE',
    header_format: 'base64(JSON.stringify(x402_payload))',
    accepted_must_match: 'accepted must exactly equal PAYMENT-REQUIRED.accepts[0]',
    wallet_hint: 'Send X-WALLET-ADDRESS on paywall and paid retry requests for wallet-type-aware method selection.',
    method_rules: {
      eip3009: {
        typed_data_primary_type: 'TransferWithAuthorization',
        required_payload_fields: ['payload.authorization', 'payload.signature'],
        forbidden_payload_fields: ['payload.authorization.signature', 'payload.permit2Authorization', 'payload.transaction'],
        authorization_fields: ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']
      },
      permit2: {
        typed_data_primary_type: 'PermitWitnessTransferFrom',
        required_payload_fields: ['payload.from', 'payload.permit2Authorization', 'payload.transaction', 'payload.signature'],
        forbidden_payload_fields: ['payload.authorization', 'payload.permit2'],
        permit2_authorization_fields: ['from', 'permitted.token', 'permitted.amount', 'spender', 'nonce', 'deadline', 'witness.to', 'witness.validAfter', 'witness.extra']
      }
    }
  };
  return {
    ...base,
    selected_rule: transferMethod === 'permit2' ? base.method_rules.permit2 : base.method_rules.eip3009
  };
}

function buildPaymentSigningInstructionsForMethod(method) {
  const transferMethod = String(method || 'eip3009').toLowerCase() === 'permit2' ? 'permit2' : 'eip3009';
  const base = {
    x402_version: 2,
    transfer_method: transferMethod,
    required_top_level_fields: ['x402Version', 'scheme', 'network', 'accepted', 'payload'],
    required_header: 'PAYMENT-SIGNATURE',
    header_format: 'base64(JSON.stringify(x402_payload))',
    accepted_must_match: 'accepted must exactly equal PAYMENT-REQUIRED.accepts[0]',
    wallet_hint: 'Send X-WALLET-ADDRESS on paywall and paid retry requests for wallet-type-aware method selection.',
    method_rules: {
      eip3009: {
        typed_data_primary_type: 'TransferWithAuthorization',
        required_payload_fields: ['payload.authorization', 'payload.signature'],
        forbidden_payload_fields: ['payload.authorization.signature', 'payload.permit2Authorization', 'payload.transaction'],
        authorization_fields: ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce']
      },
      permit2: {
        typed_data_primary_type: 'PermitWitnessTransferFrom',
        required_payload_fields: ['payload.from', 'payload.permit2Authorization', 'payload.transaction', 'payload.signature'],
        forbidden_payload_fields: ['payload.authorization', 'payload.permit2'],
        permit2_authorization_fields: ['from', 'permitted.token', 'permitted.amount', 'spender', 'nonce', 'deadline', 'witness.to', 'witness.validAfter', 'witness.extra']
      }
    }
  };
  return {
    ...base,
    selected_rule: transferMethod === 'permit2' ? base.method_rules.permit2 : base.method_rules.eip3009
  };
}

function buildCopyPastePaymentPayloadTemplate(paymentRequired) {
  const accepted = paymentRequired?.accepts?.[0];
  if (!accepted) return null;
  const transferMethod = String(accepted?.extra?.assetTransferMethod || 'eip3009').toLowerCase();
  const baseTemplate = {
    x402Version: paymentRequired?.x402Version ?? 2,
    scheme: accepted.scheme,
    network: accepted.network,
    accepted
  };

  if (transferMethod === 'permit2') {
    return {
      ...baseTemplate,
      payload: {
        from: '<buyer_wallet>',
        permit2Authorization: {
          from: '<buyer_wallet>',
          permitted: {
            token: accepted.asset,
            amount: accepted.amount
          },
          spender: '0x4020615294c913F045dc10f0a5cdEbd86c280001',
          nonce: '<uint256_string>',
          deadline: '<unix_sec>',
          witness: {
            to: accepted.payTo,
            validAfter: '<unix_sec>',
            extra: '0x'
          }
        },
        transaction: {
          to: accepted.asset,
          data: '0x<erc20 approve(PERMIT2_ADDRESS, MAX_UINT256) calldata>'
        },
        signature: '0x<eip712_signature>'
      }
    };
  }

  return {
    ...baseTemplate,
    payload: {
      authorization: {
        from: '<buyer_wallet>',
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: '<unix_sec>',
        validBefore: '<unix_sec>',
        nonce: '0x<32byte_hex>'
      },
      signature: '0x<eip712_signature>'
    }
  };
}

function toChainId(network) {
  if (typeof network !== 'string') return null;
  const [, id] = network.split(':');
  if (!id) return null;
  const asNumber = Number(id);
  return Number.isFinite(asNumber) ? asNumber : null;
}

function equalAddress(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function isBigIntGte(a, b) {
  try {
    return BigInt(String(a)) >= BigInt(String(b));
  } catch (_) {
    return false;
  }
}

function isBigIntLte(a, b) {
  try {
    return BigInt(String(a)) <= BigInt(String(b));
  } catch (_) {
    return false;
  }
}

function isBigIntGt(a, b) {
  try {
    return BigInt(String(a)) > BigInt(String(b));
  } catch (_) {
    return false;
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a == null || b == null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object') {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (!deepEqual(aKeys, bKeys)) return false;
    for (const key of aKeys) {
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

function diffObjects(actual, expected, prefix = '') {
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') return [];

  const diffs = [];
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const a = actual[key];
    const e = expected[key];
    const aIsObj = a && typeof a === 'object' && !Array.isArray(a);
    const eIsObj = e && typeof e === 'object' && !Array.isArray(e);

    if (aIsObj && eIsObj) {
      diffs.push(...diffObjects(a, e, path));
      continue;
    }

    if (!deepEqual(a, e)) {
      diffs.push({
        field: path,
        submitted: a ?? null,
        expected: e ?? null
      });
    }
  }
  return diffs;
}

function extractX402Error(error) {
  if (!error || typeof error !== 'object') {
    return { message: String(error || 'unknown') };
  }

  const result = {
    name: error.name || null,
    message: error.message || String(error),
    statusCode: error.statusCode ?? null,
    errorReason: error.errorReason ?? null,
    errorMessage: error.errorMessage ?? null,
    invalidReason: error.invalidReason ?? null,
    invalidMessage: error.invalidMessage ?? null,
    transaction: error.transaction ?? null,
    network: error.network ?? null,
    payer: error.payer ?? null
  };

  return result;
}

function shouldIncludeDebug(req) {
  const queryDebug = String(req?.query?.debug || '').toLowerCase();
  if (queryDebug === '1' || queryDebug === 'true') return true;
  return String(process.env.X402_VERBOSE_DEBUG || '').toLowerCase() === 'true';
}

function validatePaymentPayloadContract({ paymentPayload, paymentRequirements }) {
  const transferMethod = String(paymentRequirements?.extra?.assetTransferMethod || 'eip3009').toLowerCase();
  const payload = paymentPayload?.payload && typeof paymentPayload.payload === 'object' ? paymentPayload.payload : null;

  if (!payload) {
    return {
      ok: false,
      code: 'missing_payload_object',
      flowHint: 'PAYMENT-SIGNATURE must decode to JSON containing a top-level payload object.',
      required: { top_level: ['x402Version', 'scheme', 'network', 'accepted', 'payload'] },
      mismatchHints: ['Missing top-level payload object.'],
      shape: null,
      preview: paymentPayload || null
    };
  }

  if (transferMethod !== 'eip3009') {
    return { ok: true };
  }

  const auth = payload.authorization && typeof payload.authorization === 'object' ? payload.authorization : null;
  const signature = typeof payload.signature === 'string' ? payload.signature : null;
  const mismatchHints = [];

  if (!auth) {
    mismatchHints.push('Missing payload.authorization for eip3009 payment.');
  }
  if (!signature) {
    mismatchHints.push('Missing payload.signature for eip3009 payment.');
  }
  if (auth?.signature) {
    mismatchHints.push('Do not nest signature under payload.authorization.signature; use payload.signature.');
  }

  if (!auth || !signature) {
    return {
      ok: false,
      code: 'invalid_eip3009_payload_shape',
      flowHint:
        'For eip3009, send payload.signature at payload root and payload.authorization with from/to/value/validAfter/validBefore/nonce.',
      required: {
        eip3009_payload: {
          payload: {
            signature: '0x<eip712_signature>',
            authorization: {
              from: '<buyer_wallet>',
              to: '<payTo>',
              value: '<amount>',
              validAfter: '<unix_sec>',
              validBefore: '<unix_sec>',
              nonce: '0x<bytes32>'
            }
          }
        }
      },
      mismatchHints,
      shape: {
        hasPayload: Boolean(payload),
        hasSignature: Boolean(signature),
        hasAuthorization: Boolean(auth),
        hasAuthorizationSignature: Boolean(auth?.signature)
      },
      preview: paymentPayload || null
    };
  }

  const domain = {
    name: paymentRequirements?.extra?.name ?? 'USD Coin',
    version: paymentRequirements?.extra?.version ?? '2',
    chainId: toChainId(paymentRequirements?.network) ?? 8453,
    verifyingContract: paymentRequirements?.asset ?? null
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
  const message = {
    from: auth.from,
    to: auth.to,
    value: auth.value,
    validAfter: auth.validAfter,
    validBefore: auth.validBefore,
    nonce: auth.nonce
  };

  try {
    const recovered = ethers.verifyTypedData(domain, types, message, signature);
    if (!equalAddress(recovered, auth.from)) {
      return {
        ok: false,
        code: 'signature_authorizer_mismatch',
        flowHint:
          'EIP-712 signature does not match authorization.from. Re-sign the exact authorization object from the latest PAYMENT-REQUIRED and retry.',
        required: null,
        mismatchHints: [
          `Recovered signer ${recovered} does not match authorization.from ${String(auth.from || '')}.`
        ],
        shape: {
          recovered,
          authorization_from: auth.from ?? null
        },
        preview: paymentPayload || null
      };
    }
  } catch (error) {
    return {
      ok: false,
      code: 'signature_verification_failed',
      flowHint:
        'Unable to verify EIP-712 signature against payload.authorization. Ensure domain/message match and signature is in payload.signature.',
      required: null,
      mismatchHints: [error instanceof Error ? error.message : String(error)],
      shape: null,
      preview: paymentPayload || null
    };
  }

  return { ok: true };
}

async function buildSettlementDiagnostics({ paymentPayload, paymentRequirements }) {
  const payload = paymentPayload?.payload || {};
  const auth = payload.authorization || null;
  const transferMethod = String(paymentRequirements?.extra?.assetTransferMethod || 'eip3009').toLowerCase();
  const nowSec = Math.floor(Date.now() / 1000);
  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  const expectedChainId = toChainId(paymentRequirements?.network) ?? 8453;
  const domain = {
    name: paymentRequirements?.extra?.name ?? 'USD Coin',
    version: paymentRequirements?.extra?.version ?? '2',
    chainId: expectedChainId,
    verifyingContract: paymentRequirements?.asset ?? null
  };
  const typedDataTypes = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' }
    ]
  };
  let signatureParts = null;
  try {
    signatureParts = payload?.signature ? ethers.Signature.from(payload.signature) : null;
  } catch (_) {
    signatureParts = null;
  }
  let recoveredSigner = null;
  let typedDataDigest = null;
  let computedDomainSeparator = null;
  let signatureSIsLow = null;
  let signatureS = null;
  let signatureSMaxHalfOrder = null;
  const secp256k1HalfOrder = BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0');
  if (auth && payload?.signature && domain.verifyingContract) {
    try {
      typedDataDigest = ethers.TypedDataEncoder.hash(domain, typedDataTypes, auth);
      computedDomainSeparator = ethers.TypedDataEncoder.hashDomain(domain);
      recoveredSigner = ethers.verifyTypedData(domain, typedDataTypes, auth, payload.signature);
    } catch (_) {
      typedDataDigest = null;
      computedDomainSeparator = null;
      recoveredSigner = null;
    }
  }
  if (signatureParts?.s) {
    signatureS = signatureParts.s;
    try {
      const sBigInt = BigInt(signatureParts.s);
      signatureSMaxHalfOrder = `0x${secp256k1HalfOrder.toString(16)}`;
      signatureSIsLow = sBigInt <= secp256k1HalfOrder;
    } catch (_) {
      signatureSIsLow = null;
    }
  }

  const diagnostics = {
    transfer_method: transferMethod,
    payer: auth?.from ?? null,
    authorization: auth
      ? {
          from: auth.from ?? null,
          to: auth.to ?? null,
          value: auth.value ?? null,
          validAfter: auth.validAfter ?? null,
          validBefore: auth.validBefore ?? null,
          nonce: auth.nonce ?? null
        }
      : null,
    checks: {
      has_authorization: Boolean(auth),
      to_matches_payTo: auth ? equalAddress(auth.to, paymentRequirements?.payTo) : null,
      value_gte_required: auth ? isBigIntGte(auth.value, paymentRequirements?.amount) : null,
      valid_after_not_future: auth ? isBigIntLte(auth.validAfter, String(nowSec)) : null,
      valid_before_not_expired: auth ? isBigIntGt(auth.validBefore, String(nowSec + 6)) : null,
      nonce_hex_32bytes: auth?.nonce ? /^0x[0-9a-fA-F]{64}$/.test(String(auth.nonce)) : null
    },
    eip712_precheck: {
      domain,
      type: 'TransferWithAuthorization',
      signature: payload?.signature ? redactHex(payload.signature) : null,
      signature_hex_length: typeof payload?.signature === 'string' ? payload.signature.length : null,
      signature_parse_ok: Boolean(signatureParts),
      signature_v: signatureParts?.v ?? null,
      signature_y_parity: signatureParts?.yParity ?? null,
      signature_s: signatureS,
      signature_s_is_low: signatureSIsLow,
      signature_s_max_half_order: signatureSMaxHalfOrder,
      typed_data_digest: typedDataDigest,
      computed_domain_separator: computedDomainSeparator,
      recovered_signer: recoveredSigner,
      from_matches_recovered: recoveredSigner && auth?.from ? equalAddress(recoveredSigner, auth.from) : null
    },
    chain_prechecks: null
  };

  if (!auth || !paymentRequirements?.asset) {
    return diagnostics;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl, 8453);
    const erc20Abi = [
      'function balanceOf(address account) view returns (uint256)',
      'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
      'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature) returns (bool)',
      'function name() view returns (string)',
      'function version() view returns (string)',
      'function DOMAIN_SEPARATOR() view returns (bytes32)'
    ];
    const usdc = new ethers.Contract(paymentRequirements.asset, erc20Abi, provider);
    const balance = await usdc.balanceOf(auth.from);
    let tokenName = null;
    let tokenVersion = null;
    let tokenDomainSeparator = null;
    try {
      tokenName = await usdc.name();
    } catch (_) {
      tokenName = null;
    }
    try {
      tokenVersion = await usdc.version();
    } catch (_) {
      tokenVersion = null;
    }
    try {
      tokenDomainSeparator = await usdc.DOMAIN_SEPARATOR();
    } catch (_) {
      tokenDomainSeparator = null;
    }
    let authorizationUsed = null;
    try {
      authorizationUsed = await usdc.authorizationState(auth.from, auth.nonce);
    } catch (_) {
      authorizationUsed = null;
    }

    // Simulate transferWithAuthorization to surface revert reason candidates.
    const transfer_simulation = await simulateTransferWithAuthorization({
      provider,
      usdc,
      asset: paymentRequirements.asset,
      auth,
      signature: payload.signature
    });

    let signature_variant_simulations = null;
    if (payload?.signature) {
      signature_variant_simulations = await runSignatureVariantMatrix({
        provider,
        usdc,
        asset: paymentRequirements.asset,
        auth,
        signature: payload.signature
      });
    }

    let time_window_variant_simulations = null;
    if (payload?.signature) {
      time_window_variant_simulations = await runTimeWindowVariantMatrix({
        provider,
        usdc,
        asset: paymentRequirements.asset,
        auth,
        signature: payload.signature,
        nowSec
      });
    }

    diagnostics.chain_prechecks = {
      rpc_url: rpcUrl,
      usdc_balance: balance?.toString?.() ?? String(balance),
      required_amount: String(paymentRequirements.amount),
      balance_gte_required: isBigIntGte(balance?.toString?.() ?? null, paymentRequirements.amount),
      authorization_used: authorizationUsed == null ? null : Boolean(authorizationUsed),
      token_metadata: {
        name: tokenName,
        version: tokenVersion,
        domain_separator: tokenDomainSeparator,
        computed_domain_separator: computedDomainSeparator,
        domain_separator_matches_signed:
          computedDomainSeparator && tokenDomainSeparator
            ? String(computedDomainSeparator).toLowerCase() === String(tokenDomainSeparator).toLowerCase()
            : null,
        domain_name_matches_signed: tokenName ? tokenName === domain.name : null,
        domain_version_matches_signed: tokenVersion ? tokenVersion === domain.version : null
      },
      call_payload_preview: buildTransferCallPreview({
        usdc,
        asset: paymentRequirements.asset,
        auth,
        signature: payload.signature
      }),
      transfer_simulation,
      transfer_simulation_with_from_variants: await runFromVariantCallMatrix({
        provider,
        usdc,
        asset: paymentRequirements.asset,
        auth,
        signature: payload.signature
      }),
      transfer_estimate_gas_with_from_variants: await runFromVariantEstimateGasMatrix({
        provider,
        usdc,
        asset: paymentRequirements.asset,
        auth,
        signature: payload.signature
      }),
      signature_variant_simulations,
      time_window_variant_simulations
    };
  } catch (error) {
    diagnostics.chain_prechecks = {
      rpc_url: rpcUrl,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  return diagnostics;
}

function redactHex(value) {
  const raw = String(value || '');
  if (!raw) return null;
  if (raw.length <= 20) return raw;
  return `${raw.slice(0, 10)}...${raw.slice(-10)} (len=${raw.length})`;
}

async function simulateTransferWithAuthorization({ provider, usdc, asset, auth, signature }) {
  try {
    const data = usdc.interface.encodeFunctionData('transferWithAuthorization', [
      auth.from,
      auth.to,
      auth.value,
      auth.validAfter,
      auth.validBefore,
      auth.nonce,
      signature
    ]);
    await provider.call({
      to: asset,
      data
    });
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function buildTransferCallPreview({ usdc, asset, auth, signature }) {
  try {
    const data = usdc.interface.encodeFunctionData('transferWithAuthorization', [
      auth.from,
      auth.to,
      auth.value,
      auth.validAfter,
      auth.validBefore,
      auth.nonce,
      signature
    ]);
    return {
      to: asset,
      selector: data.slice(0, 10),
      data: redactHex(data),
      from: auth.from
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function runFromVariantCallMatrix({ provider, usdc, asset, auth, signature }) {
  const variants = [
    { label: 'no_from', from: undefined },
    { label: 'from_authorizer', from: auth.from },
    { label: 'from_zero', from: '0x0000000000000000000000000000000000000000' }
  ];
  const results = [];
  const data = usdc.interface.encodeFunctionData('transferWithAuthorization', [
    auth.from,
    auth.to,
    auth.value,
    auth.validAfter,
    auth.validBefore,
    auth.nonce,
    signature
  ]);
  for (const variant of variants) {
    try {
      const tx = { to: asset, data };
      if (variant.from) tx.from = variant.from;
      await provider.call(tx);
      results.push({ label: variant.label, from: variant.from ?? null, ok: true, error: null });
    } catch (error) {
      results.push({
        label: variant.label,
        from: variant.from ?? null,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}

async function runFromVariantEstimateGasMatrix({ provider, usdc, asset, auth, signature }) {
  const variants = [
    { label: 'no_from', from: undefined },
    { label: 'from_authorizer', from: auth.from },
    { label: 'from_zero', from: '0x0000000000000000000000000000000000000000' }
  ];
  const results = [];
  const data = usdc.interface.encodeFunctionData('transferWithAuthorization', [
    auth.from,
    auth.to,
    auth.value,
    auth.validAfter,
    auth.validBefore,
    auth.nonce,
    signature
  ]);
  for (const variant of variants) {
    try {
      const tx = { to: asset, data };
      if (variant.from) tx.from = variant.from;
      const gas = await provider.estimateGas(tx);
      results.push({ label: variant.label, from: variant.from ?? null, ok: true, gas: gas?.toString?.() ?? String(gas), error: null });
    } catch (error) {
      results.push({
        label: variant.label,
        from: variant.from ?? null,
        ok: false,
        gas: null,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}

async function runSignatureVariantMatrix({ provider, usdc, asset, auth, signature }) {
  const parts = ethers.Signature.from(signature);
  const variants = [];

  const original = parts.serialized;
  const v27 = ethers.Signature.from({ r: parts.r, s: parts.s, yParity: 0 }).serialized;
  const v28 = ethers.Signature.from({ r: parts.r, s: parts.s, yParity: 1 }).serialized;
  const compact = parts.compactSerialized;

  variants.push({ label: 'original', signature: original });
  variants.push({ label: 'force_v27', signature: v27 });
  variants.push({ label: 'force_v28', signature: v28 });
  variants.push({ label: 'compact_2098', signature: compact });
  if (compact && compact !== original) {
    const expandedFromCompact = ethers.Signature.from(compact).serialized;
    variants.push({ label: 'expanded_from_2098', signature: expandedFromCompact });
  }

  const deduped = [];
  const seen = new Set();
  for (const item of variants) {
    if (seen.has(item.signature)) continue;
    seen.add(item.signature);
    deduped.push(item);
  }

  const results = [];
  for (const item of deduped) {
    const simulation = await simulateTransferWithAuthorization({
      provider,
      usdc,
      asset,
      auth,
      signature: item.signature
    });
    const parsed = ethers.Signature.from(item.signature);
    results.push({
      label: item.label,
      signature: redactHex(item.signature),
      length: item.signature.length,
      v: parsed.v,
      y_parity: parsed.yParity,
      ok: simulation.ok,
      error: simulation.error
    });
  }

  return results;
}

async function runTimeWindowVariantMatrix({ provider, usdc, asset, auth, signature, nowSec }) {
  const variants = [
    {
      label: 'as_submitted',
      validAfter: auth.validAfter,
      validBefore: auth.validBefore
    },
    {
      label: 'validAfter_now_minus_60',
      validAfter: String(Math.max(0, nowSec - 60)),
      validBefore: auth.validBefore
    },
    {
      label: 'validAfter_zero_validBefore_now_plus_300',
      validAfter: '0',
      validBefore: String(nowSec + 300)
    }
  ];

  const results = [];
  for (const variant of variants) {
    const variantAuth = {
      ...auth,
      validAfter: variant.validAfter,
      validBefore: variant.validBefore
    };
    const simulation = await simulateTransferWithAuthorization({
      provider,
      usdc,
      asset,
      auth: variantAuth,
      signature
    });
    results.push({
      label: variant.label,
      validAfter: variant.validAfter,
      validBefore: variant.validBefore,
      ok: simulation.ok,
      error: simulation.error
    });
  }

  return results;
}
