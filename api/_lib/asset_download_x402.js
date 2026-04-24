import { ethers } from 'ethers';

export const PURCHASE_RECEIPT_SECURITY_HINT =
  'Persist X-PURCHASE-RECEIPT in secure storage (wallet+asset scoped). Required for strict no-repay re-download. Do not log or share receipt values.';

const SETTLE_RETRY_DELAYS_MS = String(process.env.X402_SETTLE_RETRY_DELAYS_MS || '')
  .split(',')
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v >= 0);
const SETTLE_INITIAL_DELAY_MS = Number(process.env.X402_SETTLE_INITIAL_DELAY_MS || '0');
const inFlightSettlements = new Map();
const PERMIT2_SPENDER = ['0x4020615294c913F0', '45dc10f0a5cdEbd8', '6c280001'].join('');

export function runSingleFlightSettlement(key, run) {
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

export function buildSettlementKey({ assetId, soulId, paymentPayload, paymentRequirements }) {
  const transferMethod = String(paymentRequirements?.extra?.assetTransferMethod || 'eip3009').toLowerCase();
  const payer = getPayerFromPaymentPayload(paymentPayload) || 'unknown';
  const resolvedAssetId = String(assetId || soulId || '').trim();
  if (transferMethod === 'permit2') {
    const nonce = String(paymentPayload?.payload?.permit2Authorization?.nonce || '');
    return `settle:${resolvedAssetId}:${payer}:permit2:${nonce}`;
  }
  const nonce = String(paymentPayload?.payload?.authorization?.nonce || '');
  return `settle:${resolvedAssetId}:${payer}:eip3009:${nonce}`;
}

export function getPayerFromPaymentPayload(paymentPayload) {
  const direct =
    paymentPayload?.payload?.authorization?.from ||
    paymentPayload?.payload?.permit2Authorization?.from ||
    paymentPayload?.payload?.from ||
    null;
  if (typeof direct !== 'string') return null;
  if (!/^0x[a-fA-F0-9]{40}$/.test(direct)) return null;
  return direct.toLowerCase();
}

export function decodePaymentRequiredHeader(headers = {}) {
  const header = headers['PAYMENT-REQUIRED'] || headers['payment-required'];
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(String(header), 'base64').toString('utf-8'));
  } catch (_) {
    return null;
  }
}

export async function processSettlementWithRetries(httpServer, { paymentPayload, paymentRequirements, declaredExtensions }) {
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

export function decodeSubmittedPayment(req) {
  const raw = req.headers['payment-signature'] || req.headers['PAYMENT-SIGNATURE'];
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(String(raw), 'base64').toString('utf-8'));
  } catch (_) {
    return null;
  }
}

export function rewriteIncomingPaymentHeader(req) {
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

export function canonicalizeSubmittedPayment(submitted) {
  if (!submitted || typeof submitted !== 'object') return submitted;
  if (!submitted.payload || typeof submitted.payload !== 'object') return submitted;

  const transferMethod = getTransferMethodFromSubmittedPayment(submitted);
  const payload = { ...submitted.payload };
  const canonical = { ...submitted };

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

export function getTransferMethodFromSubmittedPayment(submitted) {
  const fromAccepted = String(submitted?.accepted?.extra?.assetTransferMethod || '')
    .trim()
    .toLowerCase();
  if (fromAccepted === 'permit2' || fromAccepted === 'eip3009') return fromAccepted;
  const hasAuthorization = Boolean(submitted?.payload?.authorization);
  const hasEip3009Signature = Boolean(submitted?.payload?.signature || submitted?.payload?.authorization?.signature);
  if (hasAuthorization && hasEip3009Signature) return 'eip3009';
  if (submitted?.payload?.permit2Authorization || submitted?.payload?.permit2) return 'permit2';
  if (hasAuthorization) return 'eip3009';
  return 'eip3009';
}

export function buildPaymentDebug(req, paymentRequired) {
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
            spender_matches_proxy: equalAddress(permit2Auth.spender, PERMIT2_SPENDER),
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
                spender: PERMIT2_SPENDER,
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
    if (!equalAddress(permit2Auth.spender, PERMIT2_SPENDER)) {
      info.mismatch_hints.push(
        `permit2.spender mismatch: submitted=${permit2Auth.spender} expected=${PERMIT2_SPENDER}`
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

export function buildPaymentSigningInstructions(paymentRequired) {
  const accepted = paymentRequired?.accepts?.[0];
  if (!accepted) return null;
  const transferMethod = String(accepted?.extra?.assetTransferMethod || 'eip3009').toLowerCase();
  const base = buildPaymentInstructionBase(paymentRequired?.x402Version ?? 2, transferMethod);
  return {
    ...base,
    selected_rule: transferMethod === 'permit2' ? base.method_rules.permit2 : base.method_rules.eip3009
  };
}

export function buildPaymentSigningInstructionsForMethod(method) {
  const transferMethod = String(method || 'eip3009').toLowerCase() === 'permit2' ? 'permit2' : 'eip3009';
  const base = buildPaymentInstructionBase(2, transferMethod);
  return {
    ...base,
    selected_rule: transferMethod === 'permit2' ? base.method_rules.permit2 : base.method_rules.eip3009
  };
}

function buildPaymentInstructionBase(x402Version, transferMethod) {
  return {
    x402_version: x402Version,
    transfer_method: transferMethod,
    required_top_level_fields: ['x402Version', 'scheme', 'network', 'accepted', 'payload'],
    required_header: 'PAYMENT-SIGNATURE',
    header_format: 'base64(JSON.stringify(x402_payload))',
    accepted_must_match: 'accepted must exactly equal PAYMENT-REQUIRED.accepts[0]',
    wallet_hint: 'Send X-WALLET-ADDRESS on paywall and paid retry requests. Strict agent mode defaults to eip3009 unless X-ASSET-TRANSFER-METHOD is set.',
    purchase_receipt_security_hint: PURCHASE_RECEIPT_SECURITY_HINT,
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
}

export function buildCopyPastePaymentPayloadTemplate(paymentRequired) {
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

export function extractX402Error(error) {
  if (!error || typeof error !== 'object') {
    return { message: String(error || 'unknown') };
  }

  return {
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
}

export function shouldIncludeDebug(req) {
  const queryDebug = String(req?.query?.debug || '').toLowerCase();
  if (queryDebug === '1' || queryDebug === 'true') return true;
  return String(process.env.X402_VERBOSE_DEBUG || '').toLowerCase() === 'true';
}

export function validatePaymentPayloadContract({ paymentPayload, paymentRequirements }) {
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

export async function buildSettlementDiagnostics({ paymentPayload, paymentRequirements }) {
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
