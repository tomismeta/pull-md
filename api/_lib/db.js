import fs from 'fs';
import { Pool } from 'pg';

export const PRIMARY_DB_ENV_KEYS = ['MARKETPLACE_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_URL'];
export const PULLMD_MIGRATION_COMMAND = 'npm run db:migrate';

const DEFAULT_PROVIDER_SSL_HOSTS = /render\.com|neon\.tech|supabase\.co|railway\.app/i;
const PG_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/i;
const poolCache = new Map();
const relationAvailabilityCache = new Map();

function asString(value) {
  return String(value || '').trim();
}

export function getPrimaryDatabaseUrl() {
  for (const key of PRIMARY_DB_ENV_KEYS) {
    const value = asString(process.env[key]);
    if (value) return value;
  }
  return '';
}

export function hasPrimaryDatabase() {
  return Boolean(getPrimaryDatabaseUrl());
}

export function sanitizeDbConnectionString(connectionString) {
  const raw = asString(connectionString);
  if (!raw) return raw;
  try {
    const parsed = new URL(raw);
    parsed.searchParams.delete('sslmode');
    return parsed.toString();
  } catch (_) {
    return raw;
  }
}

function truthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(asString(value).toLowerCase());
}

function maybeLoadCaBundle(rawValue) {
  const candidate = asString(rawValue);
  if (!candidate) return null;
  if (candidate.includes('BEGIN CERTIFICATE')) return candidate;
  try {
    return fs.readFileSync(candidate, 'utf8');
  } catch (_) {
    return null;
  }
}

export function buildPgSslConfig({
  rawConnectionString,
  sslEnv,
  insecureSslEnv,
  caCertEnv
} = {}) {
  const source = asString(rawConnectionString);
  const sslHint = asString(process.env[sslEnv]);
  const insecureHint = asString(process.env[insecureSslEnv]).toLowerCase();
  const ca = maybeLoadCaBundle(process.env[caCertEnv]);
  const needsSsl =
    truthyEnv(sslHint) ||
    /sslmode=require/i.test(source) ||
    DEFAULT_PROVIDER_SSL_HOSTS.test(source);
  if (!needsSsl) return undefined;
  const rejectUnauthorized = !truthyEnv(insecureHint);
  return {
    rejectUnauthorized,
    ...(ca ? { ca } : {})
  };
}

export function normalizePgIdentifier(raw, fallback = 'public') {
  const candidate = asString(raw) || asString(fallback) || 'public';
  if (!PG_IDENTIFIER_RE.test(candidate)) {
    return asString(fallback) || 'public';
  }
  return candidate.toLowerCase();
}

export function quotePgIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function qualifyPgRelation(schema, table) {
  const normalizedSchema = normalizePgIdentifier(schema, 'public');
  return `${normalizedSchema}.${String(table || '').trim()}`;
}

export function getSharedDbPool({
  name,
  connectionString,
  sslEnv,
  insecureSslEnv,
  caCertEnv,
  connectionTimeoutMillis = 5000,
  idleTimeoutMillis = 30000,
  max = 3
}) {
  const rawConnectionString = asString(connectionString || getPrimaryDatabaseUrl());
  if (!rawConnectionString) return null;
  const cacheKey = `${String(name || 'default')}::${rawConnectionString}`;
  if (poolCache.has(cacheKey)) return poolCache.get(cacheKey);
  const pool = new Pool({
    connectionString: sanitizeDbConnectionString(rawConnectionString),
    ssl: buildPgSslConfig({
      rawConnectionString,
      sslEnv,
      insecureSslEnv,
      caCertEnv
    }),
    connectionTimeoutMillis,
    idleTimeoutMillis,
    max
  });
  poolCache.set(cacheKey, pool);
  return pool;
}

export async function assertRelationsExist({
  pool,
  cacheKey,
  relations,
  component = 'application',
  migrationCommand = PULLMD_MIGRATION_COMMAND
}) {
  const normalizedRelations = Array.isArray(relations)
    ? relations.map((relation) => asString(relation)).filter(Boolean)
    : [];
  if (!pool) return false;
  if (normalizedRelations.length === 0) return true;

  const effectiveCacheKey = String(cacheKey || `${component}::${normalizedRelations.join(',')}`);
  if (relationAvailabilityCache.has(effectiveCacheKey)) {
    await relationAvailabilityCache.get(effectiveCacheKey);
    return true;
  }

  const pending = (async () => {
    const { rows } = await pool.query(
      `
        SELECT relation_name, to_regclass(relation_name) IS NOT NULL AS present
        FROM unnest($1::text[]) AS required(relation_name)
      `,
      [normalizedRelations]
    );
    const missing = (rows || []).filter((row) => !row.present).map((row) => row.relation_name);
    if (missing.length > 0) {
      throw new Error(
        `Missing required database relations for ${component}: ${missing.join(', ')}. Run ${migrationCommand}.`
      );
    }
  })();

  relationAvailabilityCache.set(effectiveCacheKey, pending);
  try {
    await pending;
    return true;
  } catch (error) {
    relationAvailabilityCache.delete(effectiveCacheKey);
    throw error;
  }
}

export function clearRelationAvailabilityCache(prefix = '') {
  const normalizedPrefix = asString(prefix);
  if (!normalizedPrefix) {
    relationAvailabilityCache.clear();
    return;
  }
  for (const key of relationAvailabilityCache.keys()) {
    if (key.startsWith(normalizedPrefix)) {
      relationAvailabilityCache.delete(key);
    }
  }
}

export async function resetSharedDbPool(name, connectionString = getPrimaryDatabaseUrl()) {
  const rawConnectionString = asString(connectionString);
  const cacheKey = `${String(name || 'default')}::${rawConnectionString}`;
  clearRelationAvailabilityCache(`${String(name || 'default')}::${rawConnectionString}`);
  const pool = poolCache.get(cacheKey);
  poolCache.delete(cacheKey);
  if (!pool) return;
  try {
    await pool.end();
  } catch (_) {}
}
