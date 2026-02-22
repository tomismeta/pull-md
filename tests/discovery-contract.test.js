import test from 'node:test';
import assert from 'node:assert/strict';

import assetsHandler from '../api/assets/index.js';
import mcpHandler from '../api/mcp/index.js';
import manifestHandler from '../api/mcp/manifest.js';
import openApiHandler from '../api/openapi.json.js';
import apiCatalogHandler from '../api/well-known/api-catalog.js';

function runRequest(handler, { method = 'GET', headers = {}, query = {}, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, headers, query, body };
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

test('api-catalog well-known endpoint returns RFC9727 linkset and head links', async () => {
  const getRes = await runRequest(apiCatalogHandler, {
    method: 'GET',
    headers: { host: 'pull.md', 'x-forwarded-proto': 'https' }
  });
  assert.equal(getRes.statusCode, 200);
  assert.match(String(getRes.headers['content-type'] || ''), /application\/linkset\+json/i);
  assert.match(String(getRes.headers['content-type'] || ''), /rfc9727/i);
  assert.ok(Array.isArray(getRes.body?.linkset));
  assert.equal(getRes.body.linkset[0]?.anchor, 'https://pull.md/.well-known/api-catalog');
  assert.equal(
    Array.isArray(getRes.body.linkset[0]?.item) &&
      getRes.body.linkset[0].item.some((entry) => entry?.href === 'https://pull.md/mcp'),
    true
  );
  assert.ok(getRes.body.linkset.some((entry) => Array.isArray(entry?.['service-desc'])));

  const headRes = await runRequest(apiCatalogHandler, {
    method: 'HEAD',
    headers: { host: 'pull.md', 'x-forwarded-proto': 'https' }
  });
  assert.equal(headRes.statusCode, 200);
  assert.match(String(headRes.headers.link || ''), /rel="item"/);
  assert.match(String(headRes.headers.link || ''), /\/api\/assets/);
});

test('openapi endpoint exposes canonical REST paths', async () => {
  const res = await runRequest(openApiHandler, {
    method: 'GET',
    headers: { host: 'pull.md', 'x-forwarded-proto': 'https' }
  });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /openapi\+json/i);
  assert.equal(res.body?.openapi, '3.1.0');
  assert.ok(res.body?.paths?.['/api/assets']);
  assert.ok(res.body?.paths?.['/api/assets/{id}/download']);
  assert.ok(res.body?.paths?.['/api/mcp/manifest']);
});

test('core endpoints include discovery Link headers', async () => {
  const assetsRes = await runRequest(assetsHandler, {
    method: 'GET',
    headers: { host: 'pull.md', 'x-forwarded-proto': 'https' }
  });
  assert.equal(assetsRes.statusCode, 200);
  assert.match(String(assetsRes.headers.link || ''), /rel="api-catalog"/);
  assert.match(String(assetsRes.headers.link || ''), /rel="service-desc"/);

  const mcpGetRes = await runRequest(mcpHandler, {
    method: 'GET',
    headers: { host: 'pull.md', 'x-forwarded-proto': 'https' }
  });
  assert.equal(mcpGetRes.statusCode, 200);
  assert.match(String(mcpGetRes.headers.link || ''), /rel="api-catalog"/);
  assert.match(String(mcpGetRes.headers.link || ''), /\/api\/mcp\/manifest/);

  const manifestRes = await runRequest(manifestHandler, {
    method: 'GET',
    headers: { host: 'pull.md', 'x-forwarded-proto': 'https' }
  });
  assert.equal(manifestRes.statusCode, 200);
  assert.match(String(manifestRes.headers.link || ''), /rel="service-meta"/);
});
