import { getSoul, loadSoulContent, soulIds } from '../../_lib/catalog.js';
import { ethers } from 'ethers';
import {
  buildRedownloadSessionSetCookie,
  buildAuthMessage,
  createRedownloadSessionToken,
  createPurchaseReceipt,
  getSellerAddress,
  parseCookieHeader,
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

const SETTLE_RETRY_DELAYS_MS = String(process.env.X402_SETTLE_RETRY_DELAYS_MS || '500')
  .split(',')
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v >= 0);
const SETTLE_INITIAL_DELAY_MS = Number(process.env.X402_SETTLE_INITIAL_DELAY_MS || '0');
const inFlightSettlements = new Map();
const entitlementCache = new Map();
const ENTITLEMENT_CACHE_TTL_MS = Number(process.env.ENTITLEMENT_CACHE_TTL_MS || String(7 * 24 * 60 * 60 * 1000));

export default async function handler(req, res) {
  setCors(res, req.headers.origin);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const soulId = req.query.id;
  const soul = getSoul(soulId);
  if (!soul) {
    return res.status(404).json({ error: 'Soul not found', available_souls: soulIds() });
  }

  const sellerAddress = soul.sellerAddress || getSellerAddress();
  if (!sellerAddress) {
    return res.status(500).json({ error: 'Server configuration error: SELLER_ADDRESS is required' });
  }

  // Re-download path: wallet re-auth + signed purchase receipt.
  const wallet = req.headers['x-wallet-address'];
  const authSignature = req.headers['x-auth-signature'];
  const authTimestamp = req.headers['x-auth-timestamp'];
  const receipt = req.headers['x-purchase-receipt'];
  const cookies = parseCookieHeader(req.headers.cookie);
  const redownloadSessionToken = req.headers['x-redownload-session'] || cookies.soulstarter_redownload_session || null;
  const paymentSignature = req.headers['payment-signature'] || req.headers.payment || req.headers['x-payment'];

  if (wallet && receipt && ((authSignature && authTimestamp) || redownloadSessionToken)) {
    let authWallet = String(wallet || '').toLowerCase();
    let usedSignedAuth = false;
    if (authSignature && authTimestamp) {
      const authCheck = verifyWalletAuth({
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

    const receiptCheck = verifyPurchaseReceipt({
      receipt,
      wallet: authWallet,
      soulId
    });

    if (!receiptCheck.ok) {
      return res.status(401).json({ error: receiptCheck.error });
    }

    const content = await loadSoulContent(soulId);
    if (!content) {
      return res.status(500).json({ error: 'Soul unavailable' });
    }
    cacheEntitlement({
      wallet: authWallet,
      soulId,
      transaction: receiptCheck.transaction || 'prior-entitlement'
    });
    if (usedSignedAuth) {
      try {
        const sessionToken = createRedownloadSessionToken({ wallet: authWallet });
        res.setHeader('Set-Cookie', buildRedownloadSessionSetCookie({ token: sessionToken, reqHost: req.headers.host }));
      } catch (_) {}
    }

    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="${soulId}-SOUL.md"`);
    res.setHeader(
      'PAYMENT-RESPONSE',
      Buffer.from(
        JSON.stringify({
          success: true,
          transaction: receiptCheck.transaction || 'prior-entitlement',
          network: 'eip155:8453',
          soulDelivered: soulId,
          entitlementSource: 'receipt'
        })
      ).toString('base64')
    );

    return res.status(200).send(content);
  }

  try {
    rewriteIncomingPaymentHeader(req);
    const httpServer = await getX402HTTPServer({ soulId, soul, sellerAddress });
    const context = createRequestContext(req);
    const result = await httpServer.processHTTPRequest(context);

    if (result.type === 'payment-error') {
      if (result.response?.body && typeof result.response.body === 'object') {
        const paymentRequired = decodePaymentRequiredHeader(result.response?.headers);
        const paymentDebug = buildPaymentDebug(req, paymentRequired);

        if (!context.paymentHeader) {
          result.response.body.auth_message_template = buildAuthMessage({
            wallet: '0x<your-wallet>',
            soulId,
            action: 'redownload',
            timestamp: Date.now()
          });
          result.response.body.flow_hint =
            'No payment header was detected. Send PAYMENT-SIGNATURE (or PAYMENT/X-PAYMENT) with base64-encoded x402 payload for purchase.';
        } else {
          const submittedPayment = decodeSubmittedPayment(req);
          const facilitatorVerify = await inspectFacilitatorVerify({
            paymentPayload: submittedPayment,
            paymentRequirements: paymentRequired?.accepts?.[0] || null,
            x402Version: paymentRequired?.x402Version ?? submittedPayment?.x402Version ?? 2
          });
          result.response.body.flow_hint =
            'Payment header was detected but could not be verified/settled. Regenerate PAYMENT-SIGNATURE from the latest PAYMENT-REQUIRED and retry.';
          result.response.body.payment_debug = {
            ...paymentDebug,
            facilitator_verify: facilitatorVerify
          };
        }
      }
      return applyInstructionResponse(res, result.response);
    }

    if (result.type !== 'payment-verified') {
      return res.status(500).json({ error: 'Unexpected x402 processing state' });
    }

    const content = await loadSoulContent(soulId);
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
      const settlementDiagnostics = await buildSettlementDiagnostics({
        paymentPayload: result.paymentPayload,
        paymentRequirements: result.paymentRequirements
      });
      const cdpSettleRequestDebug = buildCdpRequestDebug({
        paymentPayload: result.paymentPayload,
        paymentRequirements: result.paymentRequirements,
        x402Version: result.paymentPayload?.x402Version ?? 2
      });
      return res.status(402).json({
        error: 'Settlement failed',
        reason: settlement.errorReason,
        message: settlement.errorMessage,
        settlement_diagnostics: settlementDiagnostics,
        settlement_attempts: settlementResult.attempts,
        cdp_settle_request_preview: {
          top_level_x402Version: cdpSettleRequestDebug?.top_level_x402Version ?? null,
          transfer_method: cdpSettleRequestDebug?.transfer_method ?? null,
          paymentPayload_keys: cdpSettleRequestDebug?.paymentPayload_keys ?? [],
          paymentRequirements_keys: cdpSettleRequestDebug?.paymentRequirements_keys ?? [],
          paymentPayload_field_types: cdpSettleRequestDebug?.paymentPayload_field_types ?? null,
          paymentPayload_field_checks: cdpSettleRequestDebug?.paymentPayload_field_checks ?? null
        },
        cdp_settle_request_redacted: cdpSettleRequestDebug?.cdp_request_redacted ?? null
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
    }
    if (settlement.success && settlement.payer) {
      try {
        const sessionToken = createRedownloadSessionToken({ wallet: settlement.payer });
        res.setHeader('Set-Cookie', buildRedownloadSessionSetCookie({ token: sessionToken, reqHost: req.headers.host }));
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
  const raw =
    req.headers['payment-signature'] || req.headers.payment || req.headers['x-payment'] || req.headers['PAYMENT-SIGNATURE'];
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
    : req.headers.payment
      ? 'payment'
      : req.headers['x-payment']
        ? 'x-payment'
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

  if (transferMethod === 'permit2') {
    if (payload.permit2 && !payload.permit2Authorization) {
      payload.permit2Authorization = payload.permit2;
    }
    delete payload.permit2;
    delete payload.authorization;
  } else {
    delete payload.transaction;
    delete payload.permit2Authorization;
    delete payload.permit2;
  }

  return {
    ...submitted,
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
    : req.headers.payment
      ? 'PAYMENT'
      : req.headers['x-payment']
        ? 'X-PAYMENT'
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
