import test from 'node:test';
import assert from 'node:assert/strict';

import assetsHandler from '../api/assets/index.js';

function runAssetsRequest({ method = 'GET', headers = {}, query = {} } = {}) {
  return new Promise((resolve) => {
    const req = { method, headers, query };
    const response = {
      statusCode: 200,
      headers: {},
      body: null,
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value;
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
      end() {
        resolve(this);
        return this;
      }
    };
    assetsHandler(req, response);
  });
}

test('public assets discovery endpoint returns canonical asset response shape', async () => {
  const res = await runAssetsRequest();
  assert.equal(res.statusCode, 200);
  assert.ok(res.body);
  assert.ok(Array.isArray(res.body.assets));
  assert.equal(typeof res.body.count, 'number');
  assert.equal(res.body.count, res.body.assets.length);
  assert.equal(res.body.meta?.api_catalog, '/.well-known/api-catalog');
  assert.equal(res.body.meta?.service_desc, '/api/openapi.json');
  assert.equal(res.body.meta?.mcp_manifest, '/api/mcp/manifest');
  assert.equal(res.body.meta?.mcp_endpoint, '/mcp');
  assert.equal(res.body.meta?.mcp_list_tool, 'list_assets');
  assert.match(String(res.body.meta?.purchase_flow || ''), /\/api\/assets\/\{id\}\/download/);
});
