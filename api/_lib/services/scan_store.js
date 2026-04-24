import { assertRelationsExist, getPrimaryDatabaseUrl, getSharedDbPool, qualifyPgRelation } from '../db.js';

const DEFAULT_SECURITY_SCHEMA = 'security';
const PG_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/i;

let schemaReadyPromise = null;
let schemaReadyKey = null;

function getDatabaseUrl() {
  return getPrimaryDatabaseUrl();
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

function getDbPool() {
  const rawConnectionString = getDatabaseUrl();
  if (!rawConnectionString) return null;
  return getSharedDbPool({
    name: 'security',
    connectionString: rawConnectionString,
    sslEnv: 'SECURITY_DB_SSL',
    insecureSslEnv: 'SECURITY_DB_SSL_INSECURE',
    caCertEnv: 'SECURITY_DB_CA_CERT',
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 3
  });
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

  schemaReadyKey = key;
  schemaReadyPromise = (async () => {
    await assertRelationsExist({
      pool,
      cacheKey: `security::${key}`,
      component: 'security scan store',
      relations: [
        qualifyPgRelation(schema, 'asset_scan_reports'),
        qualifyPgRelation(schema, 'asset_scan_latest')
      ]
    });
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
    scanner_engine: asString(row.scanner_engine) || null,
    scanner_ruleset: asString(row.scanner_ruleset) || null,
    scanner_fingerprint: asString(row.scanner_fingerprint) || null,
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
      , scanner_engine, scanner_ruleset, scanner_fingerprint
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

function normalizeScanReportRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    asset_id: asString(row.asset_id) || null,
    asset_type: asString(row.asset_type) || null,
    verdict: asString(row.scan_verdict).toLowerCase() || null,
    mode: asString(row.scan_mode).toLowerCase() || null,
    scanner_engine: asString(row.scanner_engine) || null,
    scanner_ruleset: asString(row.scanner_ruleset) || null,
    scanner_fingerprint: asString(row.scanner_fingerprint) || null,
    blocked: Boolean(row.blocked),
    scanned_at: row.occurred_at ? new Date(row.occurred_at).toISOString() : null,
    content_sha256: asString(row.revision_sha256) || null,
    summary: normalizeSummary(row.summary),
    findings: Array.isArray(row.findings) ? row.findings : [],
    context: row.context && typeof row.context === 'object' ? row.context : {}
  };
}

export async function getLatestAssetScanReport(assetId) {
  const id = asString(assetId);
  if (!id) {
    return { ok: false, present: false, code: 'missing_asset_id', report: null };
  }
  const pool = getDbPool();
  if (!pool) {
    return { ok: false, present: false, code: 'scan_store_unconfigured', report: null };
  }
  await ensureSecuritySchema();
  const schema = securitySchemaName();
  const reportsTable = `${quoteIdentifier(schema)}.${quoteIdentifier('asset_scan_reports')}`;
  const result = await pool.query(
    `
      SELECT asset_id, asset_type, revision_sha256, scan_verdict, scan_mode, blocked, summary, findings, context, occurred_at
      , scanner_engine, scanner_ruleset, scanner_fingerprint
      FROM ${reportsTable}
      WHERE asset_id = $1
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1
    `,
    [id]
  );
  const row = result?.rows?.[0] || null;
  if (!row) {
    return { ok: true, present: false, code: null, report: null };
  }
  return {
    ok: true,
    present: true,
    code: null,
    report: normalizeScanReportRow(row)
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
  const scannerEngine = asString(report.scanner_engine || '');
  const scannerRuleset = asString(report.scanner_ruleset || '');
  const scannerFingerprint = asString(report.scanner_fingerprint || '');
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
    scannerEngine || null,
    scannerRuleset || null,
    scannerFingerprint || null,
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
      (asset_id, asset_type, revision_sha256, scan_verdict, scan_mode, scanner_engine, scanner_ruleset, scanner_fingerprint, blocked, summary, findings, context, wallet_address, source, route, action)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15, $16)
    `,
    values
  );
  await pool.query(
    `
      INSERT INTO ${latestTable}
      (asset_id, asset_type, latest_occurred_at, revision_sha256, scan_verdict, scan_mode, scanner_engine, scanner_ruleset, scanner_fingerprint, blocked, summary, findings_preview, content_sha256, updated_at)
      VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, NOW())
      ON CONFLICT (asset_id)
      DO UPDATE SET
        asset_type = EXCLUDED.asset_type,
        latest_occurred_at = EXCLUDED.latest_occurred_at,
        revision_sha256 = EXCLUDED.revision_sha256,
        scan_verdict = EXCLUDED.scan_verdict,
        scan_mode = EXCLUDED.scan_mode,
        scanner_engine = EXCLUDED.scanner_engine,
        scanner_ruleset = EXCLUDED.scanner_ruleset,
        scanner_fingerprint = EXCLUDED.scanner_fingerprint,
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
      scannerEngine || null,
      scannerRuleset || null,
      scannerFingerprint || null,
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
      scanner_engine: scannerEngine || null,
      scanner_ruleset: scannerRuleset || null,
      scanner_fingerprint: scannerFingerprint || null,
      blocked,
      summary,
      findings_preview: findingsPreview(findings),
      content_sha256: revisionSha || null
    }
  };
}
