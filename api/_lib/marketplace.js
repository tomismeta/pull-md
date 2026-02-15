import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { ethers } from 'ethers';

const SOUL_TYPES = new Set(['synthetic', 'organic', 'hybrid']);
const MAX_SOUL_MD_BYTES = 64 * 1024;
const MAX_TAGS = 12;
const CREATOR_AUTH_DRIFT_MS = 5 * 60 * 1000;
const MODERATOR_AUTH_DRIFT_MS = 5 * 60 * 1000;
const REVIEW_AUDIT_FILE = 'review-audit.jsonl';
const PUBLISHED_CATALOG_FILE = 'published-catalog.json';
const DEFAULT_MODERATOR_WALLETS = ['0x7F46aCB709cd8DF5879F84915CA431fB740989E4'];
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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
  return process.env.MARKETPLACE_DRAFTS_DIR || path.join(process.cwd(), '.marketplace-drafts');
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
  await fs.mkdir(getMarketplaceDraftsDir(), { recursive: true });
}

async function loadWalletDraftFile(walletAddress) {
  await ensureDraftStore();
  const filePath = walletFilePath(walletAddress);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.drafts)) {
      return { wallet: String(walletAddress).toLowerCase(), drafts: [] };
    }
    return parsed;
  } catch (_) {
    return { wallet: String(walletAddress).toLowerCase(), drafts: [] };
  }
}

async function saveWalletDraftFile(walletAddress, payload) {
  await ensureDraftStore();
  const filePath = walletFilePath(walletAddress);
  const next = {
    wallet: String(walletAddress).toLowerCase(),
    updated_at: new Date().toISOString(),
    drafts: Array.isArray(payload?.drafts) ? payload.drafts : []
  };
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

async function appendReviewAudit(entry) {
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

async function loadPublishedCatalog() {
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
  await ensureDraftStore();
  const filePath = path.join(getMarketplaceDraftsDir(), PUBLISHED_CATALOG_FILE);
  const normalized = {
    schema_version: 'published-catalog-v1',
    updated_at: new Date().toISOString(),
    entries: Array.isArray(payload?.entries) ? payload.entries : []
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
    draftId: draft?.draft_id
  };

  const idx = catalog.entries.findIndex((entry) => entry?.id === id);
  if (idx >= 0) catalog.entries[idx] = nextEntry;
  else catalog.entries.push(nextEntry);
  await savePublishedCatalog(catalog);
}

async function loadAllWalletDraftStores() {
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

export function getMarketplaceDraftTemplate() {
  return {
    schema_version: 'marketplace-draft-v1',
    name: 'Example Soul',
    description: 'One-sentence summary for buyers.',
    price_usdc: 0.49,
    soul_markdown: '# SOUL\\n\\nYour soul content goes here.',
    notes: {
      auto_fields: [
        'soul_id (derived from name)',
        'seller_address (set to connected creator wallet on save)',
        'category, soul_type, icon, tags',
        'creator_royalty_bps + platform_fee_bps'
      ],
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
  if (longDescription.length < 24 || longDescription.length > 2000)
    errors.push('listing.long_description must be between 24 and 2000 characters.');
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
