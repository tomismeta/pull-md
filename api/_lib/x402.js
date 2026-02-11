import { x402HTTPResourceServer, x402ResourceServer } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { generateJwt } from '@coinbase/cdp-sdk/auth';

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
    const response = await fetch(`${url}/${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...FACILITATOR_AUTH_HEADERS
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
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

function routeConfigForSoul({ soulId, soul, sellerAddress }) {
  return {
    accepts: {
      scheme: 'exact',
      network: 'eip155:8453',
      payTo: sellerAddress,
      price: soul.priceDisplay,
      maxTimeoutSeconds: 300
    },
    description: `Soul purchase for ${soulId}`,
    mimeType: 'text/markdown',
    unpaidResponseBody: () => ({
      contentType: 'application/json',
      body: {
        error: 'Payment required',
        message: `x402 payment required to download ${soulId}`,
        soul_id: soulId
      }
    })
  };
}

export async function getX402HTTPServer({ soulId, soul, sellerAddress }) {
  await ensureFacilitatorReachable();

  const key = `${soulId}:${sellerAddress}:${soul.priceDisplay}`;
  if (!serverCache.has(key)) {
    const resourceServer = new x402ResourceServer(facilitatorClient).register('eip155:*', new ExactEvmScheme());
    const httpServer = new x402HTTPResourceServer(resourceServer, {
      '*': routeConfigForSoul({ soulId, soul, sellerAddress })
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
    paymentHeader: adapter.getHeader('payment-signature') || adapter.getHeader('x-payment')
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
