import crypto from 'crypto';
import { Pool } from 'pg';

import { AppError } from './errors.js';

const DB_CONN_ENV_KEYS = ['MARKETPLACE_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_URL'];
const DEFAULT_TELEMETRY_SCHEMA = 'telemetry';
const METADATA_MAX_BYTES_RAW = Number(process.env.TELEMETRY_METADATA_MAX_BYTES || '12288');
const METADATA_MAX_BYTES =
  Number.isFinite(METADATA_MAX_BYTES_RAW) && METADATA_MAX_BYTES_RAW >= 1024 ? METADATA_MAX_BYTES_RAW : 12288;
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_ROW_LIMIT = 10;
const MAX_WINDOW_HOURS = 24 * 30;
const MAX_ROW_LIMIT = 50;
const HASH_PREFIX_LENGTH = 24;
const WALLET_RE = /^0x[a-f0-9]{40}$/i;
const PG_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/i;
const TELEMETRY_DISABLED_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled']);

let dbPool = null;
let dbSchemaReadyPromise = null;
let dbSchemaReadyForDsn = null;

function telemetryDbTimeoutMs() {
  const raw = Number(process.env.TELEMETRY_DB_CONNECT_TIMEOUT_MS || '5000');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5000;
}

function isTransientTelemetryDbError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  return (
    text.includes('authentication timed out') ||
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('connection terminated') ||
    text.includes('connection reset') ||
    text.includes('econnreset') ||
    text.includes('etimedout')
  );
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeText(value, max = 320) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.slice(0, max);
}

function normalizeWalletAddress(value) {
  const wallet = String(value ?? '').trim().toLowerCase();
  return WALLET_RE.test(wallet) ? wallet : null;
}

function walletPreview(wallet) {
  const normalized = normalizeWalletAddress(wallet);
  if (!normalized) return null;
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function telemetryHashSecret() {
  const direct = String(process.env.TELEMETRY_HASH_SECRET || '').trim();
  if (direct) return direct;
  const fallback = String(process.env.PURCHASE_RECEIPT_SECRET || '').trim();
  if (fallback) return fallback;
  return 'pullmd-telemetry-default';
}

function hashWallet(wallet) {
  const normalized = normalizeWalletAddress(wallet);
  if (!normalized) return null;
  const digest = crypto.createHmac('sha256', telemetryHashSecret()).update(normalized).digest('hex');
  return digest.slice(0, HASH_PREFIX_LENGTH);
}

function getTelemetryDatabaseUrl() {
  for (const key of DB_CONN_ENV_KEYS) {
    const value = String(process.env[key] || '').trim();
    if (value) return value;
  }
  return '';
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function normalizeTelemetrySchema(raw) {
  const source = String(raw || '').trim();
  const candidate = source || DEFAULT_TELEMETRY_SCHEMA;
  if (!PG_IDENTIFIER_RE.test(candidate)) {
    return DEFAULT_TELEMETRY_SCHEMA;
  }
  return candidate.toLowerCase();
}

function telemetrySchemaName() {
  return normalizeTelemetrySchema(process.env.TELEMETRY_DB_SCHEMA);
}

function telemetryTableRef() {
  const schema = telemetrySchemaName();
  return `${quoteIdentifier(schema)}.${quoteIdentifier('marketplace_telemetry_events')}`;
}

function telemetryIndexName(suffix) {
  const schema = telemetrySchemaName().replace(/[^a-z0-9_]/g, '').slice(0, 24);
  const normalizedSuffix = String(suffix || '').replace(/[^a-z0-9_]/gi, '').toLowerCase();
  const raw = `${schema}_marketplace_telemetry_${normalizedSuffix}`;
  return quoteIdentifier(raw.slice(0, 63));
}

export function isTelemetryEnabled() {
  const raw = String(process.env.TELEMETRY_ENABLED || '').trim().toLowerCase();
  if (!raw) return true;
  return !TELEMETRY_DISABLED_VALUES.has(raw);
}

function telemetryConfigured() {
  return Boolean(getTelemetryDatabaseUrl());
}

function sanitizeDbConnectionString(connectionString) {
  const raw = String(connectionString || '').trim();
  if (!raw) return raw;
  try {
    const parsed = new URL(raw);
    parsed.searchParams.delete('sslmode');
    return parsed.toString();
  } catch (_) {
    return raw;
  }
}

function getTelemetryDbPool() {
  const rawConnectionString = getTelemetryDatabaseUrl();
  if (!rawConnectionString) return null;
  if (dbPool) return dbPool;
  const connectionString = sanitizeDbConnectionString(rawConnectionString);

  const sslHint = String(process.env.TELEMETRY_DB_SSL || '').trim().toLowerCase();
  const needsSsl =
    sslHint === '1' ||
    sslHint === 'true' ||
    /sslmode=require/i.test(rawConnectionString) ||
    /render\.com|neon\.tech|supabase\.co|railway\.app/i.test(rawConnectionString);

  dbPool = new Pool({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: telemetryDbTimeoutMs(),
    idleTimeoutMillis: 30000,
    max: 3
  });
  return dbPool;
}

async function resetTelemetryDbPool() {
  const activePool = dbPool;
  dbPool = null;
  dbSchemaReadyPromise = null;
  dbSchemaReadyForDsn = null;
  if (!activePool) return;
  try {
    await activePool.end();
  } catch (_) {}
}

async function ensureTelemetrySchema(attempt = 0) {
  let pool = getTelemetryDbPool();
  if (!pool) return false;
  const dsn = getTelemetryDatabaseUrl();
  const schema = telemetrySchemaName();
  const schemaReadyKey = `${dsn}::${schema}`;
  if (dbSchemaReadyPromise && dbSchemaReadyForDsn === schemaReadyKey) {
    await dbSchemaReadyPromise;
    return true;
  }

  dbSchemaReadyForDsn = schemaReadyKey;
  dbSchemaReadyPromise = (async () => {
    const tableRef = telemetryTableRef();
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)};`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${tableRef} (
        id BIGSERIAL PRIMARY KEY,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        event_type TEXT NOT NULL,
        source TEXT,
        route TEXT,
        http_method TEXT,
        rpc_method TEXT,
        tool_name TEXT,
        action TEXT,
        success BOOLEAN,
        status_code INTEGER,
        error_code TEXT,
        error_message TEXT,
        asset_id TEXT,
        asset_type TEXT,
        wallet_hash TEXT,
        wallet_preview TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `);
    // Harden against schema drift from older deployments.
    await pool.query(`
      ALTER TABLE ${tableRef}
      ADD COLUMN IF NOT EXISTS source TEXT,
      ADD COLUMN IF NOT EXISTS route TEXT,
      ADD COLUMN IF NOT EXISTS http_method TEXT,
      ADD COLUMN IF NOT EXISTS rpc_method TEXT,
      ADD COLUMN IF NOT EXISTS tool_name TEXT,
      ADD COLUMN IF NOT EXISTS action TEXT,
      ADD COLUMN IF NOT EXISTS success BOOLEAN,
      ADD COLUMN IF NOT EXISTS status_code INTEGER,
      ADD COLUMN IF NOT EXISTS error_code TEXT,
      ADD COLUMN IF NOT EXISTS error_message TEXT,
      ADD COLUMN IF NOT EXISTS asset_id TEXT,
      ADD COLUMN IF NOT EXISTS asset_type TEXT,
      ADD COLUMN IF NOT EXISTS wallet_hash TEXT,
      ADD COLUMN IF NOT EXISTS wallet_preview TEXT,
      ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
    `);
    await pool.query(`UPDATE ${tableRef} SET metadata='{}'::jsonb WHERE metadata IS NULL;`);
    await pool.query(`ALTER TABLE ${tableRef} ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;`);
    await pool.query(`ALTER TABLE ${tableRef} ALTER COLUMN metadata SET NOT NULL;`);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${telemetryIndexName('occurred_at')}
      ON ${tableRef} (occurred_at DESC);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${telemetryIndexName('event_type')}
      ON ${tableRef} (event_type);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${telemetryIndexName('tool_name')}
      ON ${tableRef} (tool_name);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${telemetryIndexName('route')}
      ON ${tableRef} (route);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${telemetryIndexName('asset_id')}
      ON ${tableRef} (asset_id);
    `);

    // User-requested cleanup: drop old public table instead of migrating rows.
    if (schema !== 'public') {
      await pool.query(`DROP TABLE IF EXISTS public.marketplace_telemetry_events;`).catch(() => {});
    }
  })();

  try {
    await dbSchemaReadyPromise;
    return true;
  } catch (error) {
    if (attempt === 0 && isTransientTelemetryDbError(error)) {
      await resetTelemetryDbPool();
      return ensureTelemetrySchema(1);
    }
    throw error;
  }
}

function sanitizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    const raw = JSON.stringify(value);
    const size = Buffer.byteLength(raw, 'utf8');
    if (size <= METADATA_MAX_BYTES) {
      return JSON.parse(raw);
    }
    return {
      truncated: true,
      original_size_bytes: size,
      preview: raw.slice(0, 1200)
    };
  } catch (_) {
    return { serialization_error: true };
  }
}

function asNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function rowToInt(row, key) {
  const value = Number(row?.[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function normalizeTelemetryWindowHours(value) {
  return clampInt(value, 1, MAX_WINDOW_HOURS, DEFAULT_WINDOW_HOURS);
}

function normalizeTelemetryRowLimit(value) {
  return clampInt(value, 1, MAX_ROW_LIMIT, DEFAULT_ROW_LIMIT);
}

export async function recordTelemetryEvent(event = {}) {
  if (!isTelemetryEnabled()) return { ok: false, reason: 'telemetry_disabled' };
  if (!telemetryConfigured()) return { ok: false, reason: 'telemetry_unconfigured' };

  try {
    let pool = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await ensureTelemetrySchema();
        pool = getTelemetryDbPool();
        if (!pool) return { ok: false, reason: 'telemetry_unconfigured' };

        const eventType = normalizeText(event.eventType || event.event_type || 'unknown', 120) || 'unknown';
        const wallet = normalizeWalletAddress(event.walletAddress || event.wallet_address);
        const params = [
          eventType,
          normalizeText(event.source, 64),
          normalizeText(event.route, 160),
          normalizeText(event.httpMethod || event.http_method, 12),
          normalizeText(event.rpcMethod || event.rpc_method, 64),
          normalizeText(event.toolName || event.tool_name, 120),
          normalizeText(event.action, 120),
          typeof event.success === 'boolean' ? event.success : null,
          asNumberOrNull(event.statusCode || event.status_code),
          normalizeText(event.errorCode || event.error_code, 120),
          normalizeText(event.errorMessage || event.error_message, 512),
          normalizeText(event.assetId || event.asset_id, 160),
          normalizeText(event.assetType || event.asset_type, 64),
          hashWallet(wallet),
          walletPreview(wallet),
          sanitizeMetadata(event.metadata)
        ];

        const tableRef = telemetryTableRef();
        await pool.query(
          `
        INSERT INTO ${tableRef} (
          event_type,
          source,
          route,
          http_method,
          rpc_method,
          tool_name,
          action,
          success,
          status_code,
          error_code,
          error_message,
          asset_id,
          asset_type,
          wallet_hash,
          wallet_preview,
          metadata
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb
        );
          `,
          params
        );
        return { ok: true };
      } catch (error) {
        if (attempt === 0 && isTransientTelemetryDbError(error)) {
          await resetTelemetryDbPool();
          continue;
        }
        throw error;
      }
    }
    return { ok: false, reason: 'telemetry_retry_exhausted' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error || 'telemetry_error') };
  }
}

export async function getTelemetryDashboard({ windowHours, rowLimit } = {}) {
  if (!isTelemetryEnabled()) {
    throw new AppError(503, {
      error: 'Telemetry is disabled by configuration.',
      code: 'telemetry_disabled',
      flow_hint: 'Set TELEMETRY_ENABLED=true to enable moderator telemetry dashboard.'
    });
  }
  if (!telemetryConfigured()) {
    throw new AppError(503, {
      error: 'Telemetry is unavailable: persistent database is not configured.',
      code: 'telemetry_unconfigured',
      flow_hint: 'Set MARKETPLACE_DATABASE_URL (or DATABASE_URL/POSTGRES_URL) to enable moderator telemetry.'
    });
  }

  try {
    await ensureTelemetrySchema();
  } catch (error) {
    throw new AppError(503, {
      error: 'Telemetry schema initialization failed',
      code: 'telemetry_schema_init_failed',
      detail: error instanceof Error ? error.message : String(error || 'unknown_error')
    });
  }

  const pool = getTelemetryDbPool();
  if (!pool) {
    throw new AppError(503, {
      error: 'Telemetry database unavailable',
      code: 'telemetry_database_unavailable'
    });
  }

  const safeWindowHours = normalizeTelemetryWindowHours(windowHours);
  const safeLimit = normalizeTelemetryRowLimit(rowLimit);
  const tableRef = telemetryTableRef();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
    const overviewRes = await pool.query(
    `
      SELECT
        COUNT(*)::int AS total_events,
        COUNT(*) FILTER (WHERE event_type = 'mcp.transport_request')::int AS mcp_post_requests,
        COUNT(*) FILTER (WHERE event_type = 'mcp.tool_invocation')::int AS mcp_tool_invocations,
        COUNT(*) FILTER (WHERE event_type = 'purchase.paywall_issued')::int AS paywall_issued,
        COUNT(*) FILTER (WHERE event_type = 'purchase.settlement_success')::int AS purchase_successes,
        COUNT(*) FILTER (WHERE event_type IN ('purchase.settlement_failed', 'purchase.processing_failed'))::int AS purchase_failures,
        COUNT(*) FILTER (WHERE event_type = 'redownload.success')::int AS redownload_successes,
        COUNT(*) FILTER (WHERE event_type = 'redownload.failed')::int AS redownload_failures,
        COUNT(*) FILTER (WHERE event_type = 'creator.publish_success')::int AS publish_successes,
        COUNT(*) FILTER (WHERE event_type = 'creator.publish_failed')::int AS publish_failures,
        COUNT(*) FILTER (WHERE event_type = 'moderation.action_success')::int AS moderation_successes,
        COUNT(*) FILTER (
          WHERE event_type = 'moderation.action_failed'
             OR (event_type = 'moderation.request' AND success = false)
        )::int AS moderation_failures,
        COUNT(*) FILTER (
          WHERE success = false
             OR status_code >= 400
             OR event_type LIKE '%.failed'
        )::int AS failed_events
      FROM ${tableRef}
      WHERE occurred_at >= NOW() - make_interval(hours => $1::int);
    `,
    [safeWindowHours]
  );

    const topAssetsRes = await pool.query(
    `
      SELECT
        asset_id,
        COALESCE(MAX(asset_type), 'unknown') AS asset_type,
        COUNT(*) FILTER (WHERE event_type = 'purchase.settlement_success')::int AS purchases,
        COUNT(*) FILTER (WHERE event_type = 'redownload.success')::int AS redownloads,
        COUNT(*) FILTER (WHERE event_type = 'purchase.paywall_issued')::int AS paywall_views
      FROM ${tableRef}
      WHERE occurred_at >= NOW() - make_interval(hours => $1::int)
        AND asset_id IS NOT NULL
      GROUP BY asset_id
      ORDER BY purchases DESC, redownloads DESC, paywall_views DESC, asset_id ASC
      LIMIT $2::int;
    `,
    [safeWindowHours, safeLimit]
  );

    const topToolsRes = await pool.query(
    `
      SELECT
        tool_name,
        COUNT(*)::int AS calls,
        COUNT(*) FILTER (WHERE success = false OR event_type LIKE '%.failed')::int AS failures
      FROM ${tableRef}
      WHERE occurred_at >= NOW() - make_interval(hours => $1::int)
        AND event_type = 'mcp.tool_invocation'
        AND tool_name IS NOT NULL
      GROUP BY tool_name
      ORDER BY calls DESC, failures DESC, tool_name ASC
      LIMIT $2::int;
    `,
    [safeWindowHours, safeLimit]
  );

    const routeStatsRes = await pool.query(
    `
      SELECT
        route,
        COALESCE(http_method, '-') AS http_method,
        COUNT(*)::int AS hits,
        COUNT(*) FILTER (WHERE success = false OR status_code >= 400)::int AS failures
      FROM ${tableRef}
      WHERE occurred_at >= NOW() - make_interval(hours => $1::int)
        AND route IS NOT NULL
      GROUP BY route, http_method
      ORDER BY hits DESC, failures DESC, route ASC
      LIMIT $2::int;
    `,
    [safeWindowHours, safeLimit]
  );

    const sourceStatsRes = await pool.query(
    `
      SELECT
        COALESCE(NULLIF(source, ''), 'unknown') AS source,
        COUNT(*)::int AS hits,
        COUNT(*) FILTER (WHERE success = false OR status_code >= 400)::int AS failures
      FROM ${tableRef}
      WHERE occurred_at >= NOW() - make_interval(hours => $1::int)
      GROUP BY source
      ORDER BY hits DESC, failures DESC, source ASC
      LIMIT $2::int;
    `,
    [safeWindowHours, safeLimit]
  );

    const recentErrorsRes = await pool.query(
    `
      SELECT
        occurred_at,
        event_type,
        route,
        tool_name,
        action,
        status_code,
        error_code,
        error_message,
        asset_id
      FROM ${tableRef}
      WHERE occurred_at >= NOW() - make_interval(hours => $1::int)
        AND (
          success = false
          OR status_code >= 400
          OR event_type LIKE '%.failed'
          OR error_code IS NOT NULL
        )
      ORDER BY occurred_at DESC
      LIMIT $2::int;
    `,
    [safeWindowHours, safeLimit]
  );

    const timeseriesRes = await pool.query(
    `
      SELECT
        date_trunc('hour', occurred_at) AS bucket,
        COUNT(*)::int AS total_events,
        COUNT(*) FILTER (WHERE event_type = 'mcp.tool_invocation')::int AS mcp_tool_calls,
        COUNT(*) FILTER (WHERE event_type = 'purchase.settlement_success')::int AS purchases,
        COUNT(*) FILTER (WHERE event_type = 'redownload.success')::int AS redownloads
      FROM ${tableRef}
      WHERE occurred_at >= NOW() - make_interval(hours => $1::int)
      GROUP BY bucket
      ORDER BY bucket ASC;
    `,
    [safeWindowHours]
  );

    const overviewRow = overviewRes.rows?.[0] || {};
    const totalEvents = rowToInt(overviewRow, 'total_events');
    const failedEvents = rowToInt(overviewRow, 'failed_events');

      return {
      ok: true,
      generated_at: new Date().toISOString(),
      window_hours: safeWindowHours,
      overview: {
        total_events: totalEvents,
        failed_events: failedEvents,
        error_rate: totalEvents > 0 ? Number((failedEvents / totalEvents).toFixed(4)) : 0,
        mcp_post_requests: rowToInt(overviewRow, 'mcp_post_requests'),
        mcp_tool_invocations: rowToInt(overviewRow, 'mcp_tool_invocations'),
        paywall_issued: rowToInt(overviewRow, 'paywall_issued'),
        purchase_successes: rowToInt(overviewRow, 'purchase_successes'),
        purchase_failures: rowToInt(overviewRow, 'purchase_failures'),
        redownload_successes: rowToInt(overviewRow, 'redownload_successes'),
        redownload_failures: rowToInt(overviewRow, 'redownload_failures'),
        publish_successes: rowToInt(overviewRow, 'publish_successes'),
        publish_failures: rowToInt(overviewRow, 'publish_failures'),
        moderation_successes: rowToInt(overviewRow, 'moderation_successes'),
        moderation_failures: rowToInt(overviewRow, 'moderation_failures')
      },
      top_assets: (topAssetsRes.rows || []).map((row) => ({
        asset_id: row.asset_id,
        asset_type: row.asset_type,
        purchases: rowToInt(row, 'purchases'),
        redownloads: rowToInt(row, 'redownloads'),
        paywall_views: rowToInt(row, 'paywall_views')
      })),
      mcp_tools: (topToolsRes.rows || []).map((row) => ({
        tool_name: row.tool_name,
        calls: rowToInt(row, 'calls'),
        failures: rowToInt(row, 'failures')
      })),
      api_routes: (routeStatsRes.rows || []).map((row) => ({
        route: row.route,
        method: row.http_method,
        hits: rowToInt(row, 'hits'),
        failures: rowToInt(row, 'failures')
      })),
      source_breakdown: (sourceStatsRes.rows || []).map((row) => ({
        source: row.source,
        hits: rowToInt(row, 'hits'),
        failures: rowToInt(row, 'failures')
      })),
      recent_errors: (recentErrorsRes.rows || []).map((row) => ({
        occurred_at: row.occurred_at,
        event_type: row.event_type,
        route: row.route,
        tool_name: row.tool_name,
        action: row.action,
        status_code: row.status_code,
        error_code: row.error_code,
        error_message: row.error_message,
        asset_id: row.asset_id
      })),
      hourly: (timeseriesRes.rows || []).map((row) => ({
        bucket: row.bucket,
        total_events: rowToInt(row, 'total_events'),
        mcp_tool_calls: rowToInt(row, 'mcp_tool_calls'),
        purchases: rowToInt(row, 'purchases'),
        redownloads: rowToInt(row, 'redownloads')
      }))
      };
    } catch (error) {
      if (attempt === 0 && isTransientTelemetryDbError(error)) {
        await resetTelemetryDbPool();
        const retryPool = getTelemetryDbPool();
        if (!retryPool) {
          throw new AppError(503, {
            error: 'Telemetry database unavailable',
            code: 'telemetry_database_unavailable'
          });
        }
        await ensureTelemetrySchema();
        // eslint-disable-next-line no-param-reassign
        pool = retryPool;
        continue;
      }
      throw new AppError(503, {
        error: 'Telemetry query failed',
        code: 'telemetry_query_failed',
        detail: error instanceof Error ? error.message : String(error || 'unknown_error')
      });
    }
  }
  throw new AppError(503, {
    error: 'Telemetry query failed',
    code: 'telemetry_query_failed',
    detail: 'retry_exhausted'
  });
}
