const DEFAULT_SUPPORTED_MARKDOWN_ASSET_TYPES = [
  'soul',
  'skill',
  'playbook',
  'policy',
  'prompt',
  'guide',
  'workflow',
  'knowledge'
];

const DEFAULT_FILE_NAME_BY_ASSET_TYPE = Object.freeze({
  soul: 'SOUL.md',
  skill: 'SKILL.md',
  playbook: 'PLAYBOOK.md',
  policy: 'POLICY.md',
  prompt: 'PROMPT.md',
  guide: 'GUIDE.md',
  workflow: 'WORKFLOW.md',
  knowledge: 'KNOWLEDGE.md'
});

function normalizeAssetTypeList(rawValue, fallback = DEFAULT_SUPPORTED_MARKDOWN_ASSET_TYPES) {
  const values = String(rawValue || '')
    .split(',')
    .map((item) => normalizeAssetType(item))
    .filter(Boolean);
  return values.length ? [...new Set(values)] : [...fallback];
}

export function normalizeAssetType(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

export function supportedAssetTypes() {
  return normalizeAssetTypeList(process.env.SUPPORTED_MARKDOWN_ASSET_TYPES);
}

export function enabledAssetTypes() {
  return normalizeAssetTypeList(process.env.ENABLED_MARKDOWN_ASSET_TYPES, supportedAssetTypes());
}

export function isSupportedAssetType(value) {
  return supportedAssetTypes().includes(normalizeAssetType(value));
}

export function isEnabledAssetType(value) {
  return enabledAssetTypes().includes(normalizeAssetType(value));
}

export function defaultFileNameForAssetType(assetType) {
  return DEFAULT_FILE_NAME_BY_ASSET_TYPE[normalizeAssetType(assetType)] || 'ASSET.md';
}

export function isValidMarkdownFileName(value) {
  const candidate = String(value || '').trim();
  if (!candidate) return false;
  if (candidate.includes('/') || candidate.includes('\\')) return false;
  if (!/\.md$/i.test(candidate)) return false;
  return /^[A-Za-z0-9._-]+$/.test(candidate);
}

export function normalizeMarkdownFileName(value, fallback = 'ASSET.md') {
  const candidate = String(value || '').trim();
  if (isValidMarkdownFileName(candidate)) return candidate;
  return fallback;
}
