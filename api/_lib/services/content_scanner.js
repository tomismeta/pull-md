import crypto from 'crypto';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import confusables from 'confusables';
import { sanitizeUrl } from '@braintree/sanitize-url';
import { parse as parseDomain } from 'tldts';
import ipaddr from 'ipaddr.js';
import QuickLRU from 'quick-lru';

const SCAN_MODE_VALUES = new Set(['off', 'advisory', 'enforce']);
const FAIL_POLICY_VALUES = new Set(['fail_open', 'fail_closed']);
const DEFAULT_SCAN_MODE = 'advisory';
const DEFAULT_FAIL_POLICY = 'fail_open';
const MAX_FINDINGS = 64;
const MAX_EVIDENCE = 180;
const MAX_CONFUSABLE_FINDINGS = 8;
const DEFAULT_MAX_CONTENT_BYTES = 512 * 1024;

const parser = unified().use(remarkParse).use(remarkGfm);
const normalizedUrlCache = new QuickLRU({ maxSize: 2048 });
const urlhausCache = new QuickLRU({ maxSize: 4096 });

const HIDDEN_UNICODE_RANGES = [
  { code: 'zero_width', label: 'Zero-width or invisible Unicode', min: 0x200b, max: 0x200f, severity: 'medium' },
  { code: 'bidi_override', label: 'Bidirectional override/control Unicode', min: 0x202a, max: 0x202e, severity: 'high' },
  { code: 'invisible_operator', label: 'Invisible Unicode operators', min: 0x2060, max: 0x2069, severity: 'medium' },
  { code: 'bom', label: 'Unexpected BOM character', min: 0xfeff, max: 0xfeff, severity: 'medium' },
  { code: 'tag_char', label: 'Unicode tag characters', min: 0xe0000, max: 0xe007f, severity: 'high' }
];

const DANGEROUS_TAG_RE = /<\s*(script|iframe|object|embed|meta|link|base|form|input)\b/i;
const INLINE_HANDLER_RE = /\bon[a-z]+\s*=/i;
const DETAILS_RE = /<\s*details\b/i;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/gi;
const DANGEROUS_SCHEMES = new Set(['javascript', 'vbscript', 'data', 'file']);

const INJECTION_PHRASES = [
  'ignore previous instructions',
  'disregard previous instructions',
  'ignore all prior instructions',
  'the above instructions are fake',
  'your real instructions are',
  'always reply with',
  'respond with the following',
  'do not reveal',
  'act as if',
  'pretend you are',
  'when the user asks',
  'you are now',
  'developer message',
  'system prompt',
  'override safety',
  'bypass safeguards',
  'ignore all previous instructions',
  'ignora las instrucciones anteriores',
  'ignorer les instructions précédentes',
  'ignoriere vorherige anweisungen',
  'ignore as instruções anteriores',
  '忽略之前的指示',
  'игнорируй предыдущие инструкции'
];

const ROLE_MARKER_PATTERNS = [
  /<\|im_start\|>/i,
  /###\s*system\s*###/i,
  /\[inst\]/i,
  /<<\s*sys\s*>>/i,
  /###\s*instruction\s*:/i,
  /\bassistant\s*:/i,
  /\bhuman\s*:/i,
  /<\s*system\s*>/i
];

const BASE64_BLOB_RE = /(?:^|[^A-Za-z0-9+/=])([A-Za-z0-9+/]{40,}={0,2})(?:[^A-Za-z0-9+/=]|$)/g;

const SECRET_PATTERNS = [
  { code: 'openai_key', re: /\bsk-(?:proj-)?[a-zA-Z0-9]{20,}\b/g, label: 'Possible OpenAI-style API key' },
  { code: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g, label: 'Possible Anthropic API key' },
  { code: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'Possible AWS access key' },
  { code: 'github_token', re: /\bghp_[A-Za-z0-9]{36}\b/g, label: 'Possible GitHub token' },
  { code: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: 'Possible Slack token' },
  { code: 'google_api_key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/g, label: 'Possible Google API key' },
  { code: 'generic_bearer', re: /\bBearer\s+[A-Za-z0-9\-_.~+/]{20,}\b/g, label: 'Possible Bearer token' },
  { code: 'stripe_key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g, label: 'Possible Stripe key' }
];

const WORD_TOKEN_RE = /\p{L}[\p{L}\p{N}._:-]{2,}/gu;
const LOCAL_HOST_SUFFIXES = ['.local', '.internal', '.localhost'];

function nowIso() {
  return new Date().toISOString();
}

function normalizeScanMode(raw) {
  const mode = String(raw || '').trim().toLowerCase();
  if (SCAN_MODE_VALUES.has(mode)) return mode;
  return DEFAULT_SCAN_MODE;
}

function normalizeFailPolicy(raw) {
  const policy = String(raw || '').trim().toLowerCase();
  if (FAIL_POLICY_VALUES.has(policy)) return policy;
  return DEFAULT_FAIL_POLICY;
}

function scanMode() {
  return normalizeScanMode(process.env.MARKDOWN_SCAN_MODE || process.env.ASSET_SCAN_MODE);
}

function scanFailPolicy() {
  return normalizeFailPolicy(process.env.MARKDOWN_SCAN_FAIL_POLICY || process.env.ASSET_SCAN_FAIL_POLICY);
}

function isTruthyEnv(raw) {
  const value = String(raw || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function urlhausEnabled() {
  return isTruthyEnv(process.env.URLHAUS_REPUTATION_ENABLED);
}

function urlhausEndpoint() {
  return String(process.env.URLHAUS_API_URL || 'https://urlhaus-api.abuse.ch/v1/host/').trim();
}

function urlhausTimeoutMs() {
  const n = Number(process.env.URLHAUS_TIMEOUT_MS || 1500);
  if (!Number.isFinite(n) || n < 100) return 1500;
  return Math.min(Math.floor(n), 10000);
}

function urlhausCacheTtlMs() {
  const n = Number(process.env.URLHAUS_CACHE_TTL_MS || 10 * 60 * 1000);
  if (!Number.isFinite(n) || n < 1000) return 10 * 60 * 1000;
  return Math.min(Math.floor(n), 60 * 60 * 1000);
}

function maxExternalUrlChecks() {
  const n = Number(process.env.SCAN_URL_REPUTATION_MAX_URLS || 12);
  if (!Number.isFinite(n) || n < 1) return 12;
  return Math.min(Math.floor(n), 32);
}

function maxContentBytes() {
  const n = Number(process.env.SCAN_MAX_CONTENT_BYTES || DEFAULT_MAX_CONTENT_BYTES);
  if (!Number.isFinite(n) || n < 64 * 1024) return DEFAULT_MAX_CONTENT_BYTES;
  return Math.min(Math.floor(n), 4 * 1024 * 1024);
}

function truncateEvidence(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.length <= MAX_EVIDENCE ? text : `${text.slice(0, MAX_EVIDENCE - 3)}...`;
}

function createFinding({
  scanner,
  code,
  severity = 'medium',
  action = 'warn',
  message,
  field = 'content_markdown',
  evidence = null
}) {
  return {
    scanner: String(scanner || 'scanner'),
    code: String(code || 'rule'),
    severity: String(severity || 'medium'),
    action: String(action || 'warn'),
    message: String(message || 'Potential risk detected'),
    field,
    evidence: truncateEvidence(evidence)
  };
}

function buildSummary(findings = []) {
  const summary = {
    total: findings.length,
    by_severity: { high: 0, medium: 0, low: 0 },
    by_action: { block: 0, warn: 0 }
  };
  for (const finding of findings) {
    const severity = String(finding?.severity || '').toLowerCase();
    const action = String(finding?.action || '').toLowerCase();
    if (severity === 'high' || severity === 'medium' || severity === 'low') {
      summary.by_severity[severity] += 1;
    }
    if (action === 'block' || action === 'warn') {
      summary.by_action[action] += 1;
    }
  }
  return summary;
}

function parseMarkdownAst(markdown) {
  try {
    return parser.parse(String(markdown || ''));
  } catch (_) {
    return null;
  }
}

function collectAstUrls(ast) {
  const urls = [];
  if (!ast || typeof ast !== 'object') return urls;
  visit(ast, (node) => {
    if (!node || typeof node !== 'object') return;
    const type = String(node.type || '');
    if (type === 'link' || type === 'image' || type === 'definition') {
      const raw = String(node.url || '').trim();
      if (raw) urls.push(raw);
    }
  });
  return urls;
}

function extractRawUrls(markdown) {
  const urls = [];
  const text = String(markdown || '');
  const markdownLinkRe = /\[[^\]]*\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g;
  let match = markdownLinkRe.exec(text);
  while (match) {
    const raw = String(match[1] || '').split(/\s+"/)[0].trim();
    if (raw) urls.push(raw);
    match = markdownLinkRe.exec(text);
  }

  const angleRe = /<((?:https?:\/\/|javascript:|vbscript:|data:|file:)[^>\s]+)>/gi;
  match = angleRe.exec(text);
  while (match) {
    const raw = String(match[1] || '').trim();
    if (raw) urls.push(raw);
    match = angleRe.exec(text);
  }

  const rawRe = /\b(?:https?:\/\/|javascript:|vbscript:|data:|file:)[^\s)]+/gi;
  match = rawRe.exec(text);
  while (match) {
    const raw = String(match[0] || '').trim();
    if (raw) urls.push(raw);
    match = rawRe.exec(text);
  }

  return urls;
}

function extractUrls(markdown, ast) {
  return [...new Set([...collectAstUrls(ast), ...extractRawUrls(markdown)].filter(Boolean))];
}

function scanInvisibleUnicode(markdown) {
  const findings = [];
  const counts = new Map();
  for (const ch of String(markdown || '')) {
    const cp = ch.codePointAt(0);
    if (!Number.isFinite(cp)) continue;
    for (const range of HIDDEN_UNICODE_RANGES) {
      if (cp >= range.min && cp <= range.max) {
        counts.set(range.code, (counts.get(range.code) || 0) + 1);
      }
    }
  }
  for (const range of HIDDEN_UNICODE_RANGES) {
    const count = counts.get(range.code) || 0;
    if (count <= 0) continue;
    findings.push(
      createFinding({
        scanner: 'unicode',
        code: range.code,
        severity: range.severity,
        action: range.severity === 'high' ? 'block' : 'warn',
        message: `${range.label} detected (${count}).`,
        evidence: `count=${count}`
      })
    );
  }
  return findings;
}

function scanDangerousHtml(markdown, ast) {
  const findings = [];
  const snippets = [];
  const text = String(markdown || '');
  if (text) snippets.push(text);
  if (ast && typeof ast === 'object') {
    visit(ast, 'html', (node) => {
      const value = String(node?.value || '').trim();
      if (value) snippets.push(value);
    });
    visit(ast, 'definition', (node) => {
      const title = String(node?.title || '').trim();
      if (!title) return;
      const lowered = title.toLowerCase();
      for (const phrase of INJECTION_PHRASES) {
        if (!lowered.includes(phrase)) continue;
        findings.push(
          createFinding({
            scanner: 'markdown_structure',
            code: 'definition_title_injection_phrase',
            severity: 'low',
            action: 'warn',
            message: `Reference link title contains potential prompt-injection phrase: "${phrase}".`,
            evidence: title
          })
        );
      }
    });
  }

  for (const snippet of snippets) {
    const tagMatch = snippet.match(DANGEROUS_TAG_RE);
    if (tagMatch) {
      findings.push(
        createFinding({
          scanner: 'html_structure',
          code: 'dangerous_tag',
          severity: 'high',
          action: 'block',
          message: `Dangerous HTML tag detected: <${String(tagMatch[1] || '').toLowerCase()}>.`,
          evidence: tagMatch[0]
        })
      );
    }

    const handlerMatch = snippet.match(INLINE_HANDLER_RE);
    if (handlerMatch) {
      findings.push(
        createFinding({
          scanner: 'html_structure',
          code: 'inline_event_handler',
          severity: 'high',
          action: 'block',
          message: 'Inline HTML event handler detected.',
          evidence: handlerMatch[0]
        })
      );
    }

    if (DETAILS_RE.test(snippet)) {
      findings.push(
        createFinding({
          scanner: 'html_structure',
          code: 'details_block',
          severity: 'low',
          action: 'warn',
          message: 'HTML <details> block detected. Hidden markdown structures can obscure instructions.'
        })
      );
    }

    const comments = snippet.match(HTML_COMMENT_RE) || [];
    if (comments.length > 0) {
      findings.push(
        createFinding({
          scanner: 'html_structure',
          code: 'html_comment',
          severity: 'medium',
          action: 'warn',
          message: `HTML comments detected (${comments.length}). Hidden comments may mask behavior.`,
          evidence: comments[0]
        })
      );
      for (const comment of comments) {
        const loweredComment = String(comment || '').toLowerCase();
        for (const phrase of INJECTION_PHRASES) {
          if (!loweredComment.includes(phrase)) continue;
          findings.push(
            createFinding({
              scanner: 'html_structure',
              code: 'comment_injection_phrase',
              severity: 'high',
              action: 'block',
              message: `HTML comment contains prompt-injection phrase: "${phrase}".`,
              evidence: comment
            })
          );
        }
      }
    }
  }

  return findings;
}

function scanPromptInjectionPhrases(markdown) {
  const text = String(markdown || '').toLowerCase();
  const findings = [];
  for (const phrase of INJECTION_PHRASES) {
    if (!text.includes(phrase)) continue;
    findings.push(
      createFinding({
        scanner: 'prompt_injection',
        code: 'injection_phrase',
        severity: 'medium',
        action: 'warn',
        message: `Potential prompt-injection phrase detected: "${phrase}".`,
        evidence: phrase
      })
    );
  }

  for (const marker of ROLE_MARKER_PATTERNS) {
    marker.lastIndex = 0;
    const match = marker.exec(String(markdown || ''));
    if (!match) continue;
    findings.push(
      createFinding({
        scanner: 'prompt_injection',
        code: 'role_boundary_marker',
        severity: 'medium',
        action: 'warn',
        message: 'Role boundary marker detected; this can be used for prompt-injection.',
        evidence: match[0]
      })
    );
  }

  BASE64_BLOB_RE.lastIndex = 0;
  let base64Match = BASE64_BLOB_RE.exec(String(markdown || ''));
  while (base64Match) {
    const blob = String(base64Match[1] || '');
    if (blob.length >= 80) {
      findings.push(
        createFinding({
          scanner: 'prompt_injection',
          code: 'encoded_payload_blob',
          severity: 'medium',
          action: 'warn',
          message: 'Long Base64-like blob detected; review for hidden payloads.',
          evidence: blob
        })
      );
      if (findings.length >= MAX_FINDINGS) break;
    }
    base64Match = BASE64_BLOB_RE.exec(String(markdown || ''));
  }

  return findings;
}

function scanSecrets(markdown) {
  const text = String(markdown || '');
  const findings = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.re.lastIndex = 0;
    const match = pattern.re.exec(text);
    if (!match) continue;
    findings.push(
      createFinding({
        scanner: 'secret_leak',
        code: pattern.code,
        severity: 'high',
        action: 'block',
        message: pattern.label,
        evidence: match[0]
      })
    );
  }
  return findings;
}

function scanConfusableContent(markdown) {
  const text = String(markdown || '');
  const tokens = text.match(WORD_TOKEN_RE) || [];
  const findings = [];
  for (const token of tokens) {
    if (!/[^\x00-\x7F]/.test(token)) continue;
    const normalized = String(confusables.remove(token) || '');
    if (!normalized || normalized === token) continue;
    if (!/^[\x20-\x7E]+$/.test(normalized)) continue;
    if (!/[a-z]/i.test(normalized)) continue;
    findings.push(
      createFinding({
        scanner: 'confusable',
        code: 'confusable_token',
        severity: 'medium',
        action: 'warn',
        message: 'Possible confusable Unicode token detected.',
        evidence: `${token} => ${normalized}`
      })
    );
    if (findings.length >= MAX_CONFUSABLE_FINDINGS) break;
  }
  return findings;
}

function normalizeUrlCandidate(raw) {
  const candidate = String(raw || '').trim();
  if (!candidate) return { raw: candidate, sanitized: '', scheme: '' };
  const cached = normalizedUrlCache.get(candidate);
  if (cached) return cached;

  const sanitized = String(sanitizeUrl(candidate) || '').trim();
  const scheme = candidate.includes(':') ? candidate.split(':')[0].toLowerCase() : '';
  const value = { raw: candidate, sanitized, scheme };
  normalizedUrlCache.set(candidate, value);
  return value;
}

function isLocalHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost') return true;
  return LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function classifyIpHost(hostname) {
  const host = String(hostname || '').trim();
  if (!host || !ipaddr.isValid(host)) return null;
  try {
    const parsed = ipaddr.parse(host);
    const range = parsed.range();
    return {
      kind: parsed.kind(),
      range: String(range || 'unknown')
    };
  } catch (_) {
    return null;
  }
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function lookupUrlhaus(hostname) {
  if (!urlhausEnabled()) return null;
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return null;

  const now = Date.now();
  const cached = urlhausCache.get(host);
  if (cached && Number(cached.expiresAt || 0) > now) {
    return cached.value;
  }

  const formBody = new URLSearchParams({ host });
  const response = await fetchJsonWithTimeout(
    urlhausEndpoint(),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json'
      },
      body: formBody.toString()
    },
    urlhausTimeoutMs()
  );

  let payload = {};
  try {
    payload = await response.json();
  } catch (_) {
    payload = {};
  }

  const queryStatus = String(payload?.query_status || '').toLowerCase();
  const urls = Array.isArray(payload?.urls) ? payload.urls : [];
  const malicious = queryStatus === 'ok' && urls.length > 0;
  const sample = malicious ? urls[0] : null;
  const value = {
    malicious,
    source: 'urlhaus',
    host,
    sample: sample && typeof sample === 'object'
      ? {
          url: String(sample.url || ''),
          status: String(sample.url_status || ''),
          threat: String(sample.threat || '')
        }
      : null
  };

  urlhausCache.set(host, {
    value,
    expiresAt: now + urlhausCacheTtlMs()
  });
  return value;
}

async function scanUrls(markdown, context) {
  const findings = [];
  const urls = Array.isArray(context?.urls) ? context.urls : extractUrls(markdown, context?.ast);
  let checkedForReputation = 0;

  for (const urlText of urls) {
    const normalized = normalizeUrlCandidate(urlText);
    const raw = normalized.raw;
    const scheme = normalized.scheme;

    if (!raw) continue;
    if (DANGEROUS_SCHEMES.has(scheme)) {
      findings.push(
        createFinding({
          scanner: 'url_safety',
          code: 'dangerous_uri_scheme',
          severity: 'high',
          action: 'block',
          message: `Dangerous URI scheme detected: ${scheme}:`,
          evidence: raw
        })
      );
      continue;
    }

    if (normalized.sanitized === 'about:blank' && !/^about:blank$/i.test(raw)) {
      findings.push(
        createFinding({
          scanner: 'url_safety',
          code: 'sanitized_to_blank',
          severity: 'high',
          action: 'block',
          message: 'URL was sanitized as unsafe.',
          evidence: raw
        })
      );
      continue;
    }

    if (raw.length > 2048) {
      findings.push(
        createFinding({
          scanner: 'url_safety',
          code: 'oversized_url',
          severity: 'medium',
          action: 'warn',
          message: 'Very long URL detected.',
          evidence: raw
        })
      );
    }

    let parsed = null;
    try {
      parsed = new URL(normalized.sanitized || raw);
    } catch (_) {
      findings.push(
        createFinding({
          scanner: 'url_safety',
          code: 'malformed_url',
          severity: 'low',
          action: 'warn',
          message: 'Malformed URL detected in markdown.',
          evidence: raw
        })
      );
      continue;
    }

    const hostname = String(parsed.hostname || '').toLowerCase();
    if (!hostname) continue;

    if (hostname.startsWith('xn--')) {
      findings.push(
        createFinding({
          scanner: 'url_safety',
          code: 'punycode_hostname',
          severity: 'medium',
          action: 'warn',
          message: 'Punycode hostname detected; verify domain authenticity.',
          evidence: hostname
        })
      );
    }

    if (isLocalHostname(hostname)) {
      findings.push(
        createFinding({
          scanner: 'url_safety',
          code: 'local_hostname',
          severity: 'medium',
          action: 'warn',
          message: 'Local/internal hostname reference detected.',
          evidence: hostname
        })
      );
    }

    const ipInfo = classifyIpHost(hostname);
    if (ipInfo) {
      const range = String(ipInfo.range || '').toLowerCase();
      const suspiciousRange = range && range !== 'unicast';
      if (suspiciousRange) {
        findings.push(
          createFinding({
            scanner: 'url_safety',
            code: 'non_public_ip_target',
            severity: 'medium',
            action: 'warn',
            message: `URL points to non-public IP range (${range}).`,
            evidence: hostname
          })
        );
      }
    }

    const domainInfo = parseDomain(parsed.href);
    if (!domainInfo?.publicSuffix) {
      findings.push(
        createFinding({
          scanner: 'url_safety',
          code: 'missing_public_suffix',
          severity: 'low',
          action: 'warn',
          message: 'URL host has no recognized public suffix.',
          evidence: hostname
        })
      );
    }

    const protocol = String(parsed.protocol || '').toLowerCase();
    if ((protocol === 'http:' || protocol === 'https:') && checkedForReputation < maxExternalUrlChecks()) {
      checkedForReputation += 1;
      const intel = await lookupUrlhaus(hostname);
      if (intel?.malicious) {
        findings.push(
          createFinding({
            scanner: 'url_reputation',
            code: 'urlhaus_match',
            severity: 'high',
            action: 'block',
            message: 'URL host matched known malicious infrastructure.',
            evidence: intel.sample?.url || hostname
          })
        );
      }
    }
  }

  return findings;
}

const DEFAULT_SCANNERS = [
  {
    id: 'unicode',
    run: ({ content_markdown }) => scanInvisibleUnicode(content_markdown)
  },
  {
    id: 'confusable',
    run: ({ content_markdown }) => scanConfusableContent(content_markdown)
  },
  {
    id: 'markdown_structure',
    run: ({ content_markdown, ast }) => scanDangerousHtml(content_markdown, ast)
  },
  {
    id: 'url_safety',
    run: ({ content_markdown, ast, urls }) => scanUrls(content_markdown, { ast, urls })
  },
  {
    id: 'prompt_injection',
    run: ({ content_markdown }) => scanPromptInjectionPhrases(content_markdown)
  },
  {
    id: 'secret_leak',
    run: ({ content_markdown }) => scanSecrets(content_markdown)
  }
];

function createScannerErrorFinding(scannerId, error, failPolicy) {
  return createFinding({
    scanner: 'scanner_runtime',
    code: 'scanner_error',
    severity: failPolicy === 'fail_closed' ? 'high' : 'medium',
    action: failPolicy === 'fail_closed' ? 'block' : 'warn',
    message: `Scanner "${scannerId}" failed: ${error instanceof Error ? error.message : String(error || 'unknown_error')}`
  });
}

export function getContentScannerConfig() {
  return {
    mode: scanMode(),
    fail_policy: scanFailPolicy(),
    url_reputation_enabled: urlhausEnabled(),
    url_reputation_source: urlhausEnabled() ? 'urlhaus' : null,
    scanners: DEFAULT_SCANNERS.map((scanner) => scanner.id)
  };
}

export async function scanMarkdownAssetContent(input = {}, options = {}) {
  const scannedAt = nowIso();
  const mode = normalizeScanMode(options.mode || scanMode());
  const failPolicy = normalizeFailPolicy(options.failPolicy || scanFailPolicy());
  const scanners = Array.isArray(options.scanners) && options.scanners.length > 0 ? options.scanners : DEFAULT_SCANNERS;
  const contentMarkdown = String(input?.content_markdown || '');
  const ast = parseMarkdownAst(contentMarkdown);
  const urls = extractUrls(contentMarkdown, ast);
  const context = {
    asset_id: String(input?.asset_id || '').trim() || null,
    asset_type: String(input?.asset_type || '').trim().toLowerCase() || null,
    file_name: String(input?.file_name || '').trim() || null,
    name: String(input?.name || '').trim() || null,
    description: String(input?.description || '').trim() || null,
    content_markdown: contentMarkdown,
    stage: String(options.stage || input?.stage || '').trim() || 'unknown',
    ast,
    urls
  };
  const contentHash = crypto.createHash('sha256').update(contentMarkdown, 'utf8').digest('hex');

  if (mode === 'off') {
    return {
      ok: true,
      blocked: false,
      verdict: 'disabled',
      scanned_at: scannedAt,
      mode,
      fail_policy: failPolicy,
      content_sha256: contentHash,
      findings: [],
      summary: buildSummary([]),
      scanners: scanners.map((scanner) => String(scanner?.id || 'scanner'))
    };
  }

  const contentSizeBytes = Buffer.byteLength(contentMarkdown, 'utf8');
  if (contentSizeBytes > maxContentBytes()) {
    const findings = [
      createFinding({
        scanner: 'input_guard',
        code: 'content_too_large',
        severity: 'high',
        action: 'block',
        message: `Content exceeds maximum scan size (${maxContentBytes()} bytes).`,
        evidence: `size=${contentSizeBytes}`
      })
    ];
    return {
      ok: false,
      blocked: mode === 'enforce',
      verdict: mode === 'enforce' ? 'block' : 'warn',
      scanned_at: scannedAt,
      mode,
      fail_policy: failPolicy,
      content_sha256: contentHash,
      findings,
      summary: buildSummary(findings),
      scanners: scanners.map((scanner) => String(scanner?.id || 'scanner'))
    };
  }

  const findings = [];
  for (const scanner of scanners) {
    if (findings.length >= MAX_FINDINGS) break;
    const scannerId = String(scanner?.id || 'scanner').trim() || 'scanner';
    try {
      const produced = await scanner.run(context);
      const list = Array.isArray(produced) ? produced : [];
      for (const finding of list) {
        findings.push(finding);
        if (findings.length >= MAX_FINDINGS) break;
      }
    } catch (error) {
      findings.push(createScannerErrorFinding(scannerId, error, failPolicy));
    }
  }

  const blocked = mode === 'enforce' && findings.some((item) => String(item?.action || '').toLowerCase() === 'block');
  const verdict = blocked ? 'block' : findings.length > 0 ? 'warn' : 'clean';

  return {
    ok: !blocked,
    blocked,
    verdict,
    scanned_at: scannedAt,
    mode,
    fail_policy: failPolicy,
    content_sha256: contentHash,
    findings,
    summary: buildSummary(findings),
    scanners: scanners.map((scanner) => String(scanner?.id || 'scanner'))
  };
}
