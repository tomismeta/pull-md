import test from 'node:test';
import assert from 'node:assert/strict';

import mcpHandler from '../api/mcp/index.js';

function runMcpRequest({ method = 'POST', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const req = { method, headers, body };
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
    Promise.resolve(mcpHandler(req, response)).catch((error) => {
      resolve({
        statusCode: 500,
        headers: {},
        body: { error: error instanceof Error ? error.message : String(error || 'unknown') }
      });
    });
  });
}

test('MCP initialize returns protocol capabilities over streamable HTTP', async () => {
  const res = await runMcpRequest({
    body: {
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {}
      }
    }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.jsonrpc, '2.0');
  assert.equal(res.body?.id, 'init-1');
  assert.equal(res.body?.result?.protocolVersion, '2025-06-18');
  assert.equal(typeof res.body?.result?.serverInfo?.name, 'string');
  assert.equal(typeof res.body?.result?.capabilities?.tools, 'object');
});

test('MCP tools/list exposes expected tool names', async () => {
  const res = await runMcpRequest({
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    }
  });
  assert.equal(res.statusCode, 200);
  const names = (res.body?.result?.tools || []).map((tool) => String(tool?.name || ''));
  assert.ok(names.includes('list_souls'));
  assert.ok(names.includes('get_soul_details'));
  assert.ok(names.includes('publish_listing'));
  assert.ok(names.includes('remove_listing_visibility'));
});

test('MCP tools/call executes list_souls and returns structured content', async () => {
  const res = await runMcpRequest({
    body: {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'list_souls',
        arguments: {}
      }
    }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.jsonrpc, '2.0');
  assert.equal(res.body?.id, 3);
  assert.equal(res.body?.result?.isError, undefined);
  assert.equal(Array.isArray(res.body?.result?.structuredContent?.souls), true);
});

test('MCP tools/call returns tool error payload for unknown tool', async () => {
  const res = await runMcpRequest({
    body: {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'unknown_tool',
        arguments: {}
      }
    }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.result?.isError, true);
  assert.equal(res.body?.result?.structuredContent?.code, 'mcp_tool_not_found');
});

test('MCP notifications/initialized supports notification-style no-id request', async () => {
  const res = await runMcpRequest({
    body: {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {}
    }
  });
  assert.equal(res.statusCode, 202);
});

