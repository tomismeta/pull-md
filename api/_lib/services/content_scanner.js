import crypto from 'crypto';

const SCAN_MODE_VALUES = new Set(['off', 'advisory', 'enforce']);
const FAIL_POLICY_VALUES = new Set(['fail_open', 'fail_closed']);
const DEFAULT_SCAN_MODE = 'advisory';
const DEFAULT_FAIL_POLICY = 'fail_open';
const MAX_FINDINGS = 64;
const MAX_EVIDENCE = 180;

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
  'you are now',
  'developer message',
  'system prompt',
  'override safety',
  'bypass safeguards'
];

const SECRET_PATTERNS = [
  { code: 'openai_key', re: /\bsk-[a-z0-9]{20,}\b/i, label: 'Possible OpenAI-style API key' },
  { code: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'Possible AWS access key' },
  { code: 'github_token', re: /\bghp_[A-Za-z0-9]{36}\b/g, label: 'Possible GitHub token' },
  { code: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: 'Possible Slack token' },
  { code: 'google_api_key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/g, label: 'Possible Google API key' }
];

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

function scanDangerousHtml(markdown) {
  const text = String(markdown || '');
  const findings = [];
  const tagMatch = text.match(DANGEROUS_TAG_RE);
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
  const handlerMatch = text.match(INLINE_HANDLER_RE);
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
  if (DETAILS_RE.test(text)) {
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
  const comments = text.match(HTML_COMMENT_RE) || [];
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
  }
  return findings;
}

function extractUrls(markdown) {
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

  return [...new Set(urls)];
}

function scanUrls(markdown) {
  const findings = [];
  const urls = extractUrls(markdown);
  for (const urlText of urls) {
    const raw = String(urlText || '').trim();
    const scheme = raw.split(':')[0]?.toLowerCase();
    if (!scheme) continue;
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
    try {
      const parsed = new URL(raw);
      if (String(parsed.hostname || '').toLowerCase().startsWith('xn--')) {
        findings.push(
          createFinding({
            scanner: 'url_safety',
            code: 'punycode_hostname',
            severity: 'medium',
            action: 'warn',
            message: 'Punycode hostname detected; verify domain authenticity.',
            evidence: parsed.hostname
          })
        );
      }
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

const DEFAULT_SCANNERS = [
  {
    id: 'unicode',
    run: ({ content_markdown }) => scanInvisibleUnicode(content_markdown)
  },
  {
    id: 'html_structure',
    run: ({ content_markdown }) => scanDangerousHtml(content_markdown)
  },
  {
    id: 'url_safety',
    run: ({ content_markdown }) => scanUrls(content_markdown)
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
    fail_policy: scanFailPolicy()
  };
}

export async function scanMarkdownAssetContent(input = {}, options = {}) {
  const scannedAt = nowIso();
  const mode = normalizeScanMode(options.mode || scanMode());
  const failPolicy = normalizeFailPolicy(options.failPolicy || scanFailPolicy());
  const scanners = Array.isArray(options.scanners) && options.scanners.length > 0 ? options.scanners : DEFAULT_SCANNERS;
  const contentMarkdown = String(input?.content_markdown || '');
  const context = {
    asset_id: String(input?.asset_id || '').trim() || null,
    asset_type: String(input?.asset_type || '').trim().toLowerCase() || null,
    file_name: String(input?.file_name || '').trim() || null,
    name: String(input?.name || '').trim() || null,
    description: String(input?.description || '').trim() || null,
    content_markdown: contentMarkdown,
    stage: String(options.stage || input?.stage || '').trim() || 'unknown'
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
      summary: buildSummary([])
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
    summary: buildSummary(findings)
  };
}
