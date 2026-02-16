import test from 'node:test';
import assert from 'node:assert/strict';

import soulsHandler from '../api/souls/index.js';

function runSoulsRequest({ method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = { method, headers };
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
    soulsHandler(req, response);
  });
}

test('public souls discovery endpoint returns a stable response shape', async () => {
  const res = await runSoulsRequest();
  assert.equal(res.statusCode, 200);
  assert.ok(res.body);
  assert.ok(Array.isArray(res.body.souls));
  assert.equal(typeof res.body.count, 'number');
  assert.equal(res.body.count, res.body.souls.length);
  assert.equal(res.body.meta?.mcp_manifest, '/api/mcp/manifest');
});

