import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

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

test('homepage returns a canonical retirement notice for browsers', async () => {
  const res = await runRequest(manifestHandler, {
    method: 'GET',
    headers: { host: 'pull.md', 'x-forwarded-proto': 'https', accept: 'text/html' },
    query: { view: 'home' }
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /text\/html/i);
  assert.equal(res.headers['x-pullmd-retired'], 'true');
  assert.doesNotMatch(String(res.headers.link || ''), /api-catalog/);
  assert.match(String(res.body || ''), /PULL\.md has been retired/i);
  assert.match(String(res.body || ''), /September 21, 2026/i);
  assert.match(String(res.body || ''), /<link rel="canonical" href="https:\/\/pull\.md\/">/i);
});

test('homepage returns the retirement contract as markdown for agents', async () => {
  const res = await runRequest(manifestHandler, {
    method: 'GET',
    headers: { host: 'pull.md', 'x-forwarded-proto': 'https', accept: 'text/markdown, text/html;q=0.8' },
    query: { view: 'home' }
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /text\/markdown/i);
  assert.match(String(res.headers['content-signal'] || ''), /ai-input=no/i);
  assert.match(String(res.headers['x-markdown-tokens'] || ''), /^[0-9]+$/);
  assert.match(String(res.body || ''), /^# PULL\.md has been retired/m);
  assert.match(String(res.body || ''), /MCP transport and tools: `410 Gone`/);
  assert.match(String(res.body || ''), /Existing entitlement recovery/);
});

test('robots.txt permits the notice while blocking retired surfaces', () => {
  const body = fs.readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8');
  assert.match(body, /User-agent: GPTBot/);
  assert.match(body, /User-agent: Claude-Web/);
  assert.match(body, /Disallow: \/api\//);
  assert.match(body, /Disallow: \/mcp/);
  assert.match(body, /Content-Signal: ai-train=no, search=yes, ai-input=no/);
  assert.match(body, /Sitemap: https:\/\/pull\.md\/sitemap\.xml/);
});

test('sitemap.xml contains only the canonical retirement notice', async () => {
  const res = await runRequest(manifestHandler, {
    method: 'GET',
    headers: { host: 'pull.md', 'x-forwarded-proto': 'https' },
    query: { view: 'sitemap' }
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /application\/xml/i);
  const body = String(res.body || '');
  assert.match(body, /https:\/\/pull\.md\/<\/loc>/);
  assert.match(body, /<lastmod>2026-08-21<\/lastmod>/);
  assert.doesNotMatch(body, /WEBMCP|api\/|assets\//);
});

test('static MCP server card declares retirement and no capabilities', () => {
  const body = JSON.parse(
    fs.readFileSync(new URL('../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8')
  );
  assert.equal(body?.serverInfo?.name, 'PULL.md');
  assert.equal(body?.status, 'retired');
  assert.equal(body?.transport?.available, false);
  assert.equal(body?.transport?.statusCode, 410);
  assert.deepEqual(body?.capabilities, {});
  assert.deepEqual(body?.tools, []);
});

test('agent skills index is intentionally empty after retirement', () => {
  const body = JSON.parse(
    fs.readFileSync(new URL('../public/.well-known/agent-skills/index.json', import.meta.url), 'utf8')
  );
  assert.equal(body?.status, 'retired');
  assert.deepEqual(body?.skills, []);
});

test('retirement homepage ships no wallet or WebMCP runtime', () => {
  const homepage = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(homepage, /webmcp\.js/i);
  assert.doesNotMatch(homepage, /wallet-config|connect wallet/i);
  assert.doesNotMatch(homepage, /<script/i);
});
