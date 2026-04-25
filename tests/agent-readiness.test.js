import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import crypto from 'crypto';

import manifestHandler from '../api/mcp/manifest.js';

function runRequest(handler, { method = 'GET', headers = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, headers, query };
    const response = {
      statusCode: 200,
      headers: {},
      body: null,
      setHeader(key, value) {
        this.headers[String(key).toLowerCase()] = value;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        resolve(this);
        return this;
      },
      send(payload) {
        this.body = payload;
        resolve(this);
        return this;
      },
      end(payload) {
        if (payload !== undefined) this.body = payload;
        resolve(this);
        return this;
      }
    };

    Promise.resolve(handler(req, response)).catch(reject);
  });
}

test('homepage returns HTML by default with discovery Link headers', async () => {
  const res = await runRequest(manifestHandler, {
    method: 'GET',
    headers: { host: 'pull.md', 'x-forwarded-proto': 'https', accept: 'text/html' },
    query: { view: 'home' }
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /text\/html/i);
  assert.match(String(res.headers.link || ''), /rel="api-catalog"/);
  assert.match(String(res.headers.link || ''), /rel="alternate"; type="text\/markdown"/);
  assert.equal(String(res.headers.vary || ''), 'Accept');
  assert.match(String(res.body || ''), /<!DOCTYPE html>/i);
  assert.match(String(res.body || ''), /<link rel="canonical" href="https:\/\/pull\.md\/">/i);
});

test('homepage returns markdown when requested by agents', async () => {
  const res = await runRequest(manifestHandler, {
    method: 'GET',
    headers: { host: 'pull.md', 'x-forwarded-proto': 'https', accept: 'text/markdown, text/html;q=0.8' },
    query: { view: 'home' }
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /text\/markdown/i);
  assert.match(String(res.headers['content-signal'] || ''), /ai-train=no/i);
  assert.match(String(res.headers['x-markdown-tokens'] || ''), /^[0-9]+$/);
  assert.match(String(res.body || ''), /^# PULL\.md/m);
  assert.match(String(res.body || ''), /GET \/\.well-known\/mcp\/server-card\.json/);
  assert.match(String(res.body || ''), /OAuth\/OIDC discovery metadata is intentionally absent/i);
});

test('robots.txt publishes crawler policy, sitemap, and AI preferences', async () => {
  const body = fs.readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8');
  assert.match(body, /User-agent: GPTBot/);
  assert.match(body, /User-agent: Claude-Web/);
  assert.match(body, /User-agent: OAI-SearchBot/);
  assert.match(body, /Content-Signal: ai-train=no, search=yes, ai-input=yes/);
  assert.match(body, /Sitemap: https:\/\/pull\.md\/sitemap\.xml/);
});

test('sitemap.xml includes core discovery documents and canonical asset pages', async () => {
  const originalBundledSouls = process.env.ENABLE_BUNDLED_SOULS;
  process.env.ENABLE_BUNDLED_SOULS = '1';
  const res = await runRequest(manifestHandler, {
    method: 'GET',
    headers: { host: 'pull.md', 'x-forwarded-proto': 'https' },
    query: { view: 'sitemap' }
  });
  try {
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type'] || ''), /application\/xml/i);
    const body = String(res.body || '');
    assert.match(body, /<urlset/);
    assert.match(body, /https:\/\/pull\.md\/<\/loc>/);
    assert.match(body, /https:\/\/pull\.md\/WEBMCP\.md/);
    assert.match(body, /https:\/\/pull\.md\/\.well-known\/mcp\/server-card\.json/);
    assert.match(body, /https:\/\/pull\.md\/assets\/meta-starter-v1/);
  } finally {
    if (originalBundledSouls === undefined) delete process.env.ENABLE_BUNDLED_SOULS;
    else process.env.ENABLE_BUNDLED_SOULS = originalBundledSouls;
  }
});

test('static MCP server card exposes the HTTP transport and capabilities', () => {
  const raw = fs.readFileSync(new URL('../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8');
  const body = JSON.parse(raw);
  assert.equal(body?.serverInfo?.name, 'PULL.md');
  assert.equal(body?.transport?.type, 'streamable-http');
  assert.equal(body?.transport?.endpoint, '/mcp');
  assert.equal(typeof body?.capabilities?.tools, 'object');
});

test('static agent skills index publishes digested skill entries', () => {
  const raw = fs.readFileSync(new URL('../public/.well-known/agent-skills/index.json', import.meta.url), 'utf8');
  const body = JSON.parse(raw);
  assert.equal(body?.$schema, 'https://schemas.agentskills.io/discovery/0.2.0/schema.json');
  assert.ok(Array.isArray(body?.skills));
  assert.ok(body.skills.length >= 3);
  for (const skill of body.skills) {
    assert.equal(skill.type, 'skill-md');
    assert.match(String(skill.url || ''), /^\/\.well-known\/agent-skills\/[^/]+\/SKILL\.md$/);
    assert.match(String(skill.digest || ''), /^sha256:[a-f0-9]{64}$/);
    const fileUrl = new URL(`../public${skill.url}`, import.meta.url);
    const fileDigest = crypto.createHash('sha256').update(fs.readFileSync(fileUrl)).digest('hex');
    assert.equal(skill.digest, `sha256:${fileDigest}`);
  }
});

test('static agent skill markdown files are present', () => {
  const markdown = fs.readFileSync(
    new URL('../public/.well-known/agent-skills/publish-asset/SKILL.md', import.meta.url),
    'utf8'
  );
  assert.match(markdown, /^# Publish A PULL\.md Asset/m);
});

test('homepage loads the browser WebMCP shim', async () => {
  const homepage = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const webmcpShim = fs.readFileSync(new URL('../public/js/lib/webmcp.js', import.meta.url), 'utf8');
  assert.match(homepage, /js\/lib\/webmcp\.js/);
  assert.match(webmcpShim, /provideContext/);
  assert.match(webmcpShim, /pullmd\.list_assets/);
});
