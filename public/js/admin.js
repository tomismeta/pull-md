const MCP_ENDPOINT = '/mcp';
const BASE_CHAIN_HEX = '0x2105';
const BASE_CHAIN_DEC = 8453;
const WALLET_SESSION_KEY = 'soulstarter_wallet_session_v1';
const MODERATOR_SESSION_KEY = 'pullmd_moderator_session_v1';
const MODERATOR_SESSION_REFRESH_GRACE_MS = 60 * 1000;
const state = {
  provider: null,
  signer: null,
  wallet: null,
  walletType: null,
  moderatorSession: null,
  moderatorSessionPromise: null,
  moderatorConnectPromise: null,
  moderators: [],
  connecting: false,
  visibleListings: [],
  hiddenListings: [],
  assetTypeFilter: 'all',
  searchQuery: '',
  telemetryWindowHours: 24,
  telemetry: null
};

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function applyListingFilters(items) {
  const list = Array.isArray(items) ? items : [];
  const typeFilter = String(state.assetTypeFilter || 'all').trim().toLowerCase();
  const search = normalizeSearchText(state.searchQuery);
  const terms = search ? search.split(/\s+/).filter(Boolean) : [];

  return list.filter((item) => {
    const assetType = String(item?.asset_type || '').toLowerCase();
    if (typeFilter && typeFilter !== 'all' && assetType !== typeFilter) return false;
    if (!terms.length) return true;
    const haystack = normalizeSearchText(
      [
        item?.asset_id,
        item?.soul_id,
        item?.name,
        item?.description,
        item?.wallet_address,
        item?.seller_address,
        item?.category,
        item?.soul_type,
        ...(Array.isArray(item?.tags) ? item.tags : [])
      ]
        .filter(Boolean)
        .join(' ')
    );
    return terms.every((term) => haystack.includes(term));
  });
}

function getMcpClient() {
  const client = window?.SoulStarterMcp;
  if (!client || typeof client.callTool !== 'function') {
    throw new Error('MCP client unavailable');
  }
  return client;
}

function getToastHelper() {
  const helper = window?.SoulStarterToast;
  if (!helper || typeof helper.show !== 'function') {
    throw new Error('Toast helper unavailable');
  }
  return helper;
}

async function mcpToolCall(name, args = {}) {
  return getMcpClient().callTool(name, args, {
    endpoint: MCP_ENDPOINT,
    idPrefix: 'admin'
  });
}

function showToast(message, type = 'info') {
  getToastHelper().show({
    message,
    type,
    containerId: 'toastContainer',
    durationMs: 2800,
    removeDelayMs: 200
  });
}

function sanitizeHeaderValue(name, value) {
  if (value == null) return null;
  const text = String(value);
  if (!text.trim()) return null;
  if (/[\r\n\0]/.test(text)) {
    throw new Error(`Invalid header value for ${name}`);
  }
  return text;
}

function buildRequestHeaders(input = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    const normalized = sanitizeHeaderValue(key, value);
    if (normalized == null) continue;
    out[key] = normalized;
  }
  return out;
}

function initProviderDiscovery() {
  window?.SoulStarterWalletProviders?.initDiscovery?.();
}

function findProviderByKind(kind) {
  return window?.SoulStarterWalletProviders?.findProviderByKind?.(kind) || null;
}

function fallbackInjectedProvider() {
  return window?.SoulStarterWalletProviders?.fallbackInjectedProvider?.() || null;
}

function getWalletCommon() {
  const helper = window?.SoulStarterWalletCommon;
  if (!helper) {
    throw new Error('Wallet common helper unavailable');
  }
  return helper;
}

function getWalletConnector() {
  const helper = window?.SoulStarterWalletConnect;
  if (!helper) {
    throw new Error('Wallet connector helper unavailable');
  }
  return helper;
}

function getUiShell() {
  const helper = window?.SoulStarterUiShell;
  if (!helper) {
    throw new Error('UI shell helper unavailable');
  }
  return helper;
}

function normalizeAddress(value) {
  try {
    return ethers.getAddress(String(value || '').trim()).toLowerCase();
  } catch (_) {
    return null;
  }
}

function isAllowedModerator(wallet) {
  const normalized = normalizeAddress(wallet);
  return Boolean(normalized && state.moderators.includes(normalized));
}

function setStatus(text) {
  const el = document.getElementById('tokenStatus');
  if (el) el.textContent = text;
}

function setConnectButton() {
  const walletButtons = [document.getElementById('connectWalletBtn'), document.getElementById('walletBtn')].filter(Boolean);
  if (!walletButtons.length) return;
  for (const btn of walletButtons) {
    if (state.wallet) {
      const suffix = btn.id === 'connectWalletBtn' ? ' (disconnect)' : '';
      btn.textContent = `${shortWallet(state.wallet)}${suffix}`;
      btn.classList.add('connected');
    } else {
      btn.textContent = 'Connect Wallet';
      btn.classList.remove('connected');
    }
  }
}

function renderEmpty(containerId, text) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<p class="admin-empty">${text}</p>`;
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function shortWallet(value) {
  const normalized = normalizeAddress(value);
  if (!normalized) return '-';
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function formatCount(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num.toLocaleString() : '0';
}

function formatPercent(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return '0%';
  return `${(num * 100).toFixed(1)}%`;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value || '');
  return div.innerHTML;
}

function openWalletModal() {
  getUiShell().openModal('walletModal');
}

function closeWalletModal() {
  getUiShell().closeModal('walletModal');
}

function setWalletOptionsDisabled(disabled) {
  document.querySelectorAll('.wallet-option').forEach((option) => {
    if (!(option instanceof HTMLButtonElement)) return;
    option.disabled = disabled;
  });
}

async function ensureBaseNetwork(provider) {
  return getWalletCommon().ensureBaseNetwork(provider, {
    chainIdDec: BASE_CHAIN_DEC,
    chainIdHex: BASE_CHAIN_HEX,
    chainParams: {
      chainId: BASE_CHAIN_HEX,
      chainName: 'Base',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://mainnet.base.org'],
      blockExplorerUrls: ['https://basescan.org']
    }
  });
}

function saveWalletSession() {
  getWalletCommon().saveWalletSession({
    key: WALLET_SESSION_KEY,
    wallet: state.wallet,
    walletType: state.walletType
  });
}

function clearWalletSession() {
  getWalletCommon().clearWalletSession({ key: WALLET_SESSION_KEY });
}

function readWalletSession() {
  return getWalletCommon().readWalletSession({ key: WALLET_SESSION_KEY });
}

function saveModeratorSession() {
  try {
    if (!state.moderatorSession || !state.wallet) {
      localStorage.removeItem(MODERATOR_SESSION_KEY);
      return;
    }
    localStorage.setItem(
      MODERATOR_SESSION_KEY,
      JSON.stringify({
        wallet: state.wallet,
        token: state.moderatorSession.token,
        expiresAtMs: state.moderatorSession.expiresAtMs
      })
    );
  } catch (_) {}
}

function clearModeratorSession() {
  state.moderatorSession = null;
  state.moderatorSessionPromise = null;
  try {
    localStorage.removeItem(MODERATOR_SESSION_KEY);
  } catch (_) {}
}

function restoreModeratorSession() {
  try {
    const raw = localStorage.getItem(MODERATOR_SESSION_KEY);
    if (!raw || !state.wallet) return;
    const parsed = JSON.parse(raw);
    const wallet = normalizeAddress(parsed?.wallet);
    const token = String(parsed?.token || '').trim();
    const expiresAtMs = Number(parsed?.expiresAtMs);
    if (!wallet || wallet !== state.wallet || !token || !Number.isFinite(expiresAtMs)) return;
    if (expiresAtMs <= Date.now()) return;
    state.moderatorSession = { wallet, token, expiresAtMs };
  } catch (_) {}
}

async function connectWithProviderInternal(rawProvider, walletType, silent) {
  return getWalletConnector().connectWithProviderInternal({
    rawProvider,
    walletType,
    silent,
    closeModal: closeWalletModal,
    ensureNetwork: ensureBaseNetwork,
    onState: (next) => {
      state.provider = next.provider;
      state.signer = next.signer;
      state.wallet = next.wallet;
      state.walletType = next.walletType;
    },
    afterConnected: async () => {
      saveWalletSession();
      setConnectButton();
    }
  });
}

async function connectMetaMaskProvider() {
  return getWalletConnector().connectWithPreferredKind({
    kind: 'metamask',
    walletType: 'metamask',
    connectInternal: connectWithProviderInternal,
    findProviderByKind,
    fallbackInjectedProvider,
    notify: showToast,
    missingProviderMessage: 'MetaMask not found',
    throwOnMissingProvider: true
  });
}

async function connectRabbyProvider() {
  return getWalletConnector().connectWithPreferredKind({
    kind: 'rabby',
    walletType: 'rabby',
    connectInternal: connectWithProviderInternal,
    findProviderByKind,
    fallbackInjectedProvider,
    notify: showToast,
    missingProviderMessage: 'Rabby wallet not found',
    throwOnMissingProvider: true
  });
}

async function connectBankrProvider() {
  return getWalletConnector().connectWithPreferredKind({
    kind: 'bankr',
    walletType: 'bankr',
    connectInternal: connectWithProviderInternal,
    findProviderByKind,
    fallbackInjectedProvider,
    notify: showToast,
    missingProviderMessage: 'Bankr Wallet not found',
    throwOnMissingProvider: true
  });
}

async function bootstrapModeratorSession(force = false) {
  if (!state.wallet || !state.signer) throw new Error('Connect your wallet first');
  if (!isAllowedModerator(state.wallet)) throw new Error('Connected wallet is not allowlisted for moderation');
  if (
    !force &&
    state.moderatorSession?.token &&
    Number(state.moderatorSession.expiresAtMs) > Date.now() + MODERATOR_SESSION_REFRESH_GRACE_MS
  ) {
    return state.moderatorSession.token;
  }
  if (state.moderatorSessionPromise) {
    return state.moderatorSessionPromise;
  }
  state.moderatorSessionPromise = (async () => {
    const challenge = await mcpToolCall('get_auth_challenge', {
      flow: 'session',
      wallet_address: state.wallet,
      action: 'session'
    });
    const message = String(challenge?.auth_message_template || '').trim();
    const issuedAt = String(challenge?.issued_at || '').trim();
    const timestamp = Number.isFinite(Number(challenge?.auth_timestamp_ms))
      ? Number(challenge.auth_timestamp_ms)
      : Date.parse(issuedAt);
    if (!message || !Number.isFinite(timestamp)) {
      throw new Error('Failed to build moderator session challenge');
    }
    const signatureRaw = await state.signer.signMessage(message);
    const signature = String(signatureRaw || '').trim();
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
      throw new Error('Wallet returned an invalid signature format for moderator session');
    }
    const sessionHeaders = buildRequestHeaders({
      Accept: 'application/json',
      'X-WALLET-ADDRESS': state.wallet,
      'X-AUTH-SIGNATURE': signature,
      'X-AUTH-TIMESTAMP': String(timestamp)
    });
    const response = await fetch('/api/auth/session', {
      method: 'POST',
      headers: sessionHeaders
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(payload?.error || payload?.message || `Moderator session bootstrap failed (${response.status})`));
    }
    const token = String(response.headers.get('x-redownload-session') || payload?.token || '').trim();
    const expiresAtMs = Number(payload?.expires_at_ms || Date.now() + 5 * 60 * 1000);
    if (!token) throw new Error('Moderator session token missing');
    state.moderatorSession = {
      wallet: state.wallet,
      token,
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 5 * 60 * 1000
    };
    saveModeratorSession();
    return token;
  });
  try {
    return await state.moderatorSessionPromise;
  } finally {
    state.moderatorSessionPromise = null;
  }
}

async function moderatorAuthHeaders() {
  const token = await bootstrapModeratorSession(false);
  return {
    'X-MODERATOR-ADDRESS': state.wallet,
    'X-REDOWNLOAD-SESSION': token
  };
}

async function moderationRequest(action, { method = 'GET', headers = {}, body, query = {} } = {}) {
  const normalizedAction = String(action || '').trim();
  const normalizedMethod = String(method || '').toUpperCase();
  const params = new URLSearchParams({ action: normalizedAction });
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null || value === '') continue;
    params.set(key, String(value));
  }
  const requestHeaders = buildRequestHeaders({
    Accept: 'application/json',
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...headers
  });
  const response = await fetch(`/api/moderation?${params.toString()}`, {
    method: normalizedMethod,
    headers: requestHeaders,
    body: body ? JSON.stringify(body) : undefined
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(String(payload?.error || payload?.message || `Request failed (${response.status})`));
    if (payload && typeof payload === 'object') Object.assign(error, payload);
    throw error;
  }
  return payload || {};
}

async function apiCall(action, { method = 'GET', body, query, moderatorAuth = false } = {}) {
  const normalizedAction = String(action || '').trim();
  let attempt = 0;
  while (attempt < 2) {
    try {
      const headers = moderatorAuth ? await moderatorAuthHeaders() : {};
      return await moderationRequest(normalizedAction, {
        method,
        headers,
        body,
        query
      });
    } catch (error) {
      const message = String(error?.error || error?.message || '').toLowerCase();
      const code = String(error?.code || '').toLowerCase();
      const canRefresh =
        moderatorAuth &&
        attempt === 0 &&
        (code.includes('session') ||
          message.includes('moderator session invalid') ||
          message.includes('re-download session') ||
          message.includes('authentication message expired') ||
          message.includes('authentication timed out'));
      if (!canRefresh) throw error;
      clearModeratorSession();
      await bootstrapModeratorSession(true);
      attempt += 1;
    }
  }
  throw new Error('Moderator authentication failed');
}

function renderModeratorList() {
  const container = document.getElementById('moderatorList');
  if (!container) return;
  if (!state.moderators.length) {
    container.innerHTML = '<p class="admin-empty">No moderator wallets configured.</p>';
    return;
  }
  container.innerHTML = `<div class="admin-pill-list">${state.moderators
    .map((wallet) => `<span class="admin-pill" title="${escapeHtml(wallet)}">${escapeHtml(shortWallet(wallet))}</span>`)
    .join('')}</div>`;
}

function renderVisible(items) {
  const container = document.getElementById('visibleContainer');
  if (!container) return;
  if (!Array.isArray(items) || items.length === 0) {
    renderEmpty('visibleContainer', 'No visible listings.');
    return;
  }
  container.innerHTML = items
    .map(
      (item) => `
        <article class="admin-card">
          <div class="admin-card-row">
            <h4>${escapeHtml(item.name || item.soul_id)}</h4>
            <span class="badge badge-organic">public</span>
          </div>
          <p class="admin-line">asset_id: <code>${escapeHtml(item.asset_id || item.soul_id || '-')}</code></p>
          <p class="admin-line">creator: <code>${escapeHtml(item.wallet_address || '-')}</code></p>
          <p class="admin-line">type: <code>${escapeHtml(String(item.asset_type || 'soul').toUpperCase())}</code></p>
          <p class="admin-line">published: <code>${escapeHtml(formatDate(item.published_at))}</code></p>
          <div class="admin-card-actions">
            ${item.share_url ? `<a class="btn btn-ghost" href="${escapeHtml(item.share_url)}" target="_blank" rel="noopener noreferrer">open</a>` : ''}
            <button class="btn btn-ghost" data-action="edit-listing" data-soul="${escapeHtml(item.asset_id || item.soul_id)}">edit</button>
            <button class="btn btn-primary" data-action="hide-listing" data-soul="${escapeHtml(item.asset_id || item.soul_id)}">remove visibility</button>
            <button class="btn btn-ghost btn-danger" data-action="delete-listing" data-soul="${escapeHtml(item.asset_id || item.soul_id)}">delete</button>
          </div>
        </article>
      `
    )
    .join('');
}

function renderHidden(items) {
  const container = document.getElementById('hiddenContainer');
  if (!container) return;
  if (!Array.isArray(items) || items.length === 0) {
    renderEmpty('hiddenContainer', 'No hidden listings.');
    return;
  }
  container.innerHTML = items
    .map(
      (item) => `
        <article class="admin-card">
          <div class="admin-card-row">
            <h4>${escapeHtml(item.name || item.soul_id)}</h4>
            <span class="badge badge-hybrid">hidden</span>
          </div>
          <p class="admin-line">asset_id: <code>${escapeHtml(item.asset_id || item.soul_id || '-')}</code></p>
          <p class="admin-line">type: <code>${escapeHtml(String(item.asset_type || 'soul').toUpperCase())}</code></p>
          <p class="admin-line">hidden_by: <code>${escapeHtml(item.hidden_by || '-')}</code></p>
          <p class="admin-line">hidden_at: <code>${escapeHtml(formatDate(item.hidden_at))}</code></p>
          <p class="admin-line">reason: <code>${escapeHtml(item.hidden_reason || '-')}</code></p>
          <div class="admin-card-actions">
            ${item.share_url ? `<a class="btn btn-ghost" href="${escapeHtml(item.share_url)}" target="_blank" rel="noopener noreferrer">open</a>` : ''}
            <button class="btn btn-ghost" data-action="edit-listing" data-soul="${escapeHtml(item.asset_id || item.soul_id)}">edit</button>
            <button class="btn btn-primary" data-action="restore-listing" data-soul="${escapeHtml(item.asset_id || item.soul_id)}">restore visibility</button>
            <button class="btn btn-ghost btn-danger" data-action="delete-listing" data-soul="${escapeHtml(item.asset_id || item.soul_id)}">delete</button>
          </div>
        </article>
      `
    )
    .join('');
}

function renderTelemetryEmpty(message) {
  const targets = ['telemetryOverview', 'telemetryTopAssets', 'telemetryTopTools', 'telemetryRoutes', 'telemetryErrors', 'telemetryHourly'];
  for (const id of targets) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.innerHTML = `<p class="admin-empty">${escapeHtml(message)}</p>`;
  }
}

function formatBucketLabel(value, windowHours) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  if (windowHours <= 24) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function renderTelemetryDashboard(data) {
  const overviewEl = document.getElementById('telemetryOverview');
  const topAssetsEl = document.getElementById('telemetryTopAssets');
  const topToolsEl = document.getElementById('telemetryTopTools');
  const routesEl = document.getElementById('telemetryRoutes');
  const errorsEl = document.getElementById('telemetryErrors');
  const hourlyEl = document.getElementById('telemetryHourly');

  if (!overviewEl || !topAssetsEl || !topToolsEl || !routesEl || !errorsEl || !hourlyEl) return;

  const overview = data?.overview || {};
  const errorRate = Number(overview.error_rate || 0);
  const kpis = [
    {
      label: 'Events',
      value: formatCount(overview.total_events),
      helper: `Last ${formatCount(data?.window_hours || state.telemetryWindowHours)}h`
    },
    { label: 'MCP POST', value: formatCount(overview.mcp_post_requests), helper: 'Transport requests' },
    { label: 'Tool Calls', value: formatCount(overview.mcp_tool_invocations), helper: 'tools/call volume' },
    { label: 'Paywalls', value: formatCount(overview.paywall_issued), helper: '402 responses issued' },
    { label: 'Purchases', value: formatCount(overview.purchase_successes), helper: 'Successful settlement' },
    { label: 'Re-downloads', value: formatCount(overview.redownload_successes), helper: 'No-repay deliveries' },
    { label: 'Publishes', value: formatCount(overview.publish_successes), helper: 'Creator publishes' },
    {
      label: 'Error Rate',
      value: formatPercent(errorRate),
      helper: `${formatCount(overview.failed_events)} failed events`,
      tone: errorRate > 0.05 ? 'danger' : errorRate > 0.01 ? 'warning' : 'neutral'
    }
  ];

  overviewEl.innerHTML = kpis
    .map(
      (item) => `
      <article class="telemetry-kpi telemetry-kpi-${escapeHtml(item.tone || 'neutral')}">
        <strong>${escapeHtml(item.value)}</strong>
        <span>${escapeHtml(item.label)}</span>
        <small>${escapeHtml(item.helper || '')}</small>
      </article>
    `
    )
    .join('');

  const renderRankedRows = (rows, options) => {
    const items = Array.isArray(rows) ? rows : [];
    if (!items.length) {
      return `<p class="admin-empty">${escapeHtml(options.emptyMessage)}</p>`;
    }
    const scores = items.map((item) => Number(options.score(item) || 0)).filter((n) => Number.isFinite(n));
    const maxScore = Math.max(...scores, 1);
    return `
      <div class="telemetry-stack">
        ${items
          .map((item) => {
            const score = Number(options.score(item) || 0);
            const width = maxScore > 0 ? Math.max(4, Math.round((score / maxScore) * 100)) : 0;
            return `
              <article class="telemetry-row-card">
                <div class="telemetry-row-head">
                  <strong>${escapeHtml(options.title(item))}</strong>
                  <span class="telemetry-row-metric">${escapeHtml(formatCount(score))}</span>
                </div>
                <div class="telemetry-bar-track">
                  <span class="telemetry-bar-fill" style="width:${width}%"></span>
                </div>
                <p class="telemetry-row-meta">${escapeHtml(options.meta(item))}</p>
              </article>
            `;
          })
          .join('')}
      </div>
    `;
  };

  const topAssets = Array.isArray(data?.top_assets) ? data.top_assets : [];
  topAssetsEl.innerHTML = renderRankedRows(topAssets, {
    emptyMessage: 'No asset activity in selected window.',
    score: (item) => Number(item.purchases || 0) + Number(item.redownloads || 0) + Number(item.paywall_views || 0),
    title: (item) => item.asset_id || '-',
    meta: (item) =>
      `type ${String(item.asset_type || 'unknown').toUpperCase()} · purchases ${formatCount(item.purchases)} · re-downloads ${formatCount(
        item.redownloads
      )} · paywalls ${formatCount(item.paywall_views)}`
  });

  const topTools = Array.isArray(data?.mcp_tools) ? data.mcp_tools : [];
  topToolsEl.innerHTML = renderRankedRows(topTools, {
    emptyMessage: 'No MCP tool calls in selected window.',
    score: (item) => Number(item.calls || 0),
    title: (item) => item.tool_name || '-',
    meta: (item) => `calls ${formatCount(item.calls)} · failures ${formatCount(item.failures)}`
  });

  const routes = Array.isArray(data?.api_routes) ? data.api_routes : [];
  routesEl.innerHTML = renderRankedRows(routes, {
    emptyMessage: 'No API route traffic in selected window.',
    score: (item) => Number(item.hits || 0),
    title: (item) => `${item.method || '-'} ${item.route || '-'}`,
    meta: (item) => `hits ${formatCount(item.hits)} · failures ${formatCount(item.failures)}`
  });

  const errors = Array.isArray(data?.recent_errors) ? data.recent_errors : [];
  if (!errors.length) {
    errorsEl.innerHTML = '<p class="admin-empty">No recent errors in selected window.</p>';
  } else {
    errorsEl.innerHTML = `
      <div class="telemetry-stack">
        ${errors
          .map(
            (item) => `
            <article class="telemetry-row-card telemetry-row-error">
              <div class="telemetry-row-head">
                <strong>${escapeHtml(item.event_type || '-')}</strong>
                <span class="telemetry-row-metric">${escapeHtml(formatDate(item.occurred_at))}</span>
              </div>
              <p class="telemetry-row-meta">code ${escapeHtml(item.error_code || '-')} · status ${escapeHtml(item.status_code || '-')}</p>
              <p class="telemetry-row-message">${escapeHtml(item.error_message || 'Unknown error')}</p>
            </article>
          `
          )
          .join('')}
      </div>
    `;
  }

  const hourly = Array.isArray(data?.hourly) ? data.hourly : [];
  if (!hourly.length) {
    hourlyEl.innerHTML = '<p class="admin-empty">No hourly activity available in selected window.</p>';
  } else {
    const maxBars = state.telemetryWindowHours > 24 ? 36 : 24;
    const buckets = hourly.slice(-maxBars);
    const maxEvents = Math.max(...buckets.map((bucket) => Number(bucket.total_events || 0)), 1);
    hourlyEl.innerHTML = `
      <div class="telemetry-chart-scroll">
        <div class="telemetry-hourly-chart">
          ${buckets
            .map((bucket) => {
              const totalEvents = Number(bucket.total_events || 0);
              const height = Math.max(6, Math.round((totalEvents / maxEvents) * 100));
              const tooltip = `events ${formatCount(bucket.total_events)} · tools ${formatCount(
                bucket.mcp_tool_calls
              )} · purchases ${formatCount(bucket.purchases)} · re-downloads ${formatCount(bucket.redownloads)}`;
              return `
                <div class="telemetry-hourly-col" title="${escapeHtml(tooltip)}">
                  <div class="telemetry-hourly-bar-wrap">
                    <span class="telemetry-hourly-bar" style="height:${height}%"></span>
                  </div>
                  <span class="telemetry-hourly-value">${escapeHtml(formatCount(bucket.total_events))}</span>
                  <span class="telemetry-hourly-label">${escapeHtml(formatBucketLabel(bucket.bucket, state.telemetryWindowHours))}</span>
                </div>
              `;
            })
            .join('')}
        </div>
      </div>
      <p class="telemetry-row-meta">Bar height represents total events per hour. Hover bars for tool/purchase/re-download details.</p>
    `;
  }
}

async function loadTelemetryDashboard() {
  await requireAllowedModerator();
  const payload = await apiCall('get_telemetry_dashboard', {
    method: 'GET',
    moderatorAuth: true,
    query: {
      window_hours: state.telemetryWindowHours,
      row_limit: 10
    }
  });
  state.telemetry = payload;
  renderTelemetryDashboard(payload);
}

async function loadModerators() {
  const data = await apiCall('list_moderators');
  state.moderators = Array.isArray(data.moderators) ? data.moderators.map((w) => String(w).toLowerCase()) : [];
  renderModeratorList();
}

function disconnectWallet() {
  state.provider = null;
  state.signer = null;
  state.wallet = null;
  state.walletType = null;
  state.visibleListings = [];
  state.hiddenListings = [];
  state.telemetry = null;
  clearModeratorSession();
  clearWalletSession();
  setConnectButton();
  setStatus('Connect wallet to continue.');
  renderEmpty('visibleContainer', 'Connect an allowlisted moderator wallet.');
  renderEmpty('hiddenContainer', 'Connect an allowlisted moderator wallet.');
  renderTelemetryEmpty('Connect an allowlisted moderator wallet.');
  showToast('Wallet disconnected', 'info');
}

async function requireAllowedModerator() {
  if (!state.wallet || !state.signer) throw new Error('Connect an allowlisted moderator wallet first');
  if (!isAllowedModerator(state.wallet)) throw new Error('Connected wallet is not allowlisted for moderation');
}

async function loadModerationListings() {
  await requireAllowedModerator();
  const data = await apiCall('list_moderation_listings', { moderatorAuth: true });
  state.visibleListings = Array.isArray(data.visible) ? data.visible : [];
  state.hiddenListings = Array.isArray(data.hidden) ? data.hidden : [];
  renderListings();
}

async function hideListing(soulId) {
  await requireAllowedModerator();
  const reason = window.prompt('Optional reason for removal from public visibility:', '') || '';
  await apiCall('remove_listing_visibility', {
    method: 'POST',
    moderatorAuth: true,
    body: { soul_id: soulId, reason }
  });
}

async function restoreListing(soulId) {
  await requireAllowedModerator();
  const reason = window.prompt('Optional reason for restoring visibility:', '') || '';
  await apiCall('restore_listing_visibility', {
    method: 'POST',
    moderatorAuth: true,
    body: { soul_id: soulId, reason }
  });
}

async function deleteListing(soulId) {
  await requireAllowedModerator();
  const confirmText = window.prompt(`Type "${soulId}" to permanently delete this listing:`, '');
  if (String(confirmText || '').trim() !== soulId) return false;
  const reason = window.prompt('Optional deletion reason for audit trail:', '') || '';
  await apiCall('delete_listing', {
    method: 'POST',
    moderatorAuth: true,
    body: { soul_id: soulId, reason }
  });
  return true;
}

function findListingById(soulId) {
  const id = String(soulId || '').trim();
  return [...state.visibleListings, ...state.hiddenListings].find(
    (item) => String(item?.asset_id || item?.soul_id || '').trim() === id
  );
}

function openEditListingModal(soulId) {
  const item = findListingById(soulId);
  if (!item) throw new Error('Listing not found');
  const setValue = (id, value) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value == null ? '' : String(value);
  };

  setValue('editAssetId', item.asset_id || item.soul_id || '');
  setValue('editAssetType', item.asset_type || 'soul');
  setValue('editFileName', item.file_name || (String(item.asset_type || 'soul') === 'skill' ? 'SKILL.md' : 'SOUL.md'));
  setValue('editName', item.name || '');
  setValue('editDescription', item.description || '');
  setValue('editPriceUsdc', item.price_usdc ?? '');
  setValue('editSellerAddress', item.seller_address || '');
  setValue('editCategory', item.category || '');
  setValue('editSoulType', item.soul_type || 'hybrid');
  setValue('editIcon', item.icon || '');
  setValue('editTags', Array.isArray(item.tags) ? item.tags.join(', ') : '');
  setValue('editSourceUrl', item.source_url || '');
  setValue('editSourceLabel', item.source_label || '');
  setValue('editContentMarkdown', item.content_markdown || item.soul_markdown || '');
  getUiShell().openModal('editListingModal');
}

function closeEditListingModal() {
  getUiShell().closeModal('editListingModal');
}

function buildListingPayloadFromEditForm() {
  const read = (id) => String(document.getElementById(id)?.value || '').trim();
  const tags = read('editTags')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const priceRaw = read('editPriceUsdc');
  const price = Number.parseFloat(priceRaw);
  return {
    asset_id: read('editAssetId'),
    listing: {
      soul_id: read('editAssetId'),
      asset_type: read('editAssetType') || 'soul',
      file_name: read('editFileName'),
      name: read('editName'),
      description: read('editDescription'),
      price_usdc: Number.isFinite(price) ? price : null,
      seller_address: read('editSellerAddress'),
      category: read('editCategory'),
      soul_type: read('editSoulType') || 'hybrid',
      icon: read('editIcon'),
      tags,
      source_url: read('editSourceUrl') || null,
      source_label: read('editSourceLabel') || null,
      content_markdown: document.getElementById('editContentMarkdown')?.value || ''
    }
  };
}

async function submitEditListing() {
  await requireAllowedModerator();
  const payload = buildListingPayloadFromEditForm();
  if (!payload.asset_id) throw new Error('Missing asset id');
  await apiCall('update_listing', {
    method: 'POST',
    moderatorAuth: true,
    body: payload
  });
}

function renderListings() {
  renderVisible(applyListingFilters(state.visibleListings));
  renderHidden(applyListingFilters(state.hiddenListings));
}

async function connectWallet() {
  if (state.moderatorConnectPromise) {
    await state.moderatorConnectPromise;
    return;
  }
  state.moderatorConnectPromise = (async () => {
    if (!state.signer || !state.wallet) throw new Error('No wallet session found');
    if (isAllowedModerator(state.wallet)) {
      restoreModeratorSession();
      await bootstrapModeratorSession(false);
      setStatus(`Connected moderator: ${shortWallet(state.wallet)}`);
      showToast('Moderator wallet connected', 'success');
      await loadModerationListings();
      try {
        await loadTelemetryDashboard();
      } catch (error) {
        renderTelemetryEmpty(`Telemetry unavailable: ${error.message}`);
        showToast(`Telemetry unavailable: ${error.message}`, 'warning');
      }
    } else {
      setStatus(`Connected wallet is not allowlisted: ${state.wallet}`);
      renderEmpty('visibleContainer', 'Access denied. Use an allowlisted moderator wallet.');
      renderEmpty('hiddenContainer', 'Access denied. Use an allowlisted moderator wallet.');
      renderTelemetryEmpty('Access denied. Use an allowlisted moderator wallet.');
      showToast('Wallet is not in moderator allowlist', 'warning');
    }
  })();
  try {
    await state.moderatorConnectPromise;
  } finally {
    state.moderatorConnectPromise = null;
  }
}

async function restoreWalletSession() {
  const session = readWalletSession();
  if (!session) return;
  const providerCandidate = findProviderByKind(session.walletType) || fallbackInjectedProvider();
  if (!providerCandidate) {
    clearWalletSession();
    return;
  }
  try {
    await connectWithProviderInternal(providerCandidate, session.walletType, true);
    if (state.wallet !== session.wallet) {
      clearWalletSession();
      return;
    }
    if (!isAllowedModerator(state.wallet)) {
      setStatus(`Connected wallet is not allowlisted: ${state.wallet}`);
      renderEmpty('visibleContainer', 'Access denied. Use an allowlisted moderator wallet.');
      renderEmpty('hiddenContainer', 'Access denied. Use an allowlisted moderator wallet.');
      renderTelemetryEmpty('Access denied. Use an allowlisted moderator wallet.');
      return;
    }

    restoreModeratorSession();
    if (
      state.moderatorSession?.token &&
      Number(state.moderatorSession.expiresAtMs) > Date.now() + MODERATOR_SESSION_REFRESH_GRACE_MS
    ) {
      setStatus(`Connected moderator: ${shortWallet(state.wallet)}`);
      await loadModerationListings();
      try {
        await loadTelemetryDashboard();
      } catch (error) {
        renderTelemetryEmpty(`Telemetry unavailable: ${error.message}`);
      }
      return;
    }

    setStatus(`Wallet restored: ${shortWallet(state.wallet)}. Click Connect Wallet to authorize moderation access.`);
    renderEmpty('visibleContainer', 'Wallet connected. Click Connect Wallet once to sign and load public assets.');
    renderEmpty('hiddenContainer', 'Wallet connected. Click Connect Wallet once to sign and load removed assets.');
    renderTelemetryEmpty('Wallet connected. Click Connect Wallet once to sign and load telemetry.');
  } catch (_) {
    clearWalletSession();
  }
}

function bindEvents() {
  const onWalletButtonClick = async () => {
    try {
      if (state.wallet) disconnectWallet();
      else openWalletModal();
    } catch (error) {
      showToast(error.message, 'error');
    }
  };
  document.getElementById('connectWalletBtn')?.addEventListener('click', onWalletButtonClick);
  document.getElementById('walletBtn')?.addEventListener('click', onWalletButtonClick);

  document.getElementById('refreshListingsBtn')?.addEventListener('click', async () => {
    try {
      await loadModerationListings();
    } catch (error) {
      showToast(error.message, 'error');
      renderEmpty('visibleContainer', `Visible list load failed: ${error.message}`);
    }
  });

  document.getElementById('refreshHiddenBtn')?.addEventListener('click', async () => {
    try {
      await loadModerationListings();
    } catch (error) {
      showToast(error.message, 'error');
      renderEmpty('hiddenContainer', `Hidden list load failed: ${error.message}`);
    }
  });

  document.getElementById('refreshTelemetryBtn')?.addEventListener('click', async () => {
    try {
      await loadTelemetryDashboard();
    } catch (error) {
      showToast(error.message, 'error');
      renderTelemetryEmpty(`Telemetry load failed: ${error.message}`);
    }
  });

  document.getElementById('telemetryWindowHours')?.addEventListener('change', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const nextValue = Number.parseInt(target.value, 10);
    state.telemetryWindowHours = Number.isFinite(nextValue) ? nextValue : 24;
    if (!state.wallet) return;
    try {
      await loadTelemetryDashboard();
    } catch (error) {
      showToast(error.message, 'error');
      renderTelemetryEmpty(`Telemetry load failed: ${error.message}`);
    }
  });

  document.querySelectorAll('[data-filter-type]').forEach((button) => {
    button.addEventListener('click', (event) => {
      const target = event.currentTarget;
      if (!(target instanceof HTMLElement)) return;
      const nextType = String(target.getAttribute('data-filter-type') || 'all').toLowerCase();
      state.assetTypeFilter = nextType || 'all';
      document.querySelectorAll('[data-filter-type]').forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        node.classList.toggle('active', node.getAttribute('data-filter-type') === state.assetTypeFilter);
      });
      renderListings();
    });
  });

  document.getElementById('adminSearchInput')?.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    state.searchQuery = target.value || '';
    renderListings();
  });

  document.getElementById('editListingForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitBtn = event.target?.querySelector('button[type="submit"]');
    if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = true;
    try {
      await submitEditListing();
      closeEditListingModal();
      showToast('Listing updated', 'success');
      await loadModerationListings();
    } catch (error) {
      const fieldErrors = error?.field_errors;
      if (Array.isArray(fieldErrors) && fieldErrors.length) {
        const first = fieldErrors[0];
        const hint = [first?.field, first?.fix].filter(Boolean).join(': ');
        showToast(hint || error.message, 'error');
      } else {
        showToast(error.message, 'error');
      }
    } finally {
      if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = false;
    }
  });

  document.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.getAttribute('data-action');
    if (!action) return;
    const soulId = target.getAttribute('data-soul');
    if (!soulId) return;
    if (action !== 'hide-listing' && action !== 'restore-listing' && action !== 'delete-listing' && action !== 'edit-listing') {
      return;
    }
    if (action !== 'edit-listing') target.setAttribute('disabled', 'true');
    try {
      if (action === 'hide-listing') {
        await hideListing(soulId);
        showToast('Listing removed from public visibility', 'success');
        await loadModerationListings();
      } else if (action === 'restore-listing') {
        await restoreListing(soulId);
        showToast('Listing restored to public visibility', 'success');
        await loadModerationListings();
      } else if (action === 'delete-listing') {
        const deleted = await deleteListing(soulId);
        if (deleted) {
          showToast('Listing permanently deleted', 'success');
          await loadModerationListings();
        }
      } else if (action === 'edit-listing') {
        openEditListingModal(soulId);
      }
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      if (action !== 'edit-listing') target.removeAttribute('disabled');
    }
  });
}

async function connectFromChoice(kind) {
  if (state.connecting) return;
  state.connecting = true;
  setWalletOptionsDisabled(true);
  try {
    if (kind === 'metamask') await connectMetaMaskProvider();
    else if (kind === 'rabby') await connectRabbyProvider();
    else if (kind === 'bankr') await connectBankrProvider();
    if (!state.signer || !state.wallet) throw new Error('Wallet connection did not complete. Please try again.');
    await connectWallet();
  } finally {
    setWalletOptionsDisabled(false);
    state.connecting = false;
  }
}

function bindWalletChoiceHandlers() {
  const map = [
    ['connectMetaMask', 'metamask'],
    ['connectRabby', 'rabby'],
    ['connectBankr', 'bankr']
  ];
  for (const [fnName, kind] of map) {
    window[fnName] = async () => {
      try {
        await connectFromChoice(kind);
      } catch (error) {
        showToast(error.message, 'error');
      }
    };
  }
}

function initMobileNav() {
  getUiShell().initMobileNav({
    toggleId: 'navToggle',
    navId: 'topNav',
    mobileMaxWidth: 760
  });
}

async function init() {
  initProviderDiscovery();
  initMobileNav();
  bindEvents();
  bindWalletChoiceHandlers();
  await loadModerators();
  setConnectButton();
  setStatus('Connect wallet to continue.');
  renderEmpty('visibleContainer', 'Connect an allowlisted moderator wallet.');
  renderEmpty('hiddenContainer', 'Connect an allowlisted moderator wallet.');
  renderTelemetryEmpty('Connect an allowlisted moderator wallet.');
  const windowSelect = document.getElementById('telemetryWindowHours');
  if (windowSelect instanceof HTMLSelectElement) {
    state.telemetryWindowHours = Number.parseInt(windowSelect.value, 10) || 24;
  }
  await restoreWalletSession();
}

window.closeWalletModal = closeWalletModal;
window.closeEditListingModal = closeEditListingModal;

init().catch((error) => {
  showToast(error.message, 'error');
});
