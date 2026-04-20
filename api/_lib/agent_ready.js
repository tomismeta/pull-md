export const CONTENT_SIGNAL = 'ai-train=no, search=yes, ai-input=yes';
export const MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8';

function parseAcceptHeader(raw) {
  return String(raw || '')
    .split(',')
    .map((entry) => {
      const [type, ...params] = String(entry || '').split(';');
      const mediaType = String(type || '').trim().toLowerCase();
      if (!mediaType) return null;
      let q = 1;
      for (const param of params) {
        const [key, value] = String(param || '').split('=');
        if (String(key || '').trim().toLowerCase() !== 'q') continue;
        const parsed = Number.parseFloat(String(value || '').trim());
        if (Number.isFinite(parsed) && parsed >= 0) {
          q = parsed;
        }
      }
      return { mediaType, q };
    })
    .filter(Boolean);
}

function qualityFor(entries, target) {
  let best = 0;
  for (const entry of entries) {
    const type = String(entry?.mediaType || '').trim().toLowerCase();
    if (!type || entry.q <= 0) continue;
    if (type === target) {
      best = Math.max(best, entry.q);
      continue;
    }
    if (type === '*/*') {
      best = Math.max(best, entry.q * 0.01);
      continue;
    }
    const [entryMajor, entryMinor] = type.split('/');
    const [targetMajor, targetMinor] = target.split('/');
    if (entryMinor === '*' && entryMajor === targetMajor && targetMinor) {
      best = Math.max(best, entry.q * 0.1);
    }
  }
  return best;
}

export function requestPrefersMarkdown(headers = {}) {
  const entries = parseAcceptHeader(headers.accept || '');
  if (!entries.length) return false;
  const markdownQ = qualityFor(entries, 'text/markdown');
  if (markdownQ <= 0) return false;
  const htmlQ = Math.max(
    qualityFor(entries, 'text/html'),
    qualityFor(entries, 'application/xhtml+xml')
  );
  return htmlQ <= 0 || markdownQ >= htmlQ;
}

export function estimateMarkdownTokens(markdown) {
  const wordCount = String(markdown || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  if (!wordCount) return 0;
  return Math.max(1, Math.ceil(wordCount * 1.35));
}

export function cacheControl({ sMaxAge = 600, staleWhileRevalidate = 86400 } = {}) {
  return `public, max-age=0, s-maxage=${Number(sMaxAge)}, stale-while-revalidate=${Number(staleWhileRevalidate)}`;
}

export function setPublicReadHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
}

export function setContentSignalHeader(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('Content-Signal', CONTENT_SIGNAL);
}

export function setMarkdownDocumentHeaders(
  res,
  markdown,
  { sMaxAge = 600, staleWhileRevalidate = 86400 } = {}
) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('Content-Type', MARKDOWN_CONTENT_TYPE);
  res.setHeader('X-Markdown-Tokens', String(estimateMarkdownTokens(markdown)));
  res.setHeader('Cache-Control', cacheControl({ sMaxAge, staleWhileRevalidate }));
  setContentSignalHeader(res);
}

export function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
