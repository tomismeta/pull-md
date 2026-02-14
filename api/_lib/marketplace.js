import crypto from 'crypto';

const SOUL_TYPES = new Set(['synthetic', 'organic', 'hybrid']);
const MAX_SOUL_MD_BYTES = 64 * 1024;
const MAX_TAGS = 12;

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

export function getMarketplaceDraftTemplate() {
  return {
    schema_version: 'marketplace-draft-v1',
    listing: {
      soul_id: 'example-soul-v1',
      name: 'Example Soul',
      description: 'One-sentence summary for buyers.',
      long_description: 'Longer details about behavior, strengths, and target use cases.',
      category: 'starter',
      soul_type: 'hybrid',
      icon: 'spark',
      tags: ['clear', 'pragmatic', 'tooling'],
      price_usdc: 0.49,
      seller_address: '0x0000000000000000000000000000000000000000',
      creator_royalty_bps: 9900,
      platform_fee_bps: 100
    },
    assets: {
      soul_markdown: '# SOUL\\n\\nYour soul content goes here.',
      source_url: '',
      source_label: ''
    }
  };
}

export function validateMarketplaceDraft(input) {
  const errors = [];
  const warnings = [];

  const listing = input && typeof input.listing === 'object' ? input.listing : {};
  const assets = input && typeof input.assets === 'object' ? input.assets : {};

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

  const priceMicroUsdc = normalizeUsdPriceToMicroUsdc(listing.price_usdc);
  if (!priceMicroUsdc) errors.push('listing.price_usdc must be a positive number.');
  if (tags.length === 0) warnings.push('listing.tags is empty; discovery quality may be poor.');
  if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) errors.push('assets.source_url must be http(s) if set.');
  if (sourceLabel && !sourceUrl) warnings.push('assets.source_label provided without assets.source_url.');

  const creatorRoyaltyBps = Number.isFinite(listing.creator_royalty_bps) ? Number(listing.creator_royalty_bps) : 9900;
  const platformFeeBps = Number.isFinite(listing.platform_fee_bps) ? Number(listing.platform_fee_bps) : 100;
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
