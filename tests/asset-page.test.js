import test from 'node:test';
import assert from 'node:assert/strict';

import manifestHandler from '../api/mcp/manifest.js';

function runRequest(handler, { method = 'GET', headers = {}, query = {}, url = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, headers, query, url };
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

test('asset detail page serves canonical HTML metadata for asset routes', async () => {
  const originalBundledSouls = process.env.ENABLE_BUNDLED_SOULS;
  process.env.ENABLE_BUNDLED_SOULS = '1';
  const res = await runRequest(manifestHandler, {
    method: 'GET',
    headers: { host: 'pull.md', 'x-forwarded-proto': 'https' },
    query: { view: 'asset', id: 'meta-starter-v1' }
  });
  try {
    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type'] || ''), /text\/html/i);
    assert.match(String(res.body || ''), /<link rel="canonical" href="https:\/\/pull\.md\/assets\/meta-starter-v1">/i);
    assert.match(String(res.body || ''), /<meta property="og:url" content="https:\/\/pull\.md\/assets\/meta-starter-v1">/i);
    assert.match(String(res.body || ''), />Meta Starter Soul — PULL\.md</i);
    assert.match(String(res.body || ''), /data-soul-id="meta-starter-v1"/i);
  } finally {
    if (originalBundledSouls === undefined) delete process.env.ENABLE_BUNDLED_SOULS;
    else process.env.ENABLE_BUNDLED_SOULS = originalBundledSouls;
  }
});

test('legacy asset.html query route remains compatible through the same renderer', async () => {
  const originalBundledSouls = process.env.ENABLE_BUNDLED_SOULS;
  process.env.ENABLE_BUNDLED_SOULS = '1';
  const res = await runRequest(manifestHandler, {
    method: 'GET',
    headers: { host: 'pull.md', 'x-forwarded-proto': 'https' },
    query: { view: 'asset' },
    url: '/asset.html?id=meta-starter-v1'
  });
  try {
    assert.equal(res.statusCode, 200);
    assert.match(String(res.body || ''), /https:\/\/pull\.md\/assets\/meta-starter-v1/i);
  } finally {
    if (originalBundledSouls === undefined) delete process.env.ENABLE_BUNDLED_SOULS;
    else process.env.ENABLE_BUNDLED_SOULS = originalBundledSouls;
  }
});
