import { getSoul, loadSoulContent, soulIds } from '../../_lib/catalog.js';
import {
  buildAuthMessage,
  createPurchaseReceipt,
  getSellerAddress,
  setCors,
  verifyPurchaseReceipt,
  verifyWalletAuth
} from '../../_lib/payments.js';
import { applyInstructionResponse, createRequestContext, getX402HTTPServer, inspectFacilitatorVerify } from '../../_lib/x402.js';

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

  const sellerAddress = getSellerAddress();
  if (!sellerAddress) {
    return res.status(500).json({ error: 'Server configuration error: SELLER_ADDRESS is required' });
  }

  // Re-download path: wallet re-auth + signed purchase receipt.
  const wallet = req.headers['x-wallet-address'];
  const authSignature = req.headers['x-auth-signature'];
  const authTimestamp = req.headers['x-auth-timestamp'];
  const receipt = req.headers['x-purchase-receipt'];
  const paymentSignature = req.headers['payment-signature'];

  if (wallet && authSignature && authTimestamp && receipt && !paymentSignature) {
    const authCheck = verifyWalletAuth({
      wallet,
      soulId,
      action: 'redownload',
      timestamp: authTimestamp,
      signature: authSignature
    });

    if (!authCheck.ok) {
      return res.status(401).json({ error: authCheck.error });
    }

    const receiptCheck = verifyPurchaseReceipt({
      receipt,
      wallet: authCheck.wallet,
      soulId
    });

    if (!receiptCheck.ok) {
      return res.status(401).json({ error: receiptCheck.error });
    }

    const content = await loadSoulContent(soulId);
    if (!content) {
      return res.status(500).json({ error: 'Soul unavailable' });
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

    const settlement = await httpServer.processSettlement(
      result.paymentPayload,
      result.paymentRequirements,
      result.declaredExtensions
    );

    if (!settlement.success) {
      return res.status(402).json({
        error: 'Settlement failed',
        reason: settlement.errorReason,
        message: settlement.errorMessage
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

    if (receiptToken) {
      res.setHeader('X-PURCHASE-RECEIPT', receiptToken);
    }

    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="${soulId}-SOUL.md"`);
    return res.status(200).send(content);
  } catch (error) {
    console.error('x402 processing failed:', error);
    return res.status(500).json({ error: 'Payment processing failed' });
  }
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

function buildPaymentDebug(req, paymentRequired) {
  const submitted = decodeSubmittedPayment(req);
  const expected = paymentRequired?.accepts?.[0] || null;
  const auth = submitted?.payload?.authorization || null;
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
          hasSignature: Boolean(submitted.payload?.signature),
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
          payTo: expected.payTo ?? null
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
    eip712_hint: expected
      ? {
          likely_primary_type: 'TransferWithAuthorization',
          chainId: expectedChainId,
          verifyingContract: expected.asset ?? null,
          domainName: expected?.extra?.name ?? 'USD Coin',
          domainVersion: expected?.extra?.version ?? '2',
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

  if (auth && expected) {
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
  } else if (submitted.payload && !auth) {
    info.mismatch_hints.push('Missing payload.authorization object for exact/eip3009 payment.');
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
