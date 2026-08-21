import test from 'node:test';
import assert from 'node:assert/strict';

import manifestHandler from '../api/mcp/manifest.js';

function runManifestRequest({ method = 'GET', headers = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, headers, query, url: '/api/mcp/manifest' };
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
    Promise.resolve(manifestHandler(req, response)).catch(reject);
  });
}

test('MCP manifest returns the permanent retirement contract', async () => {
  const res = await runManifestRequest({
    headers: { host: 'pull.md', 'x-forwarded-proto': 'https' }
  });
  assert.equal(res.statusCode, 410);
  assert.equal(res.body?.code, 'service_retired');
  assert.equal(res.body?.service_status?.mcp, 'retired');
  assert.equal(res.body?.redownload_grace?.endpoint_pattern, '/api/assets/{id}/download');
  assert.equal(res.body?.tools, undefined);
  assert.equal(res.body?.discovery, undefined);
});
