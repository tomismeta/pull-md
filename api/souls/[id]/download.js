import { getSoul, loadSoulContent, soulIds } from '../../_lib/catalog.js';
import { ethers } from 'ethers';
import {
  buildAuthMessage,
  createPurchaseReceipt,
  getSellerAddress,
  setCors,
  verifyPurchaseReceipt,
  verifyWalletAuth
} from '../../_lib/payments.js';
import {
  applyInstructionResponse,
  buildCdpRequestDebug,
  createRequestContext,
  getX402HTTPServer,
  inspectFacilitatorVerify
} from '../../_lib/x402.js';

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

    let settlement;
    try {
      settlement = await httpServer.processSettlement(
        result.paymentPayload,
        result.paymentRequirements,
        result.declaredExtensions
      );
    } catch (error) {
      return res.status(402).json({
        error: 'Settlement threw an exception',
        settlement_debug: extractX402Error(error)
      });
    }

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
        cdp_settle_request_preview: {
          top_level_x402Version: cdpSettleRequestDebug?.top_level_x402Version ?? null,
          transfer_method: cdpSettleRequestDebug?.transfer_method ?? null,
          paymentPayload_keys: cdpSettleRequestDebug?.paymentPayload_keys ?? [],
          paymentRequirements_keys: cdpSettleRequestDebug?.paymentRequirements_keys ?? []
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

    if (receiptToken) {
      res.setHeader('X-PURCHASE-RECEIPT', receiptToken);
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
    chain_prechecks: null
  };

  if (!auth || !paymentRequirements?.asset) {
    return diagnostics;
  }

  try {
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl, 8453);
    const erc20Abi = [
      'function balanceOf(address account) view returns (uint256)',
      'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
      'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature) returns (bool)'
    ];
    const usdc = new ethers.Contract(paymentRequirements.asset, erc20Abi, provider);
    const balance = await usdc.balanceOf(auth.from);
    let authorizationUsed = null;
    try {
      authorizationUsed = await usdc.authorizationState(auth.from, auth.nonce);
    } catch (_) {
      authorizationUsed = null;
    }

    // Simulate transferWithAuthorization to surface revert reason candidates.
    let transfer_simulation = { ok: null, error: null };
    try {
      const data = usdc.interface.encodeFunctionData('transferWithAuthorization', [
        auth.from,
        auth.to,
        auth.value,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        payload.signature
      ]);
      await provider.call({
        to: paymentRequirements.asset,
        data
      });
      transfer_simulation = { ok: true, error: null };
    } catch (error) {
      transfer_simulation = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    diagnostics.chain_prechecks = {
      rpc_url: rpcUrl,
      usdc_balance: balance?.toString?.() ?? String(balance),
      required_amount: String(paymentRequirements.amount),
      balance_gte_required: isBigIntGte(balance?.toString?.() ?? null, paymentRequirements.amount),
      authorization_used: authorizationUsed == null ? null : Boolean(authorizationUsed),
      transfer_simulation
    };
  } catch (error) {
    diagnostics.chain_prechecks = {
      rpc_url: rpcUrl,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  return diagnostics;
}
