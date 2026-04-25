import { promises as fs } from 'fs';
import path from 'path';

import { assetIdFromRequest, assetDetailPath } from './_lib/asset_paths.js';
import { defaultFileNameForAssetType, normalizeAssetType } from './_lib/asset_metadata.js';
import { setDiscoveryHeaders } from './_lib/discovery.js';
import { resolveAssetDetails } from './_lib/services/assets.js';
import { resolveSiteContext } from './_lib/site_url.js';

const ASSET_TEMPLATE_PATH = path.join(process.cwd(), 'public', 'asset.html');
let assetTemplatePromise = null;

function loadAssetTemplate() {
  if (!assetTemplatePromise) {
    assetTemplatePromise = fs.readFile(ASSET_TEMPLATE_PATH, 'utf8');
  }
  return assetTemplatePromise;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function shortAddress(value) {
  const normalized = String(value || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) return '';
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function assetTypeLabel(value) {
  const normalized = normalizeAssetType(value);
  if (!normalized) return 'ASSET';
  return normalized.toUpperCase();
}

function renderTagHtml(tags = []) {
  const list = Array.isArray(tags) ? tags.filter(Boolean).slice(0, 6) : [];
  if (!list.length) return '<span class="tag">untagged</span>';
  return list.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
}

function buildPageModel({ baseUrl, assetId, asset, summary, missing = false }) {
  const normalizedSummary = summary && typeof summary === 'object' ? summary : {};
  const normalizedAsset = asset && typeof asset === 'object' ? asset : {};
  const resolvedAssetType = normalizeAssetType(
    normalizedSummary.asset_type || normalizedAsset.asset_type || normalizedAsset.assetType || 'asset'
  );
  const fileName =
    String(normalizedSummary.delivery?.file_name || normalizedSummary.file_name || normalizedAsset.file_name || '')
      .trim() || defaultFileNameForAssetType(resolvedAssetType);
  const canonicalPath = assetDetailPath(assetId);
  const canonicalUrl = `${baseUrl}${canonicalPath}`;
  const name = missing
    ? 'Asset Unavailable'
    : String(normalizedSummary.name || normalizedAsset.name || assetId || 'Asset').trim() || 'Asset';
  const description = missing
    ? 'This markdown asset could not be found.'
    : String(normalizedSummary.description || normalizedAsset.description || 'Markdown asset listing details.').trim();
  const preview = missing
    ? 'This listing is unavailable.'
    : String(normalizedSummary.preview?.excerpt || normalizedAsset.preview?.excerpt || description).trim();
  const priceValue = missing
    ? '$0.00'
    : String(normalizedSummary.price?.display || '$0.00').replace(/\s*USDC$/i, '').trim() || '$0.00';
  const seller = shortAddress(
    normalizedSummary.seller_address || normalizedAsset.seller_address || normalizedSummary.wallet_address || ''
  );
  const lineage = missing
    ? 'Published listing unavailable'
    : seller
      ? `Creator ${seller}`
      : String(normalizedSummary.provenance?.raised_by || normalizedAsset.provenance?.raised_by || 'Creator listing');
  const purchaseNote = missing
    ? 'This listing is unavailable.'
    : seller
      ? `Paid access via x402. Settlement recipient: ${seller}.`
      : 'Paid access via x402. Delivered instantly after settlement.';

  return {
    title: `${name} — PULL.md`,
    description,
    canonicalUrl,
    socialImageUrl: `${baseUrl}/graphics/pullmd-social-card.png`,
    assetType: resolvedAssetType || 'asset',
    assetTypeLabel: assetTypeLabel(resolvedAssetType),
    lineage,
    name,
    preview,
    priceValue,
    fileName,
    purchaseNote,
    tagsHtml: renderTagHtml(normalizedSummary.tags || normalizedAsset.tags),
    assetId: String(assetId || '').trim(),
    purchaseButtonLabel: missing ? 'Unavailable' : 'Purchase Asset'
  };
}

function renderAssetHtml(template, model) {
  return template
    .replaceAll('__PULLMD_META_TITLE__', escapeHtml(model.title))
    .replaceAll('__PULLMD_META_DESCRIPTION__', escapeHtml(model.description))
    .replaceAll('__PULLMD_CANONICAL_URL__', escapeHtml(model.canonicalUrl))
    .replaceAll('__PULLMD_SOCIAL_IMAGE_URL__', escapeHtml(model.socialImageUrl))
    .replaceAll('__PULLMD_ASSET_TYPE_CLASS__', escapeHtml(model.assetType))
    .replaceAll('__PULLMD_ASSET_TYPE_LABEL__', escapeHtml(model.assetTypeLabel))
    .replaceAll('__PULLMD_ASSET_LINEAGE__', escapeHtml(model.lineage))
    .replaceAll('__PULLMD_ASSET_NAME__', escapeHtml(model.name))
    .replaceAll('__PULLMD_ASSET_DESCRIPTION__', escapeHtml(model.description))
    .replaceAll('__PULLMD_ASSET_TAGS__', model.tagsHtml)
    .replaceAll('__PULLMD_ASSET_FILENAME__', escapeHtml(model.fileName))
    .replaceAll('__PULLMD_ASSET_PREVIEW__', escapeHtml(model.preview))
    .replaceAll('__PULLMD_ASSET_PRICE__', escapeHtml(model.priceValue))
    .replaceAll('__PULLMD_ASSET_PURCHASE_NOTE__', escapeHtml(model.purchaseNote))
    .replaceAll('__PULLMD_ASSET_ID__', escapeHtml(model.assetId))
    .replaceAll('__PULLMD_ASSET_BUTTON_LABEL__', escapeHtml(model.purchaseButtonLabel));
}

export default async function handler(req, res) {
  setDiscoveryHeaders(res, req);
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(200).end();
  }

  if (!['GET', 'HEAD'].includes(method)) {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400');

  const { baseUrl } = resolveSiteContext(req.headers || {});
  const assetId = assetIdFromRequest(req);

  try {
    const template = await loadAssetTemplate();
    if (!assetId) {
      const html = renderAssetHtml(template, buildPageModel({ baseUrl, assetId: '', missing: true }));
      return method === 'HEAD' ? res.status(404).end() : res.status(404).send(html);
    }

    const details = await resolveAssetDetails(assetId);
    const html = renderAssetHtml(
      template,
      buildPageModel({
        baseUrl,
        assetId,
        asset: details.asset,
        summary: details.summary
      })
    );
    return method === 'HEAD' ? res.status(200).end() : res.status(200).send(html);
  } catch (error) {
    const template = await loadAssetTemplate();
    const html = renderAssetHtml(template, buildPageModel({ baseUrl, assetId, missing: true }));
    const status = Number(error?.status || 404);
    return method === 'HEAD' ? res.status(status).end() : res.status(status).send(html);
  }
}
