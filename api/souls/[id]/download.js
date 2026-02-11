import { getSoul, loadSoulContent, soulIds } from '../../_lib/catalog.js';
import {
  buildAuthMessage,
  createPurchaseReceipt,
  getSellerAddress,
  setCors,
  verifyPurchaseReceipt,
  verifyWalletAuth
} from '../../_lib/payments.js';
import { applyInstructionResponse, createRequestContext, getX402HTTPServer } from '../../_lib/x402.js';

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
          result.response.body.flow_hint =
            'Payment header was detected but could not be verified/settled. Regenerate PAYMENT-SIGNATURE from the latest PAYMENT-REQUIRED and retry.';
          result.response.body.payment_debug = paymentDebug;
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
          hasSignature: Boolean(submitted.payload?.signature)
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
  if (!shallowEqual(selectedAcceptedSummary(submitted.accepted), selectedAcceptedSummary(expected))) {
    info.mismatch_hints.push('accepted object does not match latest PAYMENT-REQUIRED.accepts[0].');
  }

  return info;
}

function selectedAcceptedSummary(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    scheme: value.scheme ?? null,
    network: value.network ?? null,
    amount: value.amount ?? null,
    asset: value.asset ?? null,
    payTo: value.payTo ?? null
  };
}

function shallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
