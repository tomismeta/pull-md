import { x402HTTPResourceServer, x402ResourceServer } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { generateJwt } from '@coinbase/cdp-sdk/auth';

const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DEFAULT_FACILITATORS = [
  // Production facilitator (requires proper CDP auth if your account/workspace enforces it)
  'https://api.cdp.coinbase.com/platform/v2/x402',
  // Public fallback (primarily useful for testnet/dev)
  'https://x402.org/facilitator'
];

const FACILITATOR_TIMEOUT_MS = Number(process.env.FACILITATOR_TIMEOUT_MS || '10000');
const FACILITATOR_MAX_FAILURES = Number(process.env.FACILITATOR_MAX_FAILURES || '3');
const FACILITATOR_COOLDOWN_MS = Number(process.env.FACILITATOR_COOLDOWN_MS || '60000');
const FACILITATOR_PREFLIGHT_TTL_MS = Number(process.env.FACILITATOR_PREFLIGHT_TTL_MS || '120000');

function getConfiguredFacilitatorUrls() {
  const hasCdpCredentials = Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);
  const fromList = (process.env.FACILITATOR_URLS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (fromList.length > 0) return fromList;
  if (process.env.FACILITATOR_URL) return [process.env.FACILITATOR_URL.trim()];
  if (hasCdpCredentials) {
    return ['https://api.cdp.coinbase.com/platform/v2/x402'];
  }
  return DEFAULT_FACILITATORS;
}

function getStaticAuthHeaders() {
  const raw = process.env.FACILITATOR_AUTH_HEADERS_JSON;
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const headers = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value != null) headers[String(key)] = String(value);
    }
    return headers;
  } catch {
    return {};
  }
}

const FACILITATOR_URLS = getConfiguredFacilitatorUrls();
const FACILITATOR_AUTH_HEADERS = getStaticAuthHeaders();
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID || null;
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET || null;

const facilitatorState = new Map(
  FACILITATOR_URLS.map((url) => [url, { failures: 0, openUntil: 0, lastError: null, lastOkAt: 0 }])
);

let preflight = {
  checkedAt: 0,
  ok: false,
  activeUrl: null,
  error: null
};

const serverCache = new Map();

export function getFacilitatorRuntimeInfo() {
  const urls = [...FACILITATOR_URLS];
  const cdpUrls = urls.filter((u) => isCdpFacilitatorUrl(u));
  return {
    urls,
    cdp_enabled: cdpUrls.length > 0,
    cdp_only: urls.length > 0 && cdpUrls.length === urls.length,
    cdp_urls: cdpUrls
  };
}

function nowMs() {
  return Date.now();
}

function withTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function urlsByPriority() {
  const now = nowMs();
  const available = [];
  const blocked = [];

  for (const url of FACILITATOR_URLS) {
    const state = facilitatorState.get(url);
    if (!state || state.openUntil <= now) {
      available.push(url);
    } else {
      blocked.push(url);
    }
  }

  // If everything is blocked, try all anyway to recover quickly.
  return available.length > 0 ? available : blocked;
}

function markSuccess(url) {
  const state = facilitatorState.get(url);
  if (!state) return;
  state.failures = 0;
  state.openUntil = 0;
  state.lastError = null;
  state.lastOkAt = nowMs();
}

function markFailure(url, errorMessage) {
  const state = facilitatorState.get(url);
  if (!state) return;

  state.failures += 1;
  state.lastError = errorMessage;
  if (state.failures >= FACILITATOR_MAX_FAILURES) {
    state.openUntil = nowMs() + FACILITATOR_COOLDOWN_MS;
  }
}

async function facilitatorFetch(url, path, body) {
  const { signal, done } = withTimeoutSignal(FACILITATOR_TIMEOUT_MS);
  try {
    const method = body ? 'POST' : 'GET';
    const authHeaders = await getDynamicFacilitatorAuthHeaders(url, path, method);
    const normalizedBody = normalizeFacilitatorRequest(url, body);
    const response = await fetch(`${url}/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...FACILITATOR_AUTH_HEADERS
      },
      ...(normalizedBody ? { body: JSON.stringify(normalizedBody) } : {}),
      signal
    });

    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }

    if (!response.ok) {
      const detail = json && typeof json === 'object' ? JSON.stringify(json) : response.statusText;
      throw new Error(`HTTP ${response.status} ${path}: ${detail}`);
    }

    return json;
  } finally {
    done();
  }
}

function normalizeFacilitatorRequest(url, body) {
  if (!body || typeof body !== 'object') return body;
  if (!isCdpFacilitatorUrl(url)) return body;
  const remapped = remapNetworkFields(body);
  if (!remapped?.paymentPayload || typeof remapped.paymentPayload !== 'object') {
    return remapped;
  }
  const normalizedPaymentPayload = normalizePaymentPayloadShapeForFacilitator(
    remapped.paymentPayload,
    remapped.paymentRequirements
  );
  const normalized = {
    ...remapped,
    paymentPayload: normalizedPaymentPayload
  };
  return coerceToCdpV1Envelope(normalized);
}

function isCdpFacilitatorUrl(rawUrl) {
  try {
    return new URL(rawUrl).hostname === 'api.cdp.coinbase.com';
  } catch {
    return false;
  }
}

function remapNetworkFields(value) {
  if (Array.isArray(value)) {
    return value.map(remapNetworkFields);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const next = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'network' && typeof nested === 'string') {
      next[key] = remapNetworkValue(nested);
      continue;
    }
    next[key] = remapNetworkFields(nested);
  }
  return next;
}

function remapNetworkValue(network) {
  if (network === 'eip155:8453') return 'base';
  if (network === 'eip155:84532') return 'base-sepolia';
  return network;
}

function normalizePaymentPayloadShapeForFacilitator(paymentPayload, paymentRequirements) {
  if (!paymentPayload || typeof paymentPayload !== 'object') return paymentPayload;
  const payload = paymentPayload?.payload;
  if (!payload || typeof payload !== 'object') return paymentPayload;

  const transferMethod = getTransferMethod(paymentPayload, paymentRequirements);
  const nextPayload = { ...payload };

  if (transferMethod === 'permit2') {
    if (nextPayload.permit2 && !nextPayload.permit2Authorization) {
      nextPayload.permit2Authorization = nextPayload.permit2;
    }
    // CDP verify schema may require payload.authorization even for permit2-style payloads.
    // Force authorization to mirror permit2Authorization to avoid mixed-mode hex nonce/value fields.
    if (nextPayload.permit2Authorization && typeof nextPayload.permit2Authorization === 'object') {
      nextPayload.permit2Authorization = normalizePermit2Authorization(nextPayload.permit2Authorization);
    }
    if (nextPayload.permit2Authorization) {
      nextPayload.authorization = buildCdpAuthorizationForPermit2(nextPayload.permit2Authorization, paymentRequirements);
    }
    if (nextPayload.transaction && typeof nextPayload.transaction === 'object') {
      nextPayload.transaction = {
        ...nextPayload.transaction,
        to: nextPayload.transaction.to == null ? nextPayload.transaction.to : String(nextPayload.transaction.to),
        data: nextPayload.transaction.data == null ? nextPayload.transaction.data : String(nextPayload.transaction.data),
        value:
          nextPayload.transaction.value == null ? nextPayload.transaction.value : toStringNumber(nextPayload.transaction.value)
      };
    }
    delete nextPayload.permit2;
  } else if (transferMethod === 'eip3009') {
    delete nextPayload.permit2Authorization;
    delete nextPayload.permit2;
    if (nextPayload.authorization && typeof nextPayload.authorization === 'object') {
      nextPayload.authorization = normalizeEip3009Authorization(nextPayload.authorization);
    }
  }

  return {
    ...paymentPayload,
    payload: nextPayload
  };
}

function coerceToCdpV1Envelope(body) {
  const paymentPayload = body?.paymentPayload;
  const paymentRequirements = body?.paymentRequirements;
  if (!paymentPayload || typeof paymentPayload !== 'object') return body;

  const accepted =
    paymentPayload?.accepted && typeof paymentPayload.accepted === 'object'
      ? paymentPayload.accepted
      : paymentRequirements && typeof paymentRequirements === 'object'
        ? paymentRequirements
        : null;

  const transferMethod = getTransferMethod(paymentPayload, paymentRequirements || accepted);
  const resource = paymentPayload?.resource && typeof paymentPayload.resource === 'object' ? paymentPayload.resource : null;
  const sourcePayload = paymentPayload?.payload && typeof paymentPayload.payload === 'object' ? paymentPayload.payload : {};

  // Build method-specific payload from scratch to avoid schema ambiguity.
  let v1InnerPayload = {};
  if (transferMethod === 'permit2') {
    v1InnerPayload = {
      signature: sourcePayload.signature ?? null,
      permit2Authorization: sourcePayload.permit2Authorization ?? null
    };
  } else {
    v1InnerPayload = {
      signature: sourcePayload.signature ?? null,
      authorization: sourcePayload.authorization ?? null
    };
  }

  const v1PaymentPayload = {
    x402Version: 1,
    scheme: paymentPayload?.scheme ?? accepted?.scheme ?? 'exact',
    network: paymentPayload?.network ?? accepted?.network ?? 'base',
    payload: v1InnerPayload
  };

  const normalizedAmount = normalizeUintString(
    paymentRequirements?.amount ?? accepted?.amount ?? paymentRequirements?.maxAmountRequired ?? '0'
  );

  const v1Requirements = {
    scheme: paymentRequirements?.scheme ?? accepted?.scheme ?? 'exact',
    network: paymentRequirements?.network ?? accepted?.network ?? 'base',
    // Keep both fields for CDP schema compatibility across v1/v2 validators.
    amount: normalizedAmount,
    maxAmountRequired: normalizedAmount,
    resource: String(paymentRequirements?.resource ?? resource?.url ?? ''),
    description: String(paymentRequirements?.description ?? resource?.description ?? 'x402 payment'),
    mimeType: String(paymentRequirements?.mimeType ?? resource?.mimeType ?? 'application/octet-stream'),
    payTo: paymentRequirements?.payTo ?? accepted?.payTo ?? '',
    maxTimeoutSeconds: Number(paymentRequirements?.maxTimeoutSeconds ?? accepted?.maxTimeoutSeconds ?? 300),
    asset: paymentRequirements?.asset ?? accepted?.asset ?? '',
    outputSchema: paymentRequirements?.outputSchema ?? null,
    extra:
      paymentRequirements?.extra && typeof paymentRequirements.extra === 'object'
        ? paymentRequirements.extra
        : accepted?.extra && typeof accepted.extra === 'object'
          ? accepted.extra
          : {}
  };

  return {
    x402Version: 1,
    paymentPayload: v1PaymentPayload,
    paymentRequirements: v1Requirements
  };
}

function buildCdpFacilitatorRequest({ paymentPayload, paymentRequirements, x402Version }) {
  const cdpMappedPayload = remapNetworkFields(paymentPayload);
  const cdpMappedRequirements = remapNetworkFields(paymentRequirements);
  const cdpNormalizedPayload = normalizePaymentPayloadShapeForFacilitator(cdpMappedPayload, cdpMappedRequirements);
  const cdpRequest = coerceToCdpV1Envelope({
    x402Version: x402Version ?? paymentPayload?.x402Version ?? 2,
    paymentPayload: cdpNormalizedPayload,
    paymentRequirements: cdpMappedRequirements
  });
  return { cdpMappedPayload, cdpMappedRequirements, cdpNormalizedPayload, cdpRequest };
}

function redactForSupport(value, keyPath = '') {
  if (Array.isArray(value)) {
    return value.map((entry, idx) => redactForSupport(entry, `${keyPath}[${idx}]`));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    const path = keyPath ? `${keyPath}.${key}` : key;
    if (typeof nested === 'string' && (key === 'signature' || path.endsWith('.signature'))) {
      result[key] = nested.length > 24 ? `${nested.slice(0, 12)}...${nested.slice(-12)} (len=${nested.length})` : nested;
      continue;
    }
    result[key] = redactForSupport(nested, path);
  }
  return result;
}

export function buildCdpRequestDebug({ paymentPayload, paymentRequirements, x402Version }) {
  if (!paymentPayload || typeof paymentPayload !== 'object' || !paymentRequirements || typeof paymentRequirements !== 'object') {
    return null;
  }

  const built = buildCdpFacilitatorRequest({ paymentPayload, paymentRequirements, x402Version });
  const auth = built?.cdpRequest?.paymentPayload?.payload?.authorization;
  const permit2Auth = built?.cdpRequest?.paymentPayload?.payload?.permit2Authorization;
  const transaction = built?.cdpRequest?.paymentPayload?.payload?.transaction;
  const validAfterNum = safeBigInt(auth?.validAfter);
  const validBeforeNum = safeBigInt(auth?.validBefore);
  const nonceText = auth?.nonce == null ? null : String(auth.nonce);
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    top_level_x402Version: built.cdpRequest?.x402Version ?? null,
    transfer_method: getTransferMethod(built.cdpNormalizedPayload, built.cdpMappedRequirements),
    paymentPayload_keys: Object.keys(built.cdpRequest?.paymentPayload?.payload || {}),
    paymentRequirements_keys: Object.keys(built.cdpRequest?.paymentRequirements || {}),
    paymentPayload_field_types: {
      authorization: typeOfValue(auth),
      permit2Authorization: typeOfValue(permit2Auth),
      signature: typeOfValue(built?.cdpRequest?.paymentPayload?.payload?.signature),
      transaction: typeOfValue(transaction),
      authorization_value: typeOfValue(auth?.value),
      authorization_validAfter: typeOfValue(auth?.validAfter),
      authorization_validBefore: typeOfValue(auth?.validBefore),
      authorization_nonce: typeOfValue(auth?.nonce)
    },
    paymentPayload_field_checks: {
      authorization_nonce_is_bytes32_hex: nonceText ? /^0x[0-9a-fA-F]{64}$/.test(nonceText) : null,
      authorization_validAfter_is_digits: auth?.validAfter == null ? null : /^[0-9]+$/.test(String(auth.validAfter)),
      authorization_validBefore_is_digits: auth?.validBefore == null ? null : /^[0-9]+$/.test(String(auth.validBefore)),
      authorization_validAfter_looks_like_ms:
        validAfterNum == null ? null : validAfterNum > 100000000000n,
      authorization_validBefore_looks_like_ms:
        validBeforeNum == null ? null : validBeforeNum > 100000000000n,
      authorization_validBefore_minus_now_sec:
        validBeforeNum == null ? null : Number(validBeforeNum - BigInt(nowSec)),
      transaction_present_for_eip3009:
        getTransferMethod(built.cdpNormalizedPayload, built.cdpMappedRequirements) === 'eip3009'
          ? transaction != null
          : null
    },
    cdp_request_redacted: redactForSupport(built.cdpRequest)
  };
}

function typeOfValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function safeBigInt(value) {
  if (value == null) return null;
  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
}

function buildCdpAuthorizationForPermit2(permit2Auth, paymentRequirements) {
  const from = permit2Auth?.from ?? null;
  const to = permit2Auth?.witness?.to ?? paymentRequirements?.payTo ?? null;
  const value = normalizeUintString(permit2Auth?.permitted?.amount ?? paymentRequirements?.amount ?? null);
  const validAfter = normalizeUintString(permit2Auth?.witness?.validAfter ?? null);
  const validBefore = normalizeUintString(permit2Auth?.deadline ?? null);
  const nonce = toBytes32Hex(permit2Auth?.nonce ?? null);

  return {
    from,
    to,
    value,
    validAfter,
    validBefore,
    nonce
  };
}

function normalizePermit2Authorization(auth) {
  const next = { ...auth };
  if (next.permitted && typeof next.permitted === 'object') {
    next.permitted = {
      ...next.permitted,
      amount: normalizeUintString(next.permitted.amount)
    };
  }
  next.nonce = normalizeUintString(next.nonce);
  next.deadline = normalizeUintString(next.deadline);
  if (next.witness && typeof next.witness === 'object') {
    next.witness = {
      ...next.witness,
      validAfter: normalizeUintString(next.witness.validAfter),
      extra: typeof next.witness.extra === 'string' ? next.witness.extra : '0x'
    };
  }
  return next;
}

function normalizeEip3009Authorization(auth) {
  return {
    ...auth,
    value: normalizeUintString(auth.value),
    validAfter: normalizeUintString(auth.validAfter),
    validBefore: normalizeUintString(auth.validBefore),
    nonce: toBytes32Hex(auth.nonce)
  };
}

function toStringNumber(value) {
  if (value == null) return value;
  return typeof value === 'string' ? value : String(value);
}

function normalizeUintString(value) {
  if (value == null) return value;
  try {
    let bi;
    if (typeof value === 'string' && value.trim().toLowerCase().startsWith('0x')) {
      bi = BigInt(value.trim());
    } else {
      bi = BigInt(String(value).trim());
    }
    if (bi < 0n) {
      bi = BigInt.asUintN(256, bi);
    }
    return bi.toString(10);
  } catch {
    return toStringNumber(value);
  }
}

function toBytes32Hex(value) {
  if (value == null) return value;
  try {
    let bi;
    if (typeof value === 'string' && value.trim().toLowerCase().startsWith('0x')) {
      bi = BigInt(value.trim());
    } else {
      bi = BigInt(String(value).trim());
    }
    if (bi < 0n) {
      bi = BigInt.asUintN(256, bi);
    }
    const hex = bi.toString(16).padStart(64, '0').slice(-64);
    return `0x${hex}`;
  } catch {
    return toStringNumber(value);
  }
}

function getTransferMethod(paymentPayload, paymentRequirements) {
  const fromRequirements = String(paymentRequirements?.extra?.assetTransferMethod || '').trim().toLowerCase();
  if (fromRequirements === 'permit2' || fromRequirements === 'eip3009') return fromRequirements;

  const fromAccepted = String(paymentPayload?.accepted?.extra?.assetTransferMethod || '').trim().toLowerCase();
  if (fromAccepted === 'permit2' || fromAccepted === 'eip3009') return fromAccepted;

  if (paymentPayload?.payload?.permit2Authorization || paymentPayload?.payload?.permit2) return 'permit2';
  if (paymentPayload?.payload?.authorization) return 'eip3009';
  return 'eip3009';
}

async function getDynamicFacilitatorAuthHeaders(baseUrl, endpointPath, method) {
  if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET) {
    return {};
  }

  const url = new URL(baseUrl);
  if (url.hostname !== 'api.cdp.coinbase.com') {
    return {};
  }

  const normalizedBasePath = url.pathname.replace(/\/$/, '');
  const normalizedEndpointPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  const requestPath = `${normalizedBasePath}${normalizedEndpointPath}`;

  const jwt = await generateJwt({
    apiKeyId: CDP_API_KEY_ID,
    apiKeySecret: CDP_API_KEY_SECRET,
    requestMethod: method,
    requestHost: url.host,
    requestPath
  });

  return {
    Authorization: `Bearer ${jwt}`
  };
}

async function callFacilitator(path, body) {
  let lastErr = null;

  for (const url of urlsByPriority()) {
    try {
      const result = await facilitatorFetch(url, path, body);
      markSuccess(url);
      preflight = {
        checkedAt: nowMs(),
        ok: true,
        activeUrl: url,
        error: null
      };
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markFailure(url, message);
      lastErr = `${url}: ${message}`;
      console.error('[x402] facilitator request failed', { url, path, error: message });
    }
  }

  preflight = {
    checkedAt: nowMs(),
    ok: false,
    activeUrl: null,
    error: lastErr || 'All facilitator endpoints failed'
  };

  throw new Error(preflight.error);
}

class FallbackFacilitatorClient {
  async verify(paymentPayload, paymentRequirements) {
    const response = await callFacilitator('verify', {
      x402Version: paymentPayload.x402Version,
      paymentPayload,
      paymentRequirements
    });

    if (!response || typeof response !== 'object' || !('isValid' in response)) {
      throw new Error('Invalid verify response from facilitator');
    }

    return response;
  }

  async settle(paymentPayload, paymentRequirements) {
    const response = await callFacilitator('settle', {
      x402Version: paymentPayload.x402Version,
      paymentPayload,
      paymentRequirements
    });

    if (!response || typeof response !== 'object' || !('success' in response)) {
      throw new Error('Invalid settle response from facilitator');
    }

    return response;
  }

  async getSupported() {
    const response = await callFacilitator('supported');
    if (!response || typeof response !== 'object' || !Array.isArray(response.kinds)) {
      throw new Error('Invalid supported response from facilitator');
    }
    return response;
  }

  async supported() {
    return this.getSupported();
  }
}

const facilitatorClient = new FallbackFacilitatorClient();

export async function ensureFacilitatorReachable(force = false) {
  const stale = nowMs() - preflight.checkedAt > FACILITATOR_PREFLIGHT_TTL_MS;
  if (!force && preflight.checkedAt > 0 && !stale) {
    if (!preflight.ok) {
      throw new Error(preflight.error || 'Facilitator unavailable');
    }
    return preflight;
  }

  await facilitatorClient.getSupported();
  return preflight;
}

export function getFacilitatorHealth() {
  const now = nowMs();
  const endpoints = FACILITATOR_URLS.map((url) => {
    const state = facilitatorState.get(url) || { failures: 0, openUntil: 0, lastError: null, lastOkAt: 0 };
    return {
      url,
      failures: state.failures,
      circuit_open: state.openUntil > now,
      cooldown_remaining_ms: state.openUntil > now ? state.openUntil - now : 0,
      last_error: state.lastError,
      last_ok_at: state.lastOkAt || null
    };
  });

  return {
    now,
    config: {
      urls: FACILITATOR_URLS,
      timeout_ms: FACILITATOR_TIMEOUT_MS,
      max_failures: FACILITATOR_MAX_FAILURES,
      cooldown_ms: FACILITATOR_COOLDOWN_MS,
      preflight_ttl_ms: FACILITATOR_PREFLIGHT_TTL_MS,
      has_auth_headers: Object.keys(FACILITATOR_AUTH_HEADERS).length > 0 || Boolean(CDP_API_KEY_ID && CDP_API_KEY_SECRET)
    },
    preflight,
    endpoints
  };
}

export async function inspectFacilitatorVerify({ paymentPayload, paymentRequirements, x402Version }) {
  if (!paymentPayload || typeof paymentPayload !== 'object') {
    return {
      ok: false,
      error: 'missing_payment_payload'
    };
  }
  if (!paymentRequirements || typeof paymentRequirements !== 'object') {
    return {
      ok: false,
      error: 'missing_payment_requirements'
    };
  }

  try {
    const { cdpMappedPayload, cdpMappedRequirements, cdpNormalizedPayload } = buildCdpFacilitatorRequest({
      paymentPayload,
      paymentRequirements,
      x402Version
    });
    const cdpVerifyRequestDebug = buildCdpRequestDebug({ paymentPayload, paymentRequirements, x402Version });
    const verify = await callFacilitator('verify', {
      x402Version: x402Version ?? paymentPayload.x402Version ?? 2,
      paymentPayload,
      paymentRequirements
    });
    return {
      ok: true,
      result: summarizeVerifyResult(verify),
      network_mapping: {
        submitted_payment_network: paymentPayload?.network ?? null,
        submitted_requirements_network: paymentRequirements?.network ?? null,
        cdp_payment_network: cdpMappedPayload?.network ?? null,
        cdp_requirements_network: cdpMappedRequirements?.network ?? null
      },
      facilitator_payload_shape: {
        submitted_has_authorization: Boolean(paymentPayload?.payload?.authorization),
        submitted_has_permit2_authorization: Boolean(paymentPayload?.payload?.permit2Authorization),
        submitted_transaction_type: paymentPayload?.payload?.transaction == null ? null : typeof paymentPayload?.payload?.transaction,
        cdp_has_authorization: Boolean(cdpNormalizedPayload?.payload?.authorization),
        cdp_has_permit2_authorization: Boolean(cdpNormalizedPayload?.payload?.permit2Authorization),
        cdp_transaction_type: cdpNormalizedPayload?.payload?.transaction == null ? null : typeof cdpNormalizedPayload?.payload?.transaction,
        cdp_authorization_nonce: cdpNormalizedPayload?.payload?.authorization?.nonce ?? null,
        cdp_authorization_validAfter: cdpNormalizedPayload?.payload?.authorization?.validAfter ?? null,
        cdp_authorization_validBefore: cdpNormalizedPayload?.payload?.authorization?.validBefore ?? null,
        cdp_authorization_to: cdpNormalizedPayload?.payload?.authorization?.to ?? null,
        cdp_authorization_value: cdpNormalizedPayload?.payload?.authorization?.value ?? null
      },
      cdp_envelope: {
        x402Version: 1,
        transfer_method: getTransferMethod(cdpNormalizedPayload, cdpMappedRequirements)
      },
      cdp_verify_request_preview: {
        top_level_x402Version: cdpVerifyRequestDebug?.top_level_x402Version ?? null,
        transfer_method: cdpVerifyRequestDebug?.transfer_method ?? null,
        paymentPayload_keys: cdpVerifyRequestDebug?.paymentPayload_keys ?? [],
        paymentRequirements_keys: cdpVerifyRequestDebug?.paymentRequirements_keys ?? []
      },
      cdp_verify_request_redacted: cdpVerifyRequestDebug?.cdp_request_redacted ?? null
    };
  } catch (error) {
    const { cdpMappedPayload, cdpMappedRequirements, cdpNormalizedPayload } = buildCdpFacilitatorRequest({
      paymentPayload,
      paymentRequirements,
      x402Version
    });
    const cdpVerifyRequestDebug = buildCdpRequestDebug({ paymentPayload, paymentRequirements, x402Version });
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      parsed_error: parseFacilitatorError(error),
      network_mapping: {
        submitted_payment_network: paymentPayload?.network ?? null,
        submitted_requirements_network: paymentRequirements?.network ?? null,
        cdp_payment_network: cdpMappedPayload?.network ?? null,
        cdp_requirements_network: cdpMappedRequirements?.network ?? null
      },
      facilitator_payload_shape: {
        submitted_has_authorization: Boolean(paymentPayload?.payload?.authorization),
        submitted_has_permit2_authorization: Boolean(paymentPayload?.payload?.permit2Authorization),
        submitted_transaction_type: paymentPayload?.payload?.transaction == null ? null : typeof paymentPayload?.payload?.transaction,
        cdp_has_authorization: Boolean(cdpNormalizedPayload?.payload?.authorization),
        cdp_has_permit2_authorization: Boolean(cdpNormalizedPayload?.payload?.permit2Authorization),
        cdp_transaction_type: cdpNormalizedPayload?.payload?.transaction == null ? null : typeof cdpNormalizedPayload?.payload?.transaction,
        cdp_authorization_nonce: cdpNormalizedPayload?.payload?.authorization?.nonce ?? null,
        cdp_authorization_validAfter: cdpNormalizedPayload?.payload?.authorization?.validAfter ?? null,
        cdp_authorization_validBefore: cdpNormalizedPayload?.payload?.authorization?.validBefore ?? null,
        cdp_authorization_to: cdpNormalizedPayload?.payload?.authorization?.to ?? null,
        cdp_authorization_value: cdpNormalizedPayload?.payload?.authorization?.value ?? null
      },
      cdp_envelope: {
        x402Version: 1,
        transfer_method: getTransferMethod(cdpNormalizedPayload, cdpMappedRequirements)
      },
      cdp_verify_request_preview: {
        top_level_x402Version: cdpVerifyRequestDebug?.top_level_x402Version ?? null,
        transfer_method: cdpVerifyRequestDebug?.transfer_method ?? null,
        paymentPayload_keys: cdpVerifyRequestDebug?.paymentPayload_keys ?? [],
        paymentRequirements_keys: cdpVerifyRequestDebug?.paymentRequirements_keys ?? []
      },
      cdp_verify_request_redacted: cdpVerifyRequestDebug?.cdp_request_redacted ?? null
    };
  }
}

function summarizeVerifyResult(verify) {
  if (!verify || typeof verify !== 'object') return verify ?? null;
  return {
    isValid: Boolean(verify.isValid),
    invalidReason: verify.invalidReason ?? null,
    payer: verify.payer ?? null,
    network: verify.network ?? null
  };
}

function parseFacilitatorError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const jsonStart = message.indexOf('{');
  if (jsonStart < 0) return null;
  const maybeJson = message.slice(jsonStart);
  try {
    const parsed = JSON.parse(maybeJson);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      error: parsed.error ?? parsed.errorType ?? null,
      message: parsed.message ?? parsed.errorMessage ?? null,
      invalidReason: parsed.invalidReason ?? null,
      code: parsed.code ?? null,
      link: parsed.errorLink ?? null
    };
  } catch (_) {
    return null;
  }
}

class NodeAdapter {
  constructor(req) {
    this.req = req;
  }

  getHeader(name) {
    const target = String(name || '').toLowerCase();
    const value = this.req?.headers?.[target] ?? this.req?.headers?.[name];
    if (Array.isArray(value)) return value[0];
    if (value == null) return undefined;
    return String(value);
  }

  getMethod() {
    return String(this.req?.method || 'GET').toUpperCase();
  }

  getPath() {
    const raw = String(this.req?.url || '/');
    const q = raw.indexOf('?');
    return q >= 0 ? raw.slice(0, q) : raw;
  }

  getUrl() {
    const host = this.getHeader('host') || 'localhost:3000';
    const proto = this.getHeader('x-forwarded-proto') || 'https';
    const path = this.getPath();
    return `${proto}://${host}${path}`;
  }

  getAcceptHeader() {
    return this.getHeader('accept') || '';
  }

  getUserAgent() {
    return this.getHeader('user-agent') || '';
  }
}

function routeConfigForAsset({ assetId, asset, sellerAddress, assetTransferMethod }) {
  const method = normalizeAssetTransferMethod(assetTransferMethod) || getAssetTransferMethod();
  return {
    accepts: {
      scheme: 'exact',
      network: 'eip155:8453',
      payTo: sellerAddress,
      price: {
        amount: asset.priceMicroUsdc,
        asset: BASE_MAINNET_USDC,
        extra: {
          name: 'USD Coin',
          version: '2',
          assetTransferMethod: method
        }
      },
      maxTimeoutSeconds: 300
    },
    description: `Markdown asset purchase for ${assetId}`,
    mimeType: 'text/markdown',
    unpaidResponseBody: () => ({
      contentType: 'application/json',
      body: {
        error: 'Payment required',
        message: `x402 payment required to download ${assetId}`,
        asset_id: assetId
      }
    })
  };
}

function getAssetTransferMethod() {
  const raw = String(process.env.X402_ASSET_TRANSFER_METHOD || 'eip3009').trim().toLowerCase();
  return raw === 'permit2' ? 'permit2' : 'eip3009';
}

function normalizeAssetTransferMethod(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'permit2') return 'permit2';
  if (raw === 'eip3009') return 'eip3009';
  return null;
}

export async function getX402HTTPServer({
  soulId,
  soul,
  assetId,
  asset,
  sellerAddress,
  assetTransferMethod = null
}) {
  await ensureFacilitatorReachable();
  const resolvedId = String(assetId || soulId || asset?.id || soul?.id || '').trim();
  const resolvedAsset = asset || soul;

  const method = normalizeAssetTransferMethod(assetTransferMethod) || getAssetTransferMethod();
  const key = `${resolvedId}:${sellerAddress}:${resolvedAsset.priceDisplay}:${method}`;
  if (!serverCache.has(key)) {
    const resourceServer = new x402ResourceServer(facilitatorClient).register('eip155:*', new ExactEvmScheme());
    const httpServer = new x402HTTPResourceServer(resourceServer, {
      '*': routeConfigForAsset({
        assetId: resolvedId,
        asset: resolvedAsset,
        sellerAddress,
        assetTransferMethod: method
      })
    });
    const initPromise = httpServer.initialize();
    serverCache.set(key, { httpServer, initPromise });
  }

  const entry = serverCache.get(key);
  await entry.initPromise;
  return entry.httpServer;
}

export function createRequestContext(req) {
  const adapter = new NodeAdapter(req);
  return {
    adapter,
    path: adapter.getPath(),
    method: adapter.getMethod(),
    paymentHeader: adapter.getHeader('payment-signature')
  };
}

export function applyInstructionResponse(res, response) {
  const headers = response.headers || {};
  for (const [key, value] of Object.entries(headers)) {
    if (value != null) {
      res.setHeader(key, value);
    }
  }

  const body = response.body;
  const contentType = String(headers['Content-Type'] || headers['content-type'] || '');

  if (body === undefined) {
    return res.status(response.status).end();
  }

  if (contentType.includes('application/json')) {
    return res.status(response.status).json(body);
  }

  if (typeof body === 'string') {
    return res.status(response.status).send(body);
  }

  return res.status(response.status).send(JSON.stringify(body));
}
