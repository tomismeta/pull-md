import test from 'node:test';
import assert from 'node:assert/strict';

import webmcpMarkdownHandler from '../api/mcp/webmcp_markdown.js';

function runRequest() {
  return new Promise((resolve, reject) => {
    const req = {
      method: 'GET',
      headers: { host: 'pull.md', 'x-forwarded-proto': 'https' },
      query: {},
      url: '/WEBMCP.md'
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
      end(payload) {
        if (payload !== undefined) this.body = payload;
        resolve(this);
        return this;
      }
    };
    Promise.resolve(webmcpMarkdownHandler(req, response)).catch(reject);
  });
}

test('former WebMCP contract endpoint returns the retirement problem', async () => {
  const res = await runRequest();
  assert.equal(res.statusCode, 410);
  assert.match(String(res.headers['content-type'] || ''), /application\/problem\+json/i);
  assert.equal(res.body?.code, 'service_retired');
  assert.equal(res.body?.service_status?.mcp, 'retired');
});
