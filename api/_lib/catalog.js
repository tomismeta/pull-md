import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { listPublishedCatalogEntries } from './marketplace.js';

export const SOUL_CATALOG = {
  'meta-starter-v1': {
    id: 'meta-starter-v1',
    name: 'Meta Starter Soul',
    description: 'A clean, adaptable starter soul focused on clarity, reliability, and measured autonomy.',
    longDescription: 'A general-purpose starter framework for agents that need practical decision-making and steady collaboration patterns.',
    icon: 'MS',
    category: 'starter',
    tags: ['starter', 'balanced', 'clear', 'reliable', 'adaptive'],
    priceMicroUsdc: '500000',
    priceDisplay: '$0.50',
    provenance: { type: 'organic', raised_by: 'Human curation', days_nurtured: 14 },
    compatibility: { runtimes: ['OpenClaw', 'ElizaOS', 'Olas'], min_memory: '16MB', min_context: 8000 },
    preview: 'Prefer concrete progress over performative language. Be clear, practical, and accountable for outcomes.',
    contentFile: 'souls/meta-starter-v1.md'
  },
  'sassy-starter-v1': {
    id: 'sassy-starter-v1',
    name: 'Sassy Soul',
    description: 'Opinionated, concise, witty, and unafraid to call out bad ideas with charm.',
    longDescription: 'A high-personality assistant archetype inspired by Peter on X, tuned for direct takes and sharp delivery.',
    icon: 'SA',
    category: 'personality',
    tags: ['sassy', 'opinionated', 'concise', 'witty'],
    priceMicroUsdc: '10000',
    priceDisplay: '$0.01',
    provenance: { type: 'synthetic', raised_by: 'Prompt remix lab', days_nurtured: 9 },
    compatibility: { runtimes: ['OpenClaw', 'ElizaOS', 'Olas'], min_memory: '8MB', min_context: 4000 },
    preview: 'Have a take. Keep it short. No corporate fluff. Be sharp, useful, and human.',
    sourceLabel: 'Peter on X',
    sourceUrl: 'https://x.com/steipete/status/2020704611640705485',
    contentFile: 'souls/sassy-starter-v1.md'
  },
  'pattern-weaver-v1': {
    id: 'pattern-weaver-v1',
    name: 'Pattern Weaver Soul',
    description: 'Sees connections others miss and synthesizes across domains.',
    longDescription: 'A synthesis-first soul optimized for abstraction, transfer learning, and strategic pattern matching.',
    icon: 'PW',
    category: 'knowledge',
    tags: ['synthesis', 'curious', 'connector'],
    priceMicroUsdc: '250000',
    priceDisplay: '$0.25',
    provenance: { type: 'hybrid', raised_by: 'Cross-domain research', days_nurtured: 18 },
    compatibility: { runtimes: ['OpenClaw', 'ElizaOS', 'Olas'], min_memory: '12MB', min_context: 6000 },
    preview: 'The right abstraction compresses ten decisions into one.',
    contentFile: 'souls/pattern-weaver-v1.md'
  },
  'ember-operator-v1': {
    id: 'ember-operator-v1',
    name: 'Ember Operator Soul',
    description: 'Calm under pressure, focused on execution, and strong at running operational loops.',
    longDescription: 'An operations-first soul tuned for checklists, incident response, and clean follow-through.',
    icon: 'EO',
    category: 'operations',
    tags: ['operations', 'runbooks', 'incident-response', 'focused'],
    priceMicroUsdc: '350000',
    priceDisplay: '$0.35',
    provenance: { type: 'synthetic', raised_by: 'Ops simulation harness', days_nurtured: 19 },
    compatibility: { runtimes: ['OpenClaw', 'ElizaOS', 'Olas'], min_memory: '10MB', min_context: 5000 },
    preview: 'Stabilize first, optimize second. Protect reliability before adding complexity.',
    contentFile: 'souls/ember-operator-v1.md'
  },
  'lucid-critic-v1': {
    id: 'lucid-critic-v1',
    name: 'Lucid Critic Soul',
    description: 'Finds weak assumptions early and strengthens plans before execution starts.',
    longDescription: 'A high-signal reviewer soul for risk analysis, design critique, and decision hygiene.',
    icon: 'LC',
    category: 'analysis',
    tags: ['analysis', 'review', 'risk', 'decision-making'],
    priceMicroUsdc: '420000',
    priceDisplay: '$0.42',
    provenance: { type: 'organic', raised_by: 'Human review circles', days_nurtured: 23 },
    compatibility: { runtimes: ['OpenClaw', 'ElizaOS'], min_memory: '12MB', min_context: 7000 },
    preview: 'Name the risk, test the assumption, and tighten the plan before committing resources.',
    contentFile: 'souls/lucid-critic-v1.md'
  },
  'atlas-mentor-v1': {
    id: 'atlas-mentor-v1',
    name: 'Atlas Mentor Soul',
    description: 'Teaches while doing, balancing guidance with practical delivery speed.',
    longDescription: 'A coaching-oriented soul for collaborative builds, onboarding, and knowledge transfer.',
    icon: 'AM',
    category: 'guidance',
    tags: ['mentorship', 'teaching', 'collaboration', 'onboarding'],
    priceMicroUsdc: '680000',
    priceDisplay: '$0.68',
    provenance: { type: 'hybrid', raised_by: 'Pair sessions', days_nurtured: 16 },
    compatibility: { runtimes: ['OpenClaw', 'ElizaOS', 'Olas'], min_memory: '14MB', min_context: 8000 },
    preview: 'Teach through concrete examples, then fade support as confidence grows.',
    contentFile: 'souls/atlas-mentor-v1.md'
  }
};

function includeBundledSouls() {
  return String(process.env.ENABLE_BUNDLED_SOULS || '').trim() === '1';
}

function bundledCatalogValues() {
  return includeBundledSouls() ? Object.values(SOUL_CATALOG) : [];
}

function normalizeAssetType(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

function defaultFileNameForAssetType(assetType) {
  const normalized = normalizeAssetType(assetType);
  const mapping = {
    soul: 'SOUL.md',
    skill: 'SKILL.md',
    playbook: 'PLAYBOOK.md',
    policy: 'POLICY.md',
    prompt: 'PROMPT.md',
    guide: 'GUIDE.md',
    workflow: 'WORKFLOW.md',
    knowledge: 'KNOWLEDGE.md'
  };
  return mapping[normalized] || 'ASSET.md';
}

function normalizeMarkdownFileName(value, fallback) {
  const candidate = String(value || '').trim();
  if (!candidate) return fallback;
  if (candidate.includes('/') || candidate.includes('\\')) return fallback;
  if (!/\.md$/i.test(candidate)) return fallback;
  if (!/^[A-Za-z0-9._-]+$/.test(candidate)) return fallback;
  return candidate;
}

function normalizeCatalogAsset(asset) {
  const source = asset && typeof asset === 'object' ? asset : {};
  const assetType = normalizeAssetType(source.assetType || source.asset_type) || 'soul';
  const fileName = normalizeMarkdownFileName(
    source.fileName || source.file_name,
    defaultFileNameForAssetType(assetType)
  );
  return {
    ...source,
    assetType,
    fileName
  };
}

function getMarketplaceDraftsDir() {
  const configured = String(process.env.MARKETPLACE_DRAFTS_DIR || '').trim();
  if (configured) return configured;
  if (process.env.VERCEL) {
    return '/tmp/soulstarter-marketplace-drafts';
  }
  return path.join(process.cwd(), '.marketplace-drafts');
}

function hasMarketplaceDatabaseConfigured() {
  const keys = ['MARKETPLACE_DATABASE_URL', 'DATABASE_URL', 'POSTGRES_URL'];
  return keys.some((key) => Boolean(String(process.env[key] || '').trim()));
}

function isStrictPublishedCatalogMode() {
  return Boolean(process.env.VERCEL) && hasMarketplaceDatabaseConfigured();
}

const PUBLISHED_CATALOG_PATH = path.join(getMarketplaceDraftsDir(), 'published-catalog.json');

function loadPublishedCatalogSync() {
  try {
    const raw = fs.readFileSync(PUBLISHED_CATALOG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.filter((entry) => {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') return false;
      return String(entry.visibility || 'public').toLowerCase() !== 'hidden';
    });
  } catch (_) {
    return [];
  }
}

function mergedCatalogValues() {
  const byId = new Map(bundledCatalogValues().map((item) => [item.id, normalizeCatalogAsset(item)]));
  for (const entry of loadPublishedCatalogSync()) {
    byId.set(entry.id, normalizeCatalogAsset(entry));
  }
  return [...byId.values()];
}

async function mergedCatalogValuesAsync() {
  const byId = new Map(bundledCatalogValues().map((item) => [item.id, normalizeCatalogAsset(item)]));
  let published = [];
  try {
    published = await listPublishedCatalogEntries();
  } catch (error) {
    if (isStrictPublishedCatalogMode()) throw error;
    published = loadPublishedCatalogSync();
  }
  for (const entry of Array.isArray(published) ? published : []) {
    if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
      byId.set(entry.id, normalizeCatalogAsset(entry));
    }
  }
  return [...byId.values()];
}

function toAssetSummary(asset) {
  const sharePath =
    typeof asset.sharePath === 'string' && asset.sharePath.trim()
      ? asset.sharePath
      : `/soul.html?id=${encodeURIComponent(asset.id)}`;
  const assetType = normalizeAssetType(asset.assetType || asset.asset_type) || 'soul';
  const fileName = normalizeMarkdownFileName(
    asset.fileName || asset.file_name,
    defaultFileNameForAssetType(assetType)
  );
  return {
    id: asset.id,
    asset_id: asset.id,
    soul_id: asset.id,
    asset_type: assetType,
    file_name: fileName,
    name: asset.name,
    description: asset.description,
    icon: asset.icon,
    category: asset.category,
    tags: asset.tags,
    price: {
      amount: (Number(asset.priceMicroUsdc) / 1_000_000).toFixed(2),
      currency: 'USDC',
      network: 'Base',
      display: `${asset.priceDisplay} USDC`
    },
    provenance: asset.provenance,
    compatibility: asset.compatibility,
    preview: { available: true, excerpt: asset.preview },
    source_label: asset.sourceLabel || null,
    source_url: asset.sourceUrl || null,
    share_path: sharePath,
    purchase_endpoint: `/api/assets/${asset.id}/download`,
    purchase_endpoint_legacy: `/api/souls/${asset.id}/download`,
    payment_protocol: 'x402',
    delivery: {
      mime_type: 'text/markdown',
      file_name: fileName
    }
  };
}

export function listAssets() {
  return mergedCatalogValues().map((asset) => toAssetSummary(asset));
}

export function listSouls() {
  return listAssets().filter((asset) => String(asset?.asset_type || '').toLowerCase() === 'soul');
}

export function getAsset(id) {
  if (includeBundledSouls() && SOUL_CATALOG[id]) return SOUL_CATALOG[id];
  const published = loadPublishedCatalogSync().find((entry) => entry.id === id);
  return published ? normalizeCatalogAsset(published) : null;
}

export function getSoul(id) {
  return getAsset(id);
}

export function assetIds() {
  return mergedCatalogValues().map((asset) => asset.id);
}

export function soulIds() {
  return listSouls().map((asset) => asset.id);
}

export async function listAssetsResolved() {
  const assets = await mergedCatalogValuesAsync();
  return assets.map((asset) => toAssetSummary(asset));
}

export async function listSoulsResolved() {
  const assets = await listAssetsResolved();
  return assets.filter((asset) => String(asset?.asset_type || '').toLowerCase() === 'soul');
}

export async function getAssetResolved(id) {
  if (includeBundledSouls() && SOUL_CATALOG[id]) return SOUL_CATALOG[id];
  const assets = await mergedCatalogValuesAsync();
  const match = assets.find((entry) => entry.id === id) || null;
  return match ? normalizeCatalogAsset(match) : null;
}

export async function getSoulResolved(id) {
  return getAssetResolved(id);
}

export async function assetIdsResolved() {
  const assets = await mergedCatalogValuesAsync();
  return assets.map((asset) => asset.id);
}

export async function soulIdsResolved() {
  const assets = await listSoulsResolved();
  return assets.map((asset) => asset.id);
}

export async function loadAssetContent(id, options = {}) {
  const asset = options?.asset || options?.soul || (await getAssetResolved(id)) || getAsset(id);
  if (!asset) return null;

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [];
  if (typeof asset.contentFile === 'string' && asset.contentFile.trim()) {
    candidates.push(path.join(process.cwd(), asset.contentFile));
    candidates.push(path.resolve(moduleDir, '../../', asset.contentFile));
  }

  for (const diskPath of candidates) {
    try {
      return await fsPromises.readFile(diskPath, 'utf-8');
    } catch (_) {
      continue;
    }
  }

  if (typeof asset.contentInline === 'string' && asset.contentInline.trim()) {
    return asset.contentInline;
  }

  const normalizedId = String(id || '').replace(/-/g, '_').toUpperCase();
  return process.env[`ASSET_${normalizedId}`] || process.env[`SOUL_${normalizedId}`] || null;
}

export async function loadSoulContent(id, options = {}) {
  return loadAssetContent(id, options);
}
