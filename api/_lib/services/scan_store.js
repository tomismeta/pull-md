import { Pool } from 'pg';

const DB_CONN_ENV_KEYS = ['MARKETPLACE_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_URL'];
const DEFAULT_SECURITY_SCHEMA = 'security';
const PG_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/i;

let dbPool = null;
let schemaReadyPromise = null;
let schemaReadyKey = null;

function getDatabaseUrl() {
  for (const key of DB_CONN_ENV_KEYS) {
    const value = String(process.env[key] || '').trim();
    if (value) return value;
  }
  return '';
}

function normalizeSecuritySchema(raw) {
  const source = String(raw || '').trim();
  const candidate = source || DEFAULT_SECURITY_SCHEMA;
  if (!PG_IDENTIFIER_RE.test(candidate)) return DEFAULT_SECURITY_SCHEMA;
  return candidate.toLowerCase();
}

function securitySchemaName() {
  return normalizeSecuritySchema(process.env.SECURITY_DB_SCHEMA);
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
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

function getDbPool() {
  const rawConnectionString = getDatabaseUrl();
  if (!rawConnectionString) return null;
  if (dbPool) return dbPool;
  const connectionString = sanitizeDbConnectionString(rawConnectionString);
  const sslHint = String(process.env.SECURITY_DB_SSL || '').trim().toLowerCase();
  const needsSsl =
    sslHint === '1' ||
    sslHint === 'true' ||
    /sslmode=require/i.test(rawConnectionString) ||
    /render\.com|neon\.tech|supabase\.co|railway\.app/i.test(rawConnectionString);
  dbPool = new Pool({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 3
  });
  return dbPool;
}

async function ensureSecuritySchema() {
  const pool = getDbPool();
  if (!pool) return false;
  const dsn = getDatabaseUrl();
  const schema = securitySchemaName();
  const key = `${dsn}::${schema}`;
  if (schemaReadyPromise && schemaReadyKey === key) {
    await schemaReadyPromise;
    return true;
  }

  const reportsTable = `${quoteIdentifier(schema)}.${quoteIdentifier('asset_scan_reports')}`;
  const latestTable = `${quoteIdentifier(schema)}.${quoteIdentifier('asset_scan_latest')}`;
  schemaReadyKey = key;
  schemaReadyPromise = (async () => {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)};`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${reportsTable} (
        id BIGSERIAL PRIMARY KEY,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        asset_id TEXT NOT NULL,
        asset_type TEXT,
        revision_sha256 TEXT,
        scan_verdict TEXT NOT NULL,
        scan_mode TEXT,
        blocked BOOLEAN NOT NULL DEFAULT FALSE,
        summary JSONB NOT NULL DEFAULT '{}'::jsonb,
        findings JSONB NOT NULL DEFAULT '[]'::jsonb,
        context JSONB NOT NULL DEFAULT '{}'::jsonb,
        wallet_address TEXT,
        source TEXT,
        route TEXT,
        action TEXT
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${schema}_asset_scan_reports_asset_id_idx`.slice(0, 63))}
      ON ${reportsTable} (asset_id, occurred_at DESC);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${schema}_asset_scan_reports_verdict_idx`.slice(0, 63))}
      ON ${reportsTable} (scan_verdict, occurred_at DESC);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${latestTable} (
        asset_id TEXT PRIMARY KEY,
        asset_type TEXT,
        latest_occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revision_sha256 TEXT,
        scan_verdict TEXT NOT NULL,
        scan_mode TEXT,
        blocked BOOLEAN NOT NULL DEFAULT FALSE,
        summary JSONB NOT NULL DEFAULT '{}'::jsonb,
        findings_preview JSONB NOT NULL DEFAULT '[]'::jsonb,
        content_sha256 TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  })();

  try {
    await schemaReadyPromise;
    return true;
  } catch (error) {
    schemaReadyPromise = null;
    throw error;
  }
}

function asString(value) {
  return String(value || '').trim();
}

function normalizeAssetType(value) {
  return asString(value).toLowerCase().replace(/[\s_]+/g, '-');
}

function findingsPreview(findings) {
  const list = Array.isArray(findings) ? findings : [];
  return list.slice(0, 5).map((item) => ({
    scanner: asString(item?.scanner),
    code: asString(item?.code),
    severity: asString(item?.severity).toLowerCase() || 'medium',
    action: asString(item?.action).toLowerCase() || 'warn',
    message: asString(item?.message)
    }));
}

function normalizeSummary(value) {
  return value && typeof value === 'object'
    ? value
    : { total: 0, by_severity: { high: 0, medium: 0, low: 0 }, by_action: { block: 0, warn: 0 } };
}

function normalizeScanSnapshot(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    verdict: asString(row.scan_verdict).toLowerCase() || null,
    mode: asString(row.scan_mode).toLowerCase() || null,
    blocked: Boolean(row.blocked),
    scanned_at: row.latest_occurred_at ? new Date(row.latest_occurred_at).toISOString() : null,
    content_sha256: asString(row.content_sha256) || asString(row.revision_sha256) || null,
    summary: normalizeSummary(row.summary),
    findings_preview: Array.isArray(row.findings_preview) ? row.findings_preview : []
  };
}

export async function getLatestAssetScan(assetId) {
  const id = asString(assetId);
  if (!id) {
    return { ok: false, present: false, code: 'missing_asset_id', scan: null };
  }
  const pool = getDbPool();
  if (!pool) {
    return { ok: false, present: false, code: 'scan_store_unconfigured', scan: null };
  }
  await ensureSecuritySchema();
  const schema = securitySchemaName();
  const latestTable = `${quoteIdentifier(schema)}.${quoteIdentifier('asset_scan_latest')}`;
  const result = await pool.query(
    `
      SELECT asset_id, asset_type, latest_occurred_at, revision_sha256, scan_verdict, scan_mode, blocked, summary, findings_preview, content_sha256
      FROM ${latestTable}
      WHERE asset_id = $1
      LIMIT 1
    `,
    [id]
  );
  const row = result?.rows?.[0] || null;
  if (!row) {
    return { ok: true, present: false, code: null, scan: null };
  }
  return {
    ok: true,
    present: true,
    code: null,
    scan: normalizeScanSnapshot(row)
  };
}

export async function persistAssetScanReport({
  assetId,
  assetType,
  scanReport,
  walletAddress = null,
  source = null,
  route = null,
  action = null
} = {}) {
  const id = asString(assetId);
  if (!id) {
    return { ok: false, persisted: false, code: 'missing_asset_id' };
  }
  const report = scanReport && typeof scanReport === 'object' ? scanReport : null;
  if (!report) {
    return { ok: false, persisted: false, code: 'missing_scan_report' };
  }
  const pool = getDbPool();
  if (!pool) {
    return { ok: false, persisted: false, code: 'scan_store_unconfigured' };
  }

  await ensureSecuritySchema();
  const schema = securitySchemaName();
  const reportsTable = `${quoteIdentifier(schema)}.${quoteIdentifier('asset_scan_reports')}`;
  const latestTable = `${quoteIdentifier(schema)}.${quoteIdentifier('asset_scan_latest')}`;

  const normalizedAssetType = normalizeAssetType(assetType || report?.asset_type || '');
  const verdict = asString(report.verdict || 'warn').toLowerCase() || 'warn';
  const mode = asString(report.mode || 'advisory').toLowerCase() || 'advisory';
  const blocked = Boolean(report.blocked);
  const summary = report.summary && typeof report.summary === 'object' ? report.summary : {};
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const revisionSha = asString(report.content_sha256 || '');
  const context = {
    scanned_at: asString(report.scanned_at || null) || null,
    fail_policy: asString(report.fail_policy || null) || null
  };

  const values = [
    id,
    normalizedAssetType || null,
    revisionSha || null,
    verdict,
    mode,
    blocked,
    JSON.stringify(summary),
    JSON.stringify(findings),
    JSON.stringify(context),
    asString(walletAddress || '').toLowerCase() || null,
    asString(source || '') || null,
    asString(route || '') || null,
    asString(action || '') || null
  ];

  await pool.query(
    `
      INSERT INTO ${reportsTable}
      (asset_id, asset_type, revision_sha256, scan_verdict, scan_mode, blocked, summary, findings, context, wallet_address, source, route, action)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13)
    `,
    values
  );
  await pool.query(
    `
      INSERT INTO ${latestTable}
      (asset_id, asset_type, latest_occurred_at, revision_sha256, scan_verdict, scan_mode, blocked, summary, findings_preview, content_sha256, updated_at)
      VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, NOW())
      ON CONFLICT (asset_id)
      DO UPDATE SET
        asset_type = EXCLUDED.asset_type,
        latest_occurred_at = EXCLUDED.latest_occurred_at,
        revision_sha256 = EXCLUDED.revision_sha256,
        scan_verdict = EXCLUDED.scan_verdict,
        scan_mode = EXCLUDED.scan_mode,
        blocked = EXCLUDED.blocked,
        summary = EXCLUDED.summary,
        findings_preview = EXCLUDED.findings_preview,
        content_sha256 = EXCLUDED.content_sha256,
        updated_at = NOW()
    `,
    [
      id,
      normalizedAssetType || null,
      revisionSha || null,
      verdict,
      mode,
      blocked,
      JSON.stringify(summary),
      JSON.stringify(findingsPreview(findings)),
      revisionSha || null
    ]
  );

  return {
    ok: true,
    persisted: true,
    schema: schema,
    latest: {
      asset_id: id,
      asset_type: normalizedAssetType || null,
      scan_verdict: verdict,
      scan_mode: mode,
      blocked,
      summary,
      findings_preview: findingsPreview(findings),
      content_sha256: revisionSha || null
    }
  };
}
