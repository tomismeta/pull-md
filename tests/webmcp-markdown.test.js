import test from 'node:test';
import assert from 'node:assert/strict';

import webmcpMarkdownHandler from '../api/mcp/webmcp_markdown.js';

function runRequest({ method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = { method, headers };
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
    webmcpMarkdownHandler(req, response);
  });
}

test('WEBMCP markdown endpoint is generated from manifest contract', async () => {
  const res = await runRequest();
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type'] || ''), /text\/markdown/i);
  const body = String(res.body || '');
  assert.match(body, /^# PULL\.md WebMCP Contract/m);
  assert.match(body, /GET \/\.well-known\/api-catalog/);
  assert.match(body, /GET \/api\/openapi\.json/);
  assert.match(body, /GET \/api\/mcp\/manifest/);
  assert.match(body, /GET \/api\/assets\/\{id\}\/download/);
  assert.match(body, /## Flow Visualizations/);
  assert.match(body, /### Creator Publish \(MCP\)/);
  assert.match(body, /### Purchase \+ Re-download \(REST\)/);
  assert.doesNotMatch(body, /GET \/api\/souls\/\{id\}\/download/);
  assert.doesNotMatch(body, /\/api\/mcp\/tools\/purchase_soul/);
});
