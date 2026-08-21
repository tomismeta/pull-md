import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import {
  getPrimaryDatabaseUrl,
  getSharedDbPool,
  quotePgIdentifier,
  resetSharedDbPool
} from '../api/_lib/db.js';

function jsonReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function safeFileName(schema, table) {
  return `${schema}.${table}`.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function databaseIdentity(connectionString) {
  try {
    const parsed = new URL(connectionString);
    return {
      host: parsed.hostname,
      database: parsed.pathname.replace(/^\//, '') || null
    };
  } catch (_) {
    return { host: null, database: null };
  }
}

async function sha256File(filePath) {
  const contents = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(contents).digest('hex');
}

async function main() {
  const outputArg = String(process.argv[2] || '').trim();
  if (!outputArg) {
    throw new Error('Usage: npm run db:export-retirement -- /absolute/output/directory');
  }

  const outputDir = path.resolve(outputArg);
  const connectionString = getPrimaryDatabaseUrl();
  if (!connectionString) {
    throw new Error('No database configured. Set MARKETPLACE_DATABASE_URL, DATABASE_URL, or POSTGRES_URL.');
  }

  await fs.mkdir(path.dirname(outputDir), { recursive: true, mode: 0o700 });
  await fs.mkdir(outputDir, { recursive: false, mode: 0o700 });

  const pool = getSharedDbPool({
    name: 'retirement-export',
    connectionString,
    sslEnv: 'MARKETPLACE_DB_SSL',
    insecureSslEnv: 'MARKETPLACE_DB_SSL_INSECURE',
    caCertEnv: 'MARKETPLACE_DB_CA_CERT',
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 1
  });
  if (!pool) throw new Error('Unable to create database pool for retirement export.');

  const telemetrySchema = String(process.env.TELEMETRY_DB_SCHEMA || 'telemetry').trim() || 'telemetry';
  const securitySchema = String(process.env.SECURITY_DB_SCHEMA || 'security').trim() || 'security';

  try {
    const tableResult = await pool.query(
      `
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_type = 'BASE TABLE'
          AND (
            (
              table_schema = 'public'
              AND (
                table_name LIKE 'asset\\_%' ESCAPE '\\'
                OR table_name LIKE 'soul\\_%' ESCAPE '\\'
                OR table_name LIKE 'pullmd\\_%' ESCAPE '\\'
              )
            )
            OR table_schema = $1
            OR table_schema = $2
          )
        ORDER BY table_schema, table_name
      `,
      [telemetrySchema, securitySchema]
    );

    const manifest = {
      schema_version: 'pullmd-retirement-export-v1',
      exported_at: new Date().toISOString(),
      source: databaseIdentity(connectionString),
      tables: [],
      total_rows: 0
    };

    for (const tableInfo of tableResult.rows || []) {
      const schema = String(tableInfo.table_schema);
      const table = String(tableInfo.table_name);
      const relation = `${quotePgIdentifier(schema)}.${quotePgIdentifier(table)}`;
      const [rowsResult, columnsResult] = await Promise.all([
        pool.query(`SELECT * FROM ${relation}`),
        pool.query(
          `
            SELECT column_name, data_type, is_nullable, ordinal_position
            FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position
          `,
          [schema, table]
        )
      ]);

      const fileName = `${safeFileName(schema, table)}.jsonl`;
      const filePath = path.join(outputDir, fileName);
      const body = (rowsResult.rows || [])
        .map((row) => JSON.stringify(row, jsonReplacer))
        .join('\n');
      await fs.writeFile(filePath, body ? `${body}\n` : '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });

      const rowCount = Number(rowsResult.rowCount || 0);
      manifest.total_rows += rowCount;
      manifest.tables.push({
        schema,
        table,
        file: fileName,
        rows: rowCount,
        sha256: await sha256File(filePath),
        columns: (columnsResult.rows || []).map((column) => ({
          name: column.column_name,
          type: column.data_type,
          nullable: column.is_nullable === 'YES'
        }))
      });
    }

    const manifestPath = path.join(outputDir, 'manifest.json');
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    console.log(`Exported ${manifest.tables.length} table(s) and ${manifest.total_rows} row(s) to ${outputDir}`);
  } finally {
    await resetSharedDbPool('retirement-export', connectionString);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
