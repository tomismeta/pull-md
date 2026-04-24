import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { getPrimaryDatabaseUrl, getSharedDbPool, resetSharedDbPool } from '../api/_lib/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../db/migrations');
const migrationTable = 'public.pullmd_schema_migrations';

async function listMigrationFiles() {
  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();
}

async function loadMigrations() {
  const files = await listMigrationFiles();
  const migrations = [];
  for (const file of files) {
    const moduleUrl = pathToFileURL(path.join(migrationsDir, file)).href;
    const mod = await import(moduleUrl);
    if (typeof mod.id !== 'string' || typeof mod.up !== 'function') {
      throw new Error(`Invalid migration module: ${file}`);
    }
    migrations.push({
      id: mod.id,
      description: typeof mod.description === 'string' ? mod.description : '',
      up: mod.up,
      file
    });
  }
  return migrations;
}

async function ensureMigrationTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${migrationTable} (
      id TEXT PRIMARY KEY,
      description TEXT,
      file_name TEXT,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function readAppliedMigrationIds(pool) {
  await ensureMigrationTable(pool);
  const result = await pool.query(`SELECT id FROM ${migrationTable} ORDER BY applied_at ASC, id ASC;`);
  return new Set((result.rows || []).map((row) => row.id));
}

async function applyMigration(pool, migration) {
  await pool.query('BEGIN');
  try {
    await migration.up({ pool });
    await pool.query(
      `
        INSERT INTO ${migrationTable} (id, description, file_name)
        VALUES ($1, $2, $3)
        ON CONFLICT (id) DO NOTHING;
      `,
      [migration.id, migration.description || null, migration.file]
    );
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const connectionString = getPrimaryDatabaseUrl();
  if (!connectionString) {
    throw new Error('No database configured. Set MARKETPLACE_DATABASE_URL, DATABASE_URL, or POSTGRES_URL.');
  }

  const pool = getSharedDbPool({
    name: 'migrator',
    connectionString,
    sslEnv: 'MARKETPLACE_DB_SSL',
    insecureSslEnv: 'MARKETPLACE_DB_SSL_INSECURE',
    caCertEnv: 'MARKETPLACE_DB_CA_CERT',
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 1
  });
  if (!pool) {
    throw new Error('Unable to create database pool for migrations.');
  }

  try {
    const migrations = await loadMigrations();
    const applied = await readAppliedMigrationIds(pool);
    let appliedCount = 0;
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      console.log(`Applying ${migration.id} (${migration.file})`);
      await applyMigration(pool, migration);
      appliedCount += 1;
    }
    if (appliedCount === 0) {
      console.log('Database schema already up to date.');
    } else {
      console.log(`Applied ${appliedCount} migration(s).`);
    }
  } finally {
    await resetSharedDbPool('migrator', connectionString);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
