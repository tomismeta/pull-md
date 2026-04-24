import { normalizePgIdentifier, quotePgIdentifier, tableRef } from './_shared.js';

export const id = '002-telemetry-core';
export const description = 'Create telemetry schema and event table';

export async function up({ pool }) {
  const schema = normalizePgIdentifier(process.env.TELEMETRY_DB_SCHEMA, 'telemetry');
  const qualifiedTable = tableRef(schema, 'marketplace_telemetry_events');
  const indexName = (suffix) => {
    const schemaPrefix = schema.replace(/[^a-z0-9_]/g, '').slice(0, 24);
    const normalizedSuffix = String(suffix || '').replace(/[^a-z0-9_]/gi, '').toLowerCase();
    return quotePgIdentifier(`${schemaPrefix}_marketplace_telemetry_${normalizedSuffix}`.slice(0, 63));
  };

  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quotePgIdentifier(schema)};`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${qualifiedTable} (
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
  await pool.query(`
    ALTER TABLE ${qualifiedTable}
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
  await pool.query(`UPDATE ${qualifiedTable} SET metadata='{}'::jsonb WHERE metadata IS NULL;`);
  await pool.query(`ALTER TABLE ${qualifiedTable} ALTER COLUMN metadata SET DEFAULT '{}'::jsonb;`);
  await pool.query(`ALTER TABLE ${qualifiedTable} ALTER COLUMN metadata SET NOT NULL;`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${indexName('occurred_at')}
    ON ${qualifiedTable} (occurred_at DESC);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${indexName('event_type')}
    ON ${qualifiedTable} (event_type);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${indexName('tool_name')}
    ON ${qualifiedTable} (tool_name);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${indexName('route')}
    ON ${qualifiedTable} (route);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${indexName('asset_id')}
    ON ${qualifiedTable} (asset_id);
  `);

  if (schema !== 'public') {
    await pool.query('DROP TABLE IF EXISTS public.marketplace_telemetry_events;').catch(() => {});
  }
}
