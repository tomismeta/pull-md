import test from 'node:test';
import assert from 'node:assert/strict';

import assetsHandler from '../api/assets/index.js';
import mcpHandler from '../api/mcp/index.js';
import manifestHandler from '../api/mcp/manifest.js';
import openApiHandler from '../api/openapi.json.js';
import apiCatalogHandler from '../api/well-known/api-catalog.js';

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
    [apiCatalogHandler, '/.well-known/api-catalog'],
    [openApiHandler, '/api/openapi.json'],
    [assetsHandler, '/api/assets'],
    [mcpHandler, '/mcp'],
    [manifestHandler, '/api/mcp/manifest']
  ];

  const responses = await Promise.all(
    endpoints.map(([handler, path]) => runRequest(handler, { path }))
  );

  for (const res of responses) {
    assert.equal(res.statusCode, 410);
    assert.equal(res.body?.code, 'service_retired');
    assert.match(String(res.headers.link || ''), /rel="service-doc"/);
    assert.doesNotMatch(String(res.headers.link || ''), /api-catalog|service-desc|service-meta/);
  }
});

test('retired discovery handlers answer preflight without advertising active methods', async () => {
  const res = await runRequest(openApiHandler, { method: 'OPTIONS', path: '/api/openapi.json' });
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, null);
  assert.equal(res.headers['x-pullmd-retired'], 'true');
});
