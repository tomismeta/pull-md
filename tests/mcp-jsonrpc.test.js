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
  assert.ok(names.includes('get_auth_challenge'));
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

test('MCP get_auth_challenge returns SIWE template and timestamp guidance', async () => {
  const res = await runMcpRequest({
    body: {
      jsonrpc: '2.0',
      id: 33,
      method: 'tools/call',
      params: {
        name: 'get_auth_challenge',
        arguments: {
          flow: 'creator',
          action: 'list_my_published_listings',
          wallet_address: '0x2420888eAaA361c0e919C4F942D154BD47924793'
        }
      }
    }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.result?.isError, undefined);
  const payload = res.body?.result?.structuredContent || {};
  assert.equal(payload.ok, true);
  assert.equal(payload.flow, 'creator');
  assert.equal(typeof payload.auth_message_template, 'string');
  assert.match(String(payload.timestamp_requirement || ''), /Date\.parse/i);
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

test('MCP prompts/list and prompts/get return workflow helpers', async () => {
  const listRes = await runMcpRequest({
    body: {
      jsonrpc: '2.0',
      id: 5,
      method: 'prompts/list',
      params: {}
    }
  });
  assert.equal(listRes.statusCode, 200);
  const promptNames = (listRes.body?.result?.prompts || []).map((item) => String(item?.name || ''));
  assert.ok(promptNames.includes('purchase_soul'));
  assert.ok(promptNames.includes('redownload_soul'));

  const getRes = await runMcpRequest({
    body: {
      jsonrpc: '2.0',
      id: 6,
      method: 'prompts/get',
      params: {
        name: 'purchase_soul',
        arguments: { soul_id: 'the-rock-v1', wallet_address: '0x2420888eaaa361c0e919c4f942d154bd47924793' }
      }
    }
  });
  assert.equal(getRes.statusCode, 200);
  assert.equal(String(getRes.body?.result?.name || ''), 'purchase_soul');
  assert.equal(Array.isArray(getRes.body?.result?.messages), true);
});

test('MCP resources/list and resources/read expose discoverable URIs', async () => {
  const listRes = await runMcpRequest({
    body: {
      jsonrpc: '2.0',
      id: 7,
      method: 'resources/list',
      params: {}
    }
  });
  assert.equal(listRes.statusCode, 200);
  const resources = listRes.body?.result?.resources || [];
  assert.equal(Array.isArray(resources), true);
  assert.ok(resources.some((item) => String(item?.uri || '') === 'soulstarter://docs/manifest'));

  const readRes = await runMcpRequest({
    body: {
      jsonrpc: '2.0',
      id: 8,
      method: 'resources/read',
      params: {
        uri: 'soulstarter://docs/manifest'
      }
    }
  });
  assert.equal(readRes.statusCode, 200);
  const contents = readRes.body?.result?.contents || [];
  assert.equal(Array.isArray(contents), true);
  assert.equal(String(contents[0]?.uri || ''), 'soulstarter://docs/manifest');
});
