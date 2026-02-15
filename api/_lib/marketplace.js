import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { Pool } from 'pg';

const SOUL_TYPES = new Set(['synthetic', 'organic', 'hybrid']);
const MAX_SOUL_MD_BYTES = 64 * 1024;
const MAX_TAGS = 12;
const CREATOR_AUTH_DRIFT_MS = 5 * 60 * 1000;
const MODERATOR_AUTH_DRIFT_MS = 5 * 60 * 1000;
const AUTH_STATEMENT = 'Authentication only. No token transfer or approval.';
const REVIEW_AUDIT_FILE = 'review-audit.jsonl';
const PUBLISHED_CATALOG_FILE = 'published-catalog.json';
const DEFAULT_MODERATOR_WALLETS = ['0x7F46aCB709cd8DF5879F84915CA431fB740989E4'];
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DB_CONN_ENV_KEYS = ['MARKETPLACE_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_URL'];
const DB_FAILURE_COOLDOWN_MS = Number(process.env.MARKETPLACE_DB_FAILURE_COOLDOWN_MS || '60000');
let dbPool = null;
let dbSchemaReadyPromise = null;
let dbSchemaReadyForDsn = null;
let dbDisabledUntilMs = 0;

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTags(value) {
  const tags = Array.isArray(value) ? value : [];
  const normalized = [];
  for (const raw of tags) {
    const next = asString(raw).toLowerCase();
    if (!next) continue;
    if (normalized.includes(next)) continue;
    normalized.push(next);
    if (normalized.length >= MAX_TAGS) break;
  }
  return normalized;
}

function normalizeUsdPriceToMicroUsdc(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value <= 0) return null;
  const micro = Math.round(value * 1_000_000);
  if (micro <= 0) return null;
  return String(micro);
}

function validateEthAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ''));
}

function validateSoulId(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value || ''));
}

function normalizePlatformFeeBps() {
  const raw = Number(process.env.PLATFORM_FEE_BPS || '100');
  if (!Number.isFinite(raw)) return 100;
  if (raw < 0) return 0;
  if (raw > 10000) return 10000;
  return Math.round(raw);
}

function slugifySoulId(name) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 48);
  const slug = base || 'creator-soul';
  return /-v\d+$/.test(slug) ? slug : `${slug}-v1`;
}

function deriveIconFromName(name) {
  const clean = String(name || '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  if (parts.length === 1 && parts[0].length >= 2) return parts[0].slice(0, 2).toUpperCase();
  if (parts.length === 1 && parts[0].length === 1) return `${parts[0].toUpperCase()}S`;
  return 'SS';
}

function buildDraftInput(input, options = {}) {
  const payload = input && typeof input === 'object' ? input : {};
  const listing = payload.listing && typeof payload.listing === 'object' ? payload.listing : {};
  const assets = payload.assets && typeof payload.assets === 'object' ? payload.assets : {};

  const name = asString(listing.name || payload.name);
  const description = asString(listing.description || payload.description);
  const longDescription = asString(listing.long_description || payload.long_description || description);
  const category = asString(listing.category || payload.category).toLowerCase() || 'creator';
  const soulType = asString(listing.soul_type || payload.soul_type).toLowerCase() || 'hybrid';
  const icon = asString(listing.icon || payload.icon) || deriveIconFromName(name);
  const tags = normalizeTags(listing.tags || payload.tags);
  const priceUsdc =
    typeof listing.price_usdc === 'number'
      ? listing.price_usdc
      : typeof payload.price_usdc === 'number'
        ? payload.price_usdc
        : Number(listing.price_usdc ?? payload.price_usdc ?? payload.price);

  const walletSeller = asString(options.walletAddress || '');
  const configuredSeller = asString(process.env.SELLER_ADDRESS || '');
  const sellerAddress = asString(listing.seller_address || payload.seller_address || walletSeller || configuredSeller || ZERO_ADDRESS);
  const sourceUrl = asString(assets.source_url || payload.source_url);
  const sourceLabel = asString(assets.source_label || payload.source_label);
  const soulMarkdown =
    typeof assets.soul_markdown === 'string'
      ? assets.soul_markdown
      : typeof payload.soul_markdown === 'string'
        ? payload.soul_markdown
        : typeof payload.soul_md === 'string'
          ? payload.soul_md
          : '';

  const soulId = asString(listing.soul_id || payload.soul_id).toLowerCase() || slugifySoulId(name);
  const platformFeeBps = normalizePlatformFeeBps();
  const creatorRoyaltyBps = 10000 - platformFeeBps;

  return {
    schema_version: 'marketplace-draft-v1',
    listing: {
      soul_id: soulId,
      name,
      description,
      long_description: longDescription,
      category,
      soul_type: soulType,
      icon,
      tags,
      price_usdc: priceUsdc,
      seller_address: sellerAddress,
      creator_royalty_bps: creatorRoyaltyBps,
      platform_fee_bps: platformFeeBps
    },
    assets: {
      soul_markdown: soulMarkdown,
      source_url: sourceUrl,
      source_label: sourceLabel
    }
  };
}

function getMarketplaceDraftsDir() {
  const configured = String(process.env.MARKETPLACE_DRAFTS_DIR || '').trim();
  if (configured) return configured;
  if (process.env.VERCEL) {
    return '/tmp/soulstarter-marketplace-drafts';
  }
  return process.env.MARKETPLACE_DRAFTS_DIR || path.join(process.cwd(), '.marketplace-drafts');
}

function getMarketplaceDatabaseUrl() {
  for (const key of DB_CONN_ENV_KEYS) {
    const value = String(process.env[key] || '').trim();
    if (value) return value;
  }
  return '';
}

function isStrictDatabaseMode() {
  return Boolean(process.env.VERCEL) && Boolean(getMarketplaceDatabaseUrl());
}

function isMarketplaceDbEnabled() {
  if (isStrictDatabaseMode()) return true;
  if (Date.now() < dbDisabledUntilMs) return false;
  return Boolean(getMarketplaceDatabaseUrl());
}

function markDbFailure() {
  if (isStrictDatabaseMode()) return;
  const cooldown = Number.isFinite(DB_FAILURE_COOLDOWN_MS) && DB_FAILURE_COOLDOWN_MS > 0 ? DB_FAILURE_COOLDOWN_MS : 60000;
  dbDisabledUntilMs = Date.now() + cooldown;
}

function getMarketplaceDbPool() {
  const connectionString = getMarketplaceDatabaseUrl();
  if (!connectionString) return null;
  if (dbPool) return dbPool;

  const sslHint = String(process.env.MARKETPLACE_DB_SSL || '').trim().toLowerCase();
  const needsSsl =
    sslHint === '1' ||
    sslHint === 'true' ||
    /sslmode=require/i.test(connectionString) ||
    /render\.com|neon\.tech|supabase\.co|railway\.app/i.test(connectionString);

  dbPool = new Pool({
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined
  });
  return dbPool;
}

async function ensureMarketplaceDbSchema() {
  const pool = getMarketplaceDbPool();
  if (!pool) return false;
  const dsn = getMarketplaceDatabaseUrl();
  if (dbSchemaReadyPromise && dbSchemaReadyForDsn === dsn) {
    await dbSchemaReadyPromise;
    return true;
  }

  dbSchemaReadyForDsn = dsn;
  dbSchemaReadyPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS soul_marketplace_drafts (
        wallet_address TEXT NOT NULL,
        draft_id TEXT NOT NULL,
        status TEXT NOT NULL,
        moderation JSONB,
        normalized JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        published_at TIMESTAMPTZ,
        PRIMARY KEY (wallet_address, draft_id)
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_soul_marketplace_drafts_status_updated
      ON soul_marketplace_drafts (status, updated_at DESC);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS soul_marketplace_audit (
        id BIGSERIAL PRIMARY KEY,
        at TIMESTAMPTZ NOT NULL,
        event TEXT NOT NULL,
        wallet_address TEXT NOT NULL,
        draft_id TEXT,
        actor TEXT,
        decision TEXT,
        status_before TEXT,
        status_after TEXT,
        notes TEXT,
        payload JSONB
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS soul_catalog_entries (
        id TEXT PRIMARY KEY,
        entry JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  })();

  try {
    await dbSchemaReadyPromise;
    return true;
  } catch (error) {
    dbSchemaReadyPromise = null;
    throw error;
  }
}

function walletFilePath(walletAddress) {
  const wallet = String(walletAddress || '').toLowerCase();
  return path.join(getMarketplaceDraftsDir(), `${wallet}.json`);
}

function safeChecksumAddress(address) {
  try {
    return ethers.getAddress(String(address || '').trim());
  } catch (_) {
    return null;
  }
}

function buildTypedAuthPayload({ domainName, primaryType, wallet, action, timestamp }) {
  const normalizedWallet = ethers.getAddress(String(wallet || '').trim());
  const ts = Number(timestamp);
  return {
    domain: {
      name: domainName,
      version: '1'
    },
    primaryType,
    types: {
      [primaryType]: [
        { name: 'wallet', type: 'address' },
        { name: 'action', type: 'string' },
        { name: 'timestamp', type: 'uint256' },
        { name: 'statement', type: 'string' }
      ]
    },
    message: {
      wallet: normalizedWallet,
      action: String(action || '').trim(),
      timestamp: ts,
      statement: AUTH_STATEMENT
    }
  };
}

function buildCreatorAuthMessageWithNewline({ wallet, action, timestamp, newline }) {
  return ['SoulStarter Creator Authentication', `address:${wallet}`, `action:${action}`, `timestamp:${timestamp}`].join(
    newline
  );
}

function buildCreatorAuthMessageCandidates({ wallet, action, timestamp }) {
  const raw = asString(wallet);
  const lower = raw.toLowerCase();
  const checksummed = safeChecksumAddress(raw);
  const wallets = [...new Set([lower, checksummed].filter(Boolean))];
  const newlines = ['\n', '\r\n'];
  const messages = [];
  for (const walletVariant of wallets) {
    for (const newline of newlines) {
      messages.push({
        variant: `${walletVariant === lower ? 'lowercase' : 'checksummed'}-${newline === '\n' ? 'lf' : 'crlf'}`,
        message: buildCreatorAuthMessageWithNewline({ wallet: walletVariant, action, timestamp, newline })
      });
    }
  }
  return messages;
}

async function ensureDraftStore() {
  if (isMarketplaceDbEnabled()) return;
  await fs.mkdir(getMarketplaceDraftsDir(), { recursive: true });
}

async function loadWalletDraftFile(walletAddress) {
  const wallet = String(walletAddress || '').toLowerCase();
  if (isMarketplaceDbEnabled()) {
    try {
      await ensureMarketplaceDbSchema();
      const pool = getMarketplaceDbPool();
      const { rows } = await pool.query(
        `
          SELECT draft_id, status, moderation, normalized, created_at, updated_at, published_at
          FROM soul_marketplace_drafts
          WHERE wallet_address = $1
          ORDER BY updated_at DESC
        `,
        [wallet]
      );
      return {
        wallet,
        drafts: rows.map((row) => ({
          draft_id: row.draft_id,
          status: row.status || 'draft',
          moderation: row.moderation || null,
          normalized: row.normalized || {},
          created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
          updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
          published_at: row.published_at ? new Date(row.published_at).toISOString() : null
        }))
      };
    } catch (_) {
      markDbFailure();
    }
  }

  await ensureDraftStore();
  const filePath = walletFilePath(walletAddress);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.drafts)) {
      return { wallet, drafts: [] };
    }
    return parsed;
  } catch (_) {
    return { wallet, drafts: [] };
  }
}

async function saveWalletDraftFile(walletAddress, payload) {
  const wallet = String(walletAddress || '').toLowerCase();
  const drafts = Array.isArray(payload?.drafts) ? payload.drafts : [];
  if (isMarketplaceDbEnabled()) {
    try {
      await ensureMarketplaceDbSchema();
      const pool = getMarketplaceDbPool();
      const client = await pool.connect();
      const updatedAtIso = new Date().toISOString();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM soul_marketplace_drafts WHERE wallet_address = $1', [wallet]);
        for (const draft of drafts) {
          const createdAtIso = draft?.created_at ? new Date(draft.created_at).toISOString() : updatedAtIso;
          const draftUpdatedAtIso = draft?.updated_at ? new Date(draft.updated_at).toISOString() : updatedAtIso;
          const publishedAtIso = draft?.published_at ? new Date(draft.published_at).toISOString() : null;
          await client.query(
            `
              INSERT INTO soul_marketplace_drafts (
                wallet_address, draft_id, status, moderation, normalized, created_at, updated_at, published_at
              ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::timestamptz, $7::timestamptz, $8::timestamptz)
            `,
            [
              wallet,
              String(draft?.draft_id || ''),
              String(draft?.status || 'draft'),
              JSON.stringify(draft?.moderation || null),
              JSON.stringify(draft?.normalized || {}),
              createdAtIso,
              draftUpdatedAtIso,
              publishedAtIso
            ]
          );
        }
        await client.query('COMMIT');
        return {
          wallet,
          updated_at: updatedAtIso,
          drafts
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (_) {
      markDbFailure();
    }
  }

  await ensureDraftStore();
  const filePath = walletFilePath(walletAddress);
  const next = {
    wallet,
    updated_at: new Date().toISOString(),
    drafts
  };
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

async function appendReviewAudit(entry) {
  if (isMarketplaceDbEnabled()) {
    try {
      await ensureMarketplaceDbSchema();
      const pool = getMarketplaceDbPool();
      await pool.query(
        `
          INSERT INTO soul_marketplace_audit (
            at, event, wallet_address, draft_id, actor, decision, status_before, status_after, notes, payload
          ) VALUES ($1::timestamptz, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
        `,
        [
          entry?.at ? new Date(entry.at).toISOString() : new Date().toISOString(),
          String(entry?.event || 'unknown'),
          String(entry?.wallet || '').toLowerCase(),
          entry?.draft_id ? String(entry.draft_id) : null,
          entry?.actor ? String(entry.actor) : null,
          entry?.decision ? String(entry.decision) : null,
          entry?.status_before ? String(entry.status_before) : null,
          entry?.status_after ? String(entry.status_after) : null,
          entry?.notes ? String(entry.notes) : null,
          JSON.stringify(entry || {})
        ]
      );
      return;
    } catch (error) {
      // Audit logging should never downgrade primary catalog reads/writes to non-durable fallback in production.
      if (isStrictDatabaseMode()) {
        console.error('appendReviewAudit db write failed:', error);
        return;
      }
      markDbFailure();
    }
  }

  await ensureDraftStore();
  const filePath = path.join(getMarketplaceDraftsDir(), REVIEW_AUDIT_FILE);
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function derivePreview(markdown) {
  const clean = String(markdown || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))[0];
  return clean || 'Published creator soul.';
}

function sharePathForSoul(soulId) {
  return `/soul.html?id=${encodeURIComponent(String(soulId || ''))}`;
}

function normalizeVisibility(value) {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'hidden' ? 'hidden' : 'public';
}

async function loadPublishedCatalog() {
  if (isMarketplaceDbEnabled()) {
    try {
      await ensureMarketplaceDbSchema();
      const pool = getMarketplaceDbPool();
      const { rows } = await pool.query(
        `
          SELECT entry
          FROM soul_catalog_entries
          ORDER BY updated_at DESC, id ASC
        `
      );
      const entries = rows
        .map((row) => row.entry)
        .filter((entry) => entry && typeof entry === 'object' && typeof entry.id === 'string');
      return { schema_version: 'published-catalog-v1', entries };
    } catch (error) {
      if (isStrictDatabaseMode()) throw error;
      markDbFailure();
    }
  }

  await ensureDraftStore();
  const filePath = path.join(getMarketplaceDraftsDir(), PUBLISHED_CATALOG_FILE);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      return { schema_version: 'published-catalog-v1', entries: [] };
    }
    return parsed;
  } catch (_) {
    return { schema_version: 'published-catalog-v1', entries: [] };
  }
}

async function savePublishedCatalog(payload) {
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  if (isMarketplaceDbEnabled()) {
    try {
      await ensureMarketplaceDbSchema();
      const pool = getMarketplaceDbPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM soul_catalog_entries');
        for (const entry of entries) {
          if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') continue;
          await client.query(
            `
              INSERT INTO soul_catalog_entries (id, entry, updated_at)
              VALUES ($1, $2::jsonb, NOW())
            `,
            [entry.id, JSON.stringify(entry)]
          );
        }
        await client.query('COMMIT');
        return {
          schema_version: 'published-catalog-v1',
          updated_at: new Date().toISOString(),
          entries
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (isStrictDatabaseMode()) throw error;
      markDbFailure();
    }
  }

  await ensureDraftStore();
  const filePath = path.join(getMarketplaceDraftsDir(), PUBLISHED_CATALOG_FILE);
  const normalized = {
    schema_version: 'published-catalog-v1',
    updated_at: new Date().toISOString(),
    entries
  };
  await fs.writeFile(filePath, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  return normalized;
}

async function upsertPublishedCatalogEntry({ walletAddress, draft }) {
  const listing = draft?.normalized?.listing || {};
  const assets = draft?.normalized?.assets || {};
  const id = asString(listing.soul_id);
  if (!id) return;

  const catalog = await loadPublishedCatalog();
  const existingEntry = catalog.entries.find((entry) => entry?.id === id) || null;
  const nextEntry = {
    id,
    name: asString(listing.name),
    description: asString(listing.description),
    longDescription: asString(listing.long_description),
    icon: asString(listing.icon) || 'SS',
    category: asString(listing.category),
    tags: Array.isArray(listing.tags) ? listing.tags : [],
    priceMicroUsdc: asString(listing.price_micro_usdc),
    priceDisplay: `$${(Number(listing.price_usdc) || 0).toFixed(2)}`,
    provenance: {
      type: asString(listing.soul_type) || 'hybrid',
      raised_by: `Creator ${String(walletAddress || '').toLowerCase()}`,
      days_nurtured: 0
    },
    compatibility: { runtimes: ['OpenClaw', 'ElizaOS', 'Olas'], min_memory: '8MB', min_context: 4000 },
    preview: derivePreview(assets.soul_markdown),
    sourceLabel: assets.source_label || null,
    sourceUrl: assets.source_url || null,
    contentInline: assets.soul_markdown,
    sellerAddress: asString(listing.seller_address).toLowerCase(),
    publishedBy: String(walletAddress || '').toLowerCase(),
    publishedAt: draft?.published_at || new Date().toISOString(),
    draftId: draft?.draft_id,
    sharePath: sharePathForSoul(id),
    visibility: normalizeVisibility(existingEntry?.visibility),
    hiddenAt: existingEntry?.hiddenAt || null,
    hiddenBy: existingEntry?.hiddenBy || null,
    hiddenReason: existingEntry?.hiddenReason || null
  };

  if (isMarketplaceDbEnabled()) {
    try {
      await ensureMarketplaceDbSchema();
      const pool = getMarketplaceDbPool();
      await pool.query(
        `
          INSERT INTO soul_catalog_entries (id, entry, updated_at)
          VALUES ($1, $2::jsonb, NOW())
          ON CONFLICT (id)
          DO UPDATE SET entry = EXCLUDED.entry, updated_at = NOW()
        `,
        [id, JSON.stringify(nextEntry)]
      );
      return;
    } catch (error) {
      if (isStrictDatabaseMode()) throw error;
      markDbFailure();
    }
  }

  const idx = catalog.entries.findIndex((entry) => entry?.id === id);
  if (idx >= 0) catalog.entries[idx] = nextEntry;
  else catalog.entries.push(nextEntry);
  await savePublishedCatalog(catalog);
}

async function loadAllWalletDraftStores() {
  if (isMarketplaceDbEnabled()) {
    try {
      await ensureMarketplaceDbSchema();
      const pool = getMarketplaceDbPool();
      const { rows } = await pool.query(`
        SELECT wallet_address, draft_id, status, moderation, normalized, created_at, updated_at, published_at
        FROM soul_marketplace_drafts
        ORDER BY wallet_address ASC, updated_at DESC
      `);
      const storesByWallet = new Map();
      for (const row of rows) {
        const wallet = String(row.wallet_address || '').toLowerCase();
        if (!storesByWallet.has(wallet)) {
          storesByWallet.set(wallet, { wallet, drafts: [] });
        }
        storesByWallet.get(wallet).drafts.push({
          draft_id: row.draft_id,
          status: row.status || 'draft',
          moderation: row.moderation || null,
          normalized: row.normalized || {},
          created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
          updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
          published_at: row.published_at ? new Date(row.published_at).toISOString() : null
        });
      }
      return [...storesByWallet.values()];
    } catch (_) {
      markDbFailure();
    }
  }

  await ensureDraftStore();
  const dir = getMarketplaceDraftsDir();
  const entries = await fs.readdir(dir);
  const files = entries.filter((name) => name.endsWith('.json') && name !== REVIEW_AUDIT_FILE);
  const stores = [];
  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(dir, file), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.drafts)) {
        stores.push(parsed);
      }
    } catch (_) {}
  }
  return stores;
}

export async function listPublishedCatalogEntries() {
  return listPublishedCatalogEntriesFiltered();
}

async function listPublishedCatalogEntriesFiltered({ includeHidden = false, publishedBy = null } = {}) {
  const catalog = await loadPublishedCatalog();
  const rows = Array.isArray(catalog?.entries) ? catalog.entries : [];
  const creator = publishedBy ? String(publishedBy).toLowerCase() : '';
  return rows.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.id !== 'string' || !entry.id) return false;
    const visibility = normalizeVisibility(entry.visibility);
    if (!includeHidden && visibility === 'hidden') return false;
    if (creator && String(entry.publishedBy || '').toLowerCase() !== creator) return false;
    return true;
  });
}

export async function listPublishedCatalogEntriesPublic() {
  return listPublishedCatalogEntriesFiltered({ includeHidden: false });
}

export async function listPublishedCatalogEntriesByCreator(walletAddress) {
  return listPublishedCatalogEntriesFiltered({
    includeHidden: true,
    publishedBy: String(walletAddress || '').toLowerCase()
  });
}

export async function listPublishedCatalogEntriesForModeration() {
  return listPublishedCatalogEntriesFiltered({ includeHidden: true });
}

export function getMarketplaceDraftTemplate() {
  return {
    schema_version: 'marketplace-publish-v1',
    name: 'Example Soul',
    description: 'Short summary buyers see before purchase.',
    price_usdc: 0.49,
    soul_markdown: `# SOUL

## Core Principles
- Define your non-negotiable values and decision rules.

## Operating Pattern
- Describe how this soul plans, executes, and iterates.

## Boundaries
- Clarify what this soul should not do and when to refuse.

## Communication
- Specify tone, brevity, formatting, and interaction style.

## Continuity
- Define memory expectations, handoff behavior, and long-term consistency rules.`,
    notes: {
      auto_fields: [
        'soul_id (derived from name)',
        'seller_address (set to connected creator wallet)',
        'category, soul_type, icon, tags',
        'creator_royalty_bps + platform_fee_bps',
        'share_path'
      ],
      publish_mode: 'immediate',
      platform_fee_bps: normalizePlatformFeeBps()
    }
  };
}

export function buildCreatorAuthMessage({ wallet, action, timestamp }) {
  return ['SoulStarter Creator Authentication', `address:${String(wallet || '').toLowerCase()}`, `action:${action}`, `timestamp:${timestamp}`].join(
    '\n'
  );
}

export function verifyCreatorAuth({ wallet, timestamp, signature, action }) {
  if (!wallet || !timestamp || !signature || !action) {
    return { ok: false, error: 'Missing creator auth fields' };
  }
  if (!validateEthAddress(wallet)) {
    return { ok: false, error: 'Invalid wallet address' };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, error: 'Invalid auth timestamp' };
  }
  if (Math.abs(Date.now() - ts) > CREATOR_AUTH_DRIFT_MS) {
    return { ok: false, error: 'Authentication message expired' };
  }

  try {
    const typed = buildTypedAuthPayload({
      domainName: 'SoulStarter Creator Authentication',
      primaryType: 'SoulStarterCreatorAuth',
      wallet,
      action,
      timestamp: ts
    });
    const recoveredTyped = ethers.verifyTypedData(typed.domain, typed.types, typed.message, signature);
    if (typeof recoveredTyped === 'string' && recoveredTyped.toLowerCase() === String(wallet).toLowerCase()) {
      return { ok: true, wallet: String(wallet).toLowerCase(), matched_variant: 'eip712' };
    }
  } catch (_) {}

  const candidates = buildCreatorAuthMessageCandidates({ wallet, action, timestamp: ts });
  for (const candidate of candidates) {
    try {
      const recovered = ethers.verifyMessage(candidate.message, signature);
      if (typeof recovered === 'string' && recovered.toLowerCase() === String(wallet).toLowerCase()) {
        return { ok: true, wallet: String(wallet).toLowerCase(), matched_variant: candidate.variant };
      }
    } catch (_) {}
  }

  return {
    ok: false,
    error: 'Signature does not match wallet address',
    auth_message_template: buildCreatorAuthMessage({
      wallet: '0x<your-wallet>',
      action,
      timestamp: Date.now()
    })
  };
}

export function validateMarketplaceDraft(input, options = {}) {
  const errors = [];
  const warnings = [];
  const prepared = buildDraftInput(input, options);
  const listing = prepared.listing || {};
  const assets = prepared.assets || {};

  const soulId = asString(listing.soul_id).toLowerCase();
  const name = asString(listing.name);
  const description = asString(listing.description);
  const longDescription = asString(listing.long_description);
  const category = asString(listing.category).toLowerCase();
  const soulType = asString(listing.soul_type).toLowerCase();
  const icon = asString(listing.icon);
  const tags = normalizeTags(listing.tags);
  const sellerAddress = asString(listing.seller_address);
  const sourceUrl = asString(assets.source_url);
  const sourceLabel = asString(assets.source_label);
  const soulMarkdown = typeof assets.soul_markdown === 'string' ? assets.soul_markdown : '';

  if (!validateSoulId(soulId)) errors.push('listing.soul_id must be kebab-case alphanumeric (example-soul-v1).');
  if (name.length < 3 || name.length > 80) errors.push('listing.name must be between 3 and 80 characters.');
  if (description.length < 12 || description.length > 240)
    errors.push('listing.description must be between 12 and 240 characters.');
  if (longDescription.length < 12 || longDescription.length > 2000)
    errors.push('listing.long_description must be between 12 and 2000 characters.');
  if (!category) errors.push('listing.category is required.');
  if (!SOUL_TYPES.has(soulType)) errors.push('listing.soul_type must be synthetic, organic, or hybrid.');
  if (!validateEthAddress(sellerAddress)) errors.push('listing.seller_address must be a valid EVM address.');
  if (!soulMarkdown.trim()) errors.push('assets.soul_markdown is required.');
  if (Buffer.byteLength(soulMarkdown, 'utf8') > MAX_SOUL_MD_BYTES)
    errors.push(`assets.soul_markdown exceeds ${MAX_SOUL_MD_BYTES} bytes.`);

  const priceMicroUsdc = normalizeUsdPriceToMicroUsdc(Number(listing.price_usdc));
  if (!priceMicroUsdc) errors.push('listing.price_usdc must be a positive number.');
  if (tags.length === 0) warnings.push('listing.tags is empty; discovery quality may be poor.');
  if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) errors.push('assets.source_url must be http(s) if set.');
  if (sourceLabel && !sourceUrl) warnings.push('assets.source_label provided without assets.source_url.');

  const creatorRoyaltyBps = Number.isFinite(Number(listing.creator_royalty_bps)) ? Number(listing.creator_royalty_bps) : 0;
  const platformFeeBps = Number.isFinite(Number(listing.platform_fee_bps))
    ? Number(listing.platform_fee_bps)
    : normalizePlatformFeeBps();
  if (creatorRoyaltyBps < 0 || creatorRoyaltyBps > 10000) errors.push('listing.creator_royalty_bps must be 0..10000.');
  if (platformFeeBps < 0 || platformFeeBps > 10000) errors.push('listing.platform_fee_bps must be 0..10000.');
  if (creatorRoyaltyBps + platformFeeBps !== 10000) {
    errors.push('listing.creator_royalty_bps + listing.platform_fee_bps must equal 10000.');
  }

  const normalized = {
    schema_version: 'marketplace-draft-v1',
    listing: {
      soul_id: soulId,
      name,
      description,
      long_description: longDescription,
      category,
      soul_type: soulType,
      icon: icon || 'spark',
      tags,
      price_usdc: Number(listing.price_usdc),
      price_micro_usdc: priceMicroUsdc,
      seller_address: sellerAddress.toLowerCase(),
      creator_royalty_bps: creatorRoyaltyBps,
      platform_fee_bps: platformFeeBps
    },
    assets: {
      soul_markdown: soulMarkdown,
      source_url: sourceUrl || null,
      source_label: sourceLabel || null
    }
  };

  const digest = crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  const draftId = `draft_${digest.slice(0, 16)}`;

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    draft_id: draftId,
    normalized
  };
}

export async function upsertCreatorDraft({ walletAddress, normalizedDraft, draftId }) {
  const wallet = String(walletAddress || '').toLowerCase();
  const store = await loadWalletDraftFile(wallet);
  const now = new Date().toISOString();
  const idx = store.drafts.findIndex((item) => item?.draft_id === draftId);

  const record = {
    draft_id: draftId,
    created_at: idx >= 0 ? store.drafts[idx].created_at : now,
    updated_at: now,
    status: 'draft',
    moderation: idx >= 0 ? store.drafts[idx].moderation || null : null,
    normalized: normalizedDraft
  };

  if (idx >= 0) store.drafts[idx] = record;
  else store.drafts.push(record);

  await saveWalletDraftFile(wallet, store);
  return record;
}

export async function listCreatorDrafts(walletAddress) {
  const wallet = String(walletAddress || '').toLowerCase();
  const store = await loadWalletDraftFile(wallet);
  return store.drafts
    .slice()
    .sort((a, b) => new Date(b?.updated_at || 0).getTime() - new Date(a?.updated_at || 0).getTime())
    .map((draft) => ({
      draft_id: draft.draft_id,
      status: draft.status || 'draft',
      moderation: draft.moderation || null,
      created_at: draft.created_at,
      updated_at: draft.updated_at,
      soul_id: draft.normalized?.listing?.soul_id || null,
      name: draft.normalized?.listing?.name || null,
      price_micro_usdc: draft.normalized?.listing?.price_micro_usdc || null
    }));
}

export async function getCreatorDraft(walletAddress, draftId) {
  const wallet = String(walletAddress || '').toLowerCase();
  const store = await loadWalletDraftFile(wallet);
  return store.drafts.find((item) => item?.draft_id === draftId) || null;
}

export async function submitCreatorDraftForReview({ walletAddress, draftId }) {
  const wallet = String(walletAddress || '').toLowerCase();
  const store = await loadWalletDraftFile(wallet);
  const idx = store.drafts.findIndex((item) => item?.draft_id === draftId);
  if (idx < 0) return { ok: false, error: 'Draft not found' };

  const existing = store.drafts[idx];
  const currentStatus = String(existing?.status || 'draft');
  if (currentStatus === 'submitted_for_review') {
    return { ok: false, error: 'Draft already submitted for review', draft: existing };
  }
  if (currentStatus === 'published') {
    return { ok: false, error: 'Draft already published', draft: existing };
  }

  const now = new Date().toISOString();
  const next = {
    ...existing,
    updated_at: now,
    status: 'submitted_for_review',
    moderation: {
      state: 'pending',
      submitted_at: now,
      reviewed_at: null,
      reviewer: null,
      notes: null
    }
  };
  store.drafts[idx] = next;
  await saveWalletDraftFile(wallet, store);
  await appendReviewAudit({
    at: now,
    event: 'submit_for_review',
    wallet,
    draft_id: draftId,
    actor: wallet,
    status_before: currentStatus,
    status_after: next.status
  });
  return { ok: true, draft: next };
}

function parseModeratorWalletEnv() {
  const fromEnv = [process.env.MODERATOR_WALLETS, process.env.MODERATOR_ALLOWLIST]
    .map((value) => String(value || ''))
    .join(',')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const merged = fromEnv.length > 0 ? fromEnv : DEFAULT_MODERATOR_WALLETS;
  return [...new Set(merged.map((value) => value.toLowerCase()).filter(validateEthAddress))];
}

export function listModeratorWallets() {
  return parseModeratorWalletEnv();
}

function buildModeratorAuthMessageWithNewline({ wallet, action, timestamp, newline }) {
  return ['SoulStarter Moderator Authentication', `address:${wallet}`, `action:${action}`, `timestamp:${timestamp}`].join(
    newline
  );
}

function buildModeratorAuthMessageCandidates({ wallet, action, timestamp }) {
  const raw = asString(wallet);
  const lower = raw.toLowerCase();
  const checksummed = safeChecksumAddress(raw);
  const wallets = [...new Set([lower, checksummed].filter(Boolean))];
  const newlines = ['\n', '\r\n'];
  const messages = [];
  for (const walletVariant of wallets) {
    for (const newline of newlines) {
      messages.push({
        variant: `${walletVariant === lower ? 'lowercase' : 'checksummed'}-${newline === '\n' ? 'lf' : 'crlf'}`,
        message: buildModeratorAuthMessageWithNewline({ wallet: walletVariant, action, timestamp, newline })
      });
    }
  }
  return messages;
}

export function buildModeratorAuthMessage({ wallet, action, timestamp }) {
  return [
    'SoulStarter Moderator Authentication',
    `address:${String(wallet || '').toLowerCase()}`,
    `action:${String(action || '').trim()}`,
    `timestamp:${timestamp}`
  ].join('\n');
}

export function verifyModeratorAuth({ wallet, timestamp, signature, action }) {
  const allowlist = listModeratorWallets();
  if (allowlist.length === 0) {
    return { ok: false, error: 'Server configuration error: moderator allowlist is empty' };
  }
  if (!wallet || !timestamp || !signature || !action) {
    return { ok: false, error: 'Missing moderator auth fields' };
  }
  if (!validateEthAddress(wallet)) {
    return { ok: false, error: 'Invalid wallet address' };
  }

  const normalizedWallet = String(wallet).toLowerCase();
  if (!allowlist.includes(normalizedWallet)) {
    return { ok: false, error: 'Wallet is not an allowed moderator' };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, error: 'Invalid auth timestamp' };
  }
  if (Math.abs(Date.now() - ts) > MODERATOR_AUTH_DRIFT_MS) {
    return { ok: false, error: 'Authentication message expired' };
  }

  try {
    const typed = buildTypedAuthPayload({
      domainName: 'SoulStarter Moderator Authentication',
      primaryType: 'SoulStarterModeratorAuth',
      wallet,
      action,
      timestamp: ts
    });
    const recoveredTyped = ethers.verifyTypedData(typed.domain, typed.types, typed.message, signature);
    if (typeof recoveredTyped === 'string' && recoveredTyped.toLowerCase() === normalizedWallet) {
      return { ok: true, wallet: normalizedWallet, matched_variant: 'eip712' };
    }
  } catch (_) {}

  const candidates = buildModeratorAuthMessageCandidates({ wallet, action, timestamp: ts });
  for (const candidate of candidates) {
    try {
      const recovered = ethers.verifyMessage(candidate.message, signature);
      if (typeof recovered === 'string' && recovered.toLowerCase() === normalizedWallet) {
        return { ok: true, wallet: normalizedWallet, matched_variant: candidate.variant };
      }
    } catch (_) {}
  }

  return {
    ok: false,
    error: 'Signature does not match wallet address',
    auth_message_template: buildModeratorAuthMessage({
      wallet: '0x<your-wallet>',
      action,
      timestamp: Date.now()
    })
  };
}

export async function reviewCreatorDraft({ walletAddress, draftId, decision, reviewer, notes }) {
  const wallet = String(walletAddress || '').toLowerCase();
  const normalizedDecision = String(decision || '').toLowerCase();
  if (normalizedDecision !== 'approve' && normalizedDecision !== 'reject') {
    return { ok: false, error: 'decision must be approve or reject' };
  }

  const store = await loadWalletDraftFile(wallet);
  const idx = store.drafts.findIndex((item) => item?.draft_id === draftId);
  if (idx < 0) return { ok: false, error: 'Draft not found' };

  const existing = store.drafts[idx];
  const currentStatus = String(existing?.status || 'draft');
  if (currentStatus !== 'submitted_for_review') {
    return {
      ok: false,
      error: `Draft is not reviewable from status=${currentStatus}`,
      draft: existing
    };
  }

  const now = new Date().toISOString();
  const nextStatus = normalizedDecision === 'approve' ? 'approved_for_publish' : 'rejected';
  const next = {
    ...existing,
    updated_at: now,
    status: nextStatus,
    moderation: {
      state: normalizedDecision === 'approve' ? 'approved' : 'rejected',
      submitted_at: existing?.moderation?.submitted_at || now,
      reviewed_at: now,
      reviewer: asString(reviewer) || 'admin',
      notes: asString(notes) || null,
      decision: normalizedDecision
    }
  };

  store.drafts[idx] = next;
  await saveWalletDraftFile(wallet, store);
  await appendReviewAudit({
    at: now,
    event: 'review_decision',
    wallet,
    draft_id: draftId,
    actor: next.moderation.reviewer,
    decision: normalizedDecision,
    status_before: currentStatus,
    status_after: next.status,
    notes: next.moderation.notes
  });

  return { ok: true, draft: next };
}

export async function listDraftsByStatus(statuses = []) {
  const allowed = new Set((Array.isArray(statuses) ? statuses : []).map((s) => String(s || '')));
  const stores = await loadAllWalletDraftStores();
  const rows = [];
  for (const store of stores) {
    const wallet = String(store.wallet || '').toLowerCase();
    for (const draft of store.drafts || []) {
      const status = String(draft?.status || 'draft');
      if (allowed.size > 0 && !allowed.has(status)) continue;
      rows.push({
        wallet_address: wallet,
        draft_id: draft.draft_id,
        status,
        moderation: draft.moderation || null,
        updated_at: draft.updated_at || null,
        soul_id: draft.normalized?.listing?.soul_id || null,
        name: draft.normalized?.listing?.name || null
      });
    }
  }
  return rows.sort((a, b) => new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime());
}

export async function publishCreatorDraft({ walletAddress, draftId, reviewer, notes }) {
  const wallet = String(walletAddress || '').toLowerCase();
  const store = await loadWalletDraftFile(wallet);
  const idx = store.drafts.findIndex((item) => item?.draft_id === draftId);
  if (idx < 0) return { ok: false, error: 'Draft not found' };

  const existing = store.drafts[idx];
  const currentStatus = String(existing?.status || 'draft');
  if (currentStatus !== 'approved_for_publish') {
    return { ok: false, error: `Draft is not publishable from status=${currentStatus}`, draft: existing };
  }

  const now = new Date().toISOString();
  const next = {
    ...existing,
    status: 'published',
    updated_at: now,
    published_at: now,
    moderation: {
      ...(existing.moderation || {}),
      state: 'published',
      reviewed_at: now,
      reviewer: asString(reviewer) || existing?.moderation?.reviewer || 'admin',
      notes: asString(notes) || existing?.moderation?.notes || null
    }
  };
  store.drafts[idx] = next;
  await saveWalletDraftFile(wallet, store);
  await upsertPublishedCatalogEntry({ walletAddress: wallet, draft: next });
  await appendReviewAudit({
    at: now,
    event: 'publish',
    wallet,
    draft_id: draftId,
    actor: next.moderation.reviewer,
    status_before: currentStatus,
    status_after: next.status,
    notes: next.moderation.notes
  });

  return { ok: true, draft: next };
}

function summarizePublishedListing(entry) {
  const listing = entry && typeof entry === 'object' ? entry : {};
  const id = asString(listing.id);
  const sharePath = asString(listing.sharePath || sharePathForSoul(id));
  return {
    soul_id: id,
    name: asString(listing.name),
    description: asString(listing.description),
    price_micro_usdc: asString(listing.priceMicroUsdc),
    price_display: asString(listing.priceDisplay),
    seller_address: asString(listing.sellerAddress).toLowerCase(),
    wallet_address: asString(listing.publishedBy).toLowerCase(),
    visibility: normalizeVisibility(listing.visibility),
    hidden_at: listing.hiddenAt || null,
    hidden_by: listing.hiddenBy || null,
    hidden_reason: listing.hiddenReason || null,
    published_at: listing.publishedAt || null,
    share_path: sharePath
  };
}

export async function publishCreatorListingDirect({ walletAddress, payload }) {
  if (process.env.VERCEL && !getMarketplaceDatabaseUrl()) {
    return {
      ok: false,
      code: 'marketplace_persistence_unconfigured',
      errors: [
        'Marketplace publish is unavailable: persistent database is not configured on Vercel. Set MARKETPLACE_DATABASE_URL (or DATABASE_URL/POSTGRES_URL).'
      ],
      warnings: []
    };
  }

  const wallet = String(walletAddress || '').toLowerCase();
  const result = validateMarketplaceDraft(payload, { walletAddress: wallet });
  if (!result.ok) {
    return {
      ok: false,
      code: 'validation_failed',
      errors: result.errors,
      warnings: result.warnings,
      draft_id: result.draft_id
    };
  }

  const now = new Date().toISOString();
  const publishedDraft = {
    draft_id: `pub_${result.draft_id.replace(/^draft_/, '')}`,
    normalized: result.normalized,
    published_at: now
  };
  await upsertPublishedCatalogEntry({ walletAddress: wallet, draft: publishedDraft });
  await appendReviewAudit({
    at: now,
    event: 'publish_direct',
    wallet,
    draft_id: publishedDraft.draft_id,
    actor: wallet,
    status_before: 'none',
    status_after: 'published',
    notes: 'Immediate publish flow'
  });

  const entries = await listPublishedCatalogEntriesFiltered({
    includeHidden: true,
    publishedBy: wallet
  });
  const entry = entries.find((row) => row?.id === result.normalized.listing.soul_id) || null;
  return {
    ok: true,
    warnings: result.warnings,
    listing: summarizePublishedListing(entry || {}),
    normalized: result.normalized
  };
}

export async function setListingVisibility({ soulId, visibility, moderator, reason }) {
  const id = asString(soulId);
  if (!id) return { ok: false, error: 'Missing soul_id' };
  const mode = normalizeVisibility(visibility);
  if (mode !== 'hidden' && mode !== 'public') {
    return { ok: false, error: 'visibility must be hidden or public' };
  }

  const catalog = await loadPublishedCatalog();
  const idx = catalog.entries.findIndex((entry) => entry?.id === id);
  if (idx < 0) return { ok: false, error: 'Listing not found' };

  const now = new Date().toISOString();
  const actor = asString(moderator).toLowerCase() || 'moderator';
  const previousVisibility = normalizeVisibility(catalog.entries[idx]?.visibility);
  const updated = {
    ...catalog.entries[idx],
    visibility: mode,
    hiddenAt: mode === 'hidden' ? now : null,
    hiddenBy: mode === 'hidden' ? actor : null,
    hiddenReason: mode === 'hidden' ? asString(reason) || null : null
  };
  catalog.entries[idx] = updated;
  await savePublishedCatalog(catalog);
  await appendReviewAudit({
    at: now,
    event: mode === 'hidden' ? 'visibility_hidden' : 'visibility_public',
    wallet: String(updated.publishedBy || '').toLowerCase(),
    draft_id: String(updated.draftId || ''),
    actor,
    status_before: previousVisibility,
    status_after: mode,
    notes: updated.hiddenReason || null,
    soul_id: id
  });

  return {
    ok: true,
    listing: summarizePublishedListing(updated)
  };
}

export async function listPublishedListingSummaries({ includeHidden = false, publishedBy = null } = {}) {
  const entries = await listPublishedCatalogEntriesFiltered({ includeHidden, publishedBy });
  return entries.map((entry) => summarizePublishedListing(entry));
}
