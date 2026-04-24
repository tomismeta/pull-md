import { promises as fs } from 'fs';
import path from 'path';

import { assertRelationsExist, getPrimaryDatabaseUrl, getSharedDbPool, qualifyPgRelation } from './db.js';

const ENTITLEMENTS_FILE = 'asset-entitlements.json';
const ENTITLEMENT_CACHE_TTL_MS = Number(process.env.ENTITLEMENT_CACHE_TTL_MS || String(7 * 24 * 60 * 60 * 1000));
const fileCache = new Map();
let schemaReadyPromise = null;
let schemaReadyKey = null;

function entitlementStorageMode() {
  if (getPrimaryDatabaseUrl()) return 'database';
  if (process.env.VERCEL) return 'unconfigured';
  return 'file';
}

function getMarketplaceDraftsDir() {
  const configured = String(process.env.MARKETPLACE_DRAFTS_DIR || '').trim();
  if (configured) return configured;
  if (process.env.VERCEL) {
    return '/tmp/pullmd-marketplace-drafts';
  }
  return path.join(process.cwd(), '.marketplace-drafts');
}

function entitlementsFilePath() {
  return path.join(getMarketplaceDraftsDir(), ENTITLEMENTS_FILE);
}

function normalizeWalletAddress(value) {
  const wallet = String(value || '').trim().toLowerCase();
  return /^0x[a-f0-9]{40}$/i.test(wallet) ? wallet : '';
}

function normalizeAssetId(value) {
  return String(value || '').trim().toLowerCase();
}

function cacheKey(walletAddress, assetId) {
  return `${normalizeWalletAddress(walletAddress)}::${normalizeAssetId(assetId)}`;
}

function cacheEntitlement(entitlement) {
  const walletAddress = normalizeWalletAddress(entitlement?.wallet_address);
  const assetId = normalizeAssetId(entitlement?.asset_id);
  if (!walletAddress || !assetId) return;
  fileCache.set(cacheKey(walletAddress, assetId), {
    entitlement: {
      wallet_address: walletAddress,
      asset_id: assetId,
      transaction_ref: String(entitlement?.transaction_ref || '').trim() || null,
      source: String(entitlement?.source || 'purchase').trim() || 'purchase',
      granted_at: entitlement?.granted_at || new Date().toISOString(),
      updated_at: entitlement?.updated_at || new Date().toISOString(),
      metadata: entitlement?.metadata && typeof entitlement.metadata === 'object' ? entitlement.metadata : {}
    },
    expiresAt: Date.now() + ENTITLEMENT_CACHE_TTL_MS
  });
}

function getCachedEntitlement(walletAddress, assetId) {
  const cached = fileCache.get(cacheKey(walletAddress, assetId));
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    fileCache.delete(cacheKey(walletAddress, assetId));
    return null;
  }
  return cached.entitlement;
}

async function ensureFileStore() {
  await fs.mkdir(getMarketplaceDraftsDir(), { recursive: true });
}

async function loadFileStore() {
  await ensureFileStore();
  try {
    const raw = await fs.readFile(entitlementsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      return { schema_version: 'asset-entitlements-v1', entries: [] };
    }
    return parsed;
  } catch (_) {
    return { schema_version: 'asset-entitlements-v1', entries: [] };
  }
}

async function saveFileStore(payload) {
  await ensureFileStore();
  const normalized = {
    schema_version: 'asset-entitlements-v1',
    updated_at: new Date().toISOString(),
    entries: Array.isArray(payload?.entries) ? payload.entries : []
  };
  await fs.writeFile(entitlementsFilePath(), JSON.stringify(normalized, null, 2), { mode: 0o600 });
  return normalized;
}

function getEntitlementsDbPool() {
  const connectionString = getPrimaryDatabaseUrl();
  if (!connectionString) return null;
  return getSharedDbPool({
    name: 'entitlements',
    connectionString,
    sslEnv: 'MARKETPLACE_DB_SSL',
    insecureSslEnv: 'MARKETPLACE_DB_SSL_INSECURE',
    caCertEnv: 'MARKETPLACE_DB_CA_CERT',
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    max: 3
  });
}

async function ensureEntitlementSchema() {
  const pool = getEntitlementsDbPool();
  if (!pool) return false;
  const key = getPrimaryDatabaseUrl();
  if (schemaReadyPromise && schemaReadyKey === key) {
    await schemaReadyPromise;
    return true;
  }
  schemaReadyKey = key;
  schemaReadyPromise = (async () => {
    await assertRelationsExist({
      pool,
      cacheKey: `entitlements::${key}`,
      component: 'asset entitlements',
      relations: [qualifyPgRelation('public', 'asset_entitlements')]
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

export async function getAssetEntitlement({ walletAddress, assetId }) {
  const wallet = normalizeWalletAddress(walletAddress);
  const id = normalizeAssetId(assetId);
  if (!wallet || !id) return null;
  const cached = getCachedEntitlement(wallet, id);
  if (cached) return cached;

  const mode = entitlementStorageMode();
  if (mode === 'database') {
    const pool = getEntitlementsDbPool();
    await ensureEntitlementSchema();
    const result = await pool.query(
      `
        SELECT wallet_address, asset_id, transaction_ref, source, metadata, granted_at, updated_at
        FROM asset_entitlements
        WHERE wallet_address = $1 AND asset_id = $2
        LIMIT 1
      `,
      [wallet, id]
    );
    const row = result?.rows?.[0] || null;
    if (!row) return null;
    const entitlement = {
      wallet_address: row.wallet_address,
      asset_id: row.asset_id,
      transaction_ref: row.transaction_ref || null,
      source: row.source || 'purchase',
      metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
      granted_at: row.granted_at ? new Date(row.granted_at).toISOString() : new Date().toISOString(),
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString()
    };
    cacheEntitlement(entitlement);
    return entitlement;
  }

  if (mode === 'file') {
    const store = await loadFileStore();
    const entitlement =
      (store.entries || []).find((entry) => entry?.wallet_address === wallet && entry?.asset_id === id) || null;
    if (entitlement) cacheEntitlement(entitlement);
    return entitlement;
  }

  return null;
}

export async function recordAssetEntitlement({
  walletAddress,
  assetId,
  transactionRef,
  source = 'purchase',
  metadata = {}
}) {
  const wallet = normalizeWalletAddress(walletAddress);
  const id = normalizeAssetId(assetId);
  if (!wallet || !id) {
    throw new Error('walletAddress and assetId are required to record entitlement');
  }
  const now = new Date().toISOString();
  const next = {
    wallet_address: wallet,
    asset_id: id,
    transaction_ref: String(transactionRef || '').trim() || null,
    source: String(source || 'purchase').trim() || 'purchase',
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    granted_at: now,
    updated_at: now
  };
  const mode = entitlementStorageMode();
  if (mode === 'database') {
    const pool = getEntitlementsDbPool();
    await ensureEntitlementSchema();
    await pool.query(
      `
        INSERT INTO asset_entitlements (
          wallet_address, asset_id, transaction_ref, source, metadata, granted_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7::timestamptz)
        ON CONFLICT (wallet_address, asset_id)
        DO UPDATE SET
          transaction_ref = EXCLUDED.transaction_ref,
          source = EXCLUDED.source,
          metadata = EXCLUDED.metadata,
          updated_at = EXCLUDED.updated_at
      `,
      [wallet, id, next.transaction_ref, next.source, JSON.stringify(next.metadata), next.granted_at, next.updated_at]
    );
    cacheEntitlement(next);
    return next;
  }

  if (mode === 'file') {
    const store = await loadFileStore();
    const entries = Array.isArray(store.entries) ? [...store.entries] : [];
    const idx = entries.findIndex((entry) => entry?.wallet_address === wallet && entry?.asset_id === id);
    if (idx >= 0) {
      entries[idx] = {
        ...entries[idx],
        transaction_ref: next.transaction_ref,
        source: next.source,
        metadata: next.metadata,
        updated_at: now
      };
      cacheEntitlement(entries[idx]);
    } else {
      entries.push(next);
      cacheEntitlement(next);
    }
    await saveFileStore({ entries });
    return idx >= 0 ? entries[idx] : next;
  }

  throw new Error('Asset entitlement persistence is unavailable');
}

export function clearEntitlementCache() {
  fileCache.clear();
}
