import { normalizePgIdentifier, quotePgIdentifier, tableRef } from './_shared.js';

export const id = '003-security-scan-store';
export const description = 'Create security scan storage tables';

export async function up({ pool }) {
  const schema = normalizePgIdentifier(process.env.SECURITY_DB_SCHEMA, 'security');
  const reportsTable = tableRef(schema, 'asset_scan_reports');
  const latestTable = tableRef(schema, 'asset_scan_latest');

  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quotePgIdentifier(schema)};`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${reportsTable} (
      id BIGSERIAL PRIMARY KEY,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      asset_id TEXT NOT NULL,
      asset_type TEXT,
      revision_sha256 TEXT,
      scan_verdict TEXT NOT NULL,
      scan_mode TEXT,
      scanner_engine TEXT,
      scanner_ruleset TEXT,
      scanner_fingerprint TEXT,
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
    CREATE INDEX IF NOT EXISTS ${quotePgIdentifier(`${schema}_asset_scan_reports_asset_id_idx`.slice(0, 63))}
    ON ${reportsTable} (asset_id, occurred_at DESC);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quotePgIdentifier(`${schema}_asset_scan_reports_verdict_idx`.slice(0, 63))}
    ON ${reportsTable} (scan_verdict, occurred_at DESC);
  `);
  await pool.query(`ALTER TABLE ${reportsTable} ADD COLUMN IF NOT EXISTS scanner_engine TEXT;`);
  await pool.query(`ALTER TABLE ${reportsTable} ADD COLUMN IF NOT EXISTS scanner_ruleset TEXT;`);
  await pool.query(`ALTER TABLE ${reportsTable} ADD COLUMN IF NOT EXISTS scanner_fingerprint TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${latestTable} (
      asset_id TEXT PRIMARY KEY,
      asset_type TEXT,
      latest_occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revision_sha256 TEXT,
      scan_verdict TEXT NOT NULL,
      scan_mode TEXT,
      scanner_engine TEXT,
      scanner_ruleset TEXT,
      scanner_fingerprint TEXT,
      blocked BOOLEAN NOT NULL DEFAULT FALSE,
      summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      findings_preview JSONB NOT NULL DEFAULT '[]'::jsonb,
      content_sha256 TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE ${latestTable} ADD COLUMN IF NOT EXISTS scanner_engine TEXT;`);
  await pool.query(`ALTER TABLE ${latestTable} ADD COLUMN IF NOT EXISTS scanner_ruleset TEXT;`);
  await pool.query(`ALTER TABLE ${latestTable} ADD COLUMN IF NOT EXISTS scanner_fingerprint TEXT;`);
}
