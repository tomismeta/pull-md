export function assetDetailPath(assetId) {
  return `/assets/${encodeURIComponent(String(assetId || '').trim())}`;
}

export function legacyAssetDetailPath(assetId) {
  return `/asset.html?id=${encodeURIComponent(String(assetId || '').trim())}`;
}

function assetIdFromLegacySharePath(raw) {
  const match = String(raw || '').match(/[?&]id=([^&]+)/i);
  if (!match?.[1]) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch (_) {
    return match[1];
  }
}

export function canonicalAssetSharePath(value, assetId) {
  const fallback = assetDetailPath(assetId);
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (/^\/assets\/[^/?#]+$/i.test(raw)) return raw;
  if (/^\/(?:asset|soul)\.html\?/i.test(raw)) {
    return assetDetailPath(assetIdFromLegacySharePath(raw) || assetId);
  }
  return raw.startsWith('/') ? raw : fallback;
}

export function assetIdFromRequest(req = {}) {
  const pathId = String(req.query?.id || '').trim();
  if (pathId) return pathId;
  const rawUrl = String(req.url || '').trim();
  const match = rawUrl.match(/[?&]id=([^&]+)/i);
  if (!match?.[1]) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch (_) {
    return match[1];
  }
}
