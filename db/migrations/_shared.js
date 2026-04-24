export const DEFAULT_PUBLIC_SCHEMA = 'public';
const PG_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/i;

export function asString(value) {
  return String(value || '').trim();
}

export function normalizePgIdentifier(raw, fallback = DEFAULT_PUBLIC_SCHEMA) {
  const candidate = asString(raw) || asString(fallback) || DEFAULT_PUBLIC_SCHEMA;
  if (!PG_IDENTIFIER_RE.test(candidate)) {
    return asString(fallback) || DEFAULT_PUBLIC_SCHEMA;
  }
  return candidate.toLowerCase();
}

export function quotePgIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function tableRef(schema, table) {
  return `${quotePgIdentifier(schema)}.${quotePgIdentifier(table)}`;
}
