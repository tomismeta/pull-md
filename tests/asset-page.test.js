import test from 'node:test';
import assert from 'node:assert/strict';

import manifestHandler from '../api/mcp/manifest.js';

function runRequest({ query = {}, url = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      method: 'GET',
      headers: { host: 'pull.md', 'x-forwarded-proto': 'https', accept: 'text/html' },
      query,
      url
    };
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
    Promise.resolve(manifestHandler(req, response)).catch(reject);
  });
}

test('former canonical asset pages return the human-readable retirement notice', async () => {
  const res = await runRequest({
    query: { view: 'asset', id: 'meta-starter-v1' },
    url: '/assets/meta-starter-v1'
  });
  assert.equal(res.statusCode, 410);
  assert.match(String(res.headers['content-type'] || ''), /text\/html/i);
  assert.equal(res.headers['x-pullmd-retired'], 'true');
  assert.match(String(res.body || ''), /PULL\.md has been retired/i);
  assert.match(String(res.body || ''), /September 21, 2026/i);
  assert.doesNotMatch(String(res.body || ''), /data-soul-id/i);
});

test('legacy asset.html also returns the retirement notice', async () => {
  const res = await runRequest({
    query: { view: 'retired', path: 'asset.html' },
    url: '/asset.html?id=meta-starter-v1'
  });
  assert.equal(res.statusCode, 410);
  assert.match(String(res.body || ''), /Pulled<br>offline\./i);
});
