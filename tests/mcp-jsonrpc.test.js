import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import mcpHandler from '../api/mcp/index.js';

function runMcpRequest({ method = 'POST', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.status = function status(code) {
        this.statusCode = code;
        return this;
      };
      res.json = function json(payload) {
        this.setHeader('Content-Type', 'application/json');
        this.end(JSON.stringify(payload));
        return this;
      };
      Promise.resolve(mcpHandler(req, res)).catch(reject);
    });

    server.listen(0, '127.0.0.1', async () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method,
          headers: {
            ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
            ...headers
          },
          body: body == null ? undefined : JSON.stringify(body)
        });
        resolve({
          statusCode: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: method === 'HEAD' ? null : await response.json()
        });
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

test('MCP initialize returns permanent retirement response', async () => {
  const res = await runMcpRequest({
    body: {
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {} }
    }
  });
  assert.equal(res.statusCode, 410);
  assert.equal(res.body?.code, 'service_retired');
  assert.equal(res.body?.service_status?.mcp, 'retired');
  assert.equal(res.headers['x-pullmd-retired'], 'true');
});

test('MCP metadata GET also returns HTTP 410', async () => {
  const res = await runMcpRequest({ method: 'GET' });
  assert.equal(res.statusCode, 410);
  assert.equal(res.body?.status, 410);
  assert.match(String(res.headers.sunset || ''), /21 Sep 2026/);
});
