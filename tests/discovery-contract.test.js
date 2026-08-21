import test from 'node:test';
import assert from 'node:assert/strict';

import retiredHandler from '../api/retired.js';

function runRequest(handler, { method = 'GET', path = '/' } = {}) {
  return new Promise((resolve, reject) => {
    const req = {
      method,
      headers: { host: 'pull.md', 'x-forwarded-proto': 'https' },
      query: {},
      body: {},
      url: path
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
    Promise.resolve(handler(req, response)).catch(reject);
  });
}

test('all former MCP and REST discovery handlers fail closed with 410', async () => {
  const endpoints = [
    '/.well-known/api-catalog',
    '/api/openapi.json',
    '/api/assets',
    '/mcp',
    '/api/mcp/manifest'
  ];

  const responses = await Promise.all(
    endpoints.map((path) => runRequest(retiredHandler, { path }))
  );

  for (const res of responses) {
    assert.equal(res.statusCode, 410);
    assert.equal(res.body?.code, 'service_retired');
    assert.match(String(res.headers.link || ''), /rel="service-doc"/);
    assert.doesNotMatch(String(res.headers.link || ''), /api-catalog|service-desc|service-meta/);
  }
});

test('retired discovery handlers answer preflight without advertising active methods', async () => {
  const res = await runRequest(retiredHandler, { method: 'OPTIONS', path: '/api/openapi.json' });
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, null);
  assert.equal(res.headers['x-pullmd-retired'], 'true');
});
