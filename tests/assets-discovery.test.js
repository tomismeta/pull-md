import test from 'node:test';
import assert from 'node:assert/strict';

import assetsHandler from '../api/retired.js';

function runAssetsRequest({ method = 'GET', headers = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, headers, query, url: '/api/assets' };
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
      end(payload) {
        if (payload !== undefined) this.body = payload;
        resolve(this);
        return this;
      }
    };
    Promise.resolve(assetsHandler(req, response)).catch(reject);
  });
}

test('public asset discovery is permanently retired', async () => {
  const res = await runAssetsRequest({
    headers: { host: 'pull.md', 'x-forwarded-proto': 'https' }
  });
  assert.equal(res.statusCode, 410);
  assert.match(String(res.headers['content-type'] || ''), /application\/problem\+json/i);
  assert.equal(res.headers['x-pullmd-retired'], 'true');
  assert.equal(res.body?.code, 'service_retired');
  assert.equal(res.body?.service_status?.new_purchases, 'retired');
});

test('asset discovery HEAD preserves the 410 status without a body', async () => {
  const res = await runAssetsRequest({
    method: 'HEAD',
    headers: { host: 'pull.md', 'x-forwarded-proto': 'https' }
  });
  assert.equal(res.statusCode, 410);
  assert.equal(res.body, null);
  assert.equal(res.headers['x-pullmd-retired'], 'true');
});
