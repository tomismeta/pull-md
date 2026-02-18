import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import mcpHandler from '../api/mcp/index.js';

function runMcpRequest({ method = 'POST', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      Promise.resolve(mcpHandler(req, res)).catch((error) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error || 'unknown')
            })
          );
        } else {
          res.end();
        }
      });
    });

    server.listen(0, '127.0.0.1', async () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const url = `http://127.0.0.1:${port}/mcp`;
      const requestHeaders = {
        ...(method === 'POST'
          ? { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
          : {}),
        ...headers
      };
      const requestBody = body == null ? undefined : JSON.stringify(body);

      try {
        const response = await fetch(url, {
          method,
          headers: requestHeaders,
          body: requestBody
        });
        const text = await response.text();
        let parsedBody = null;
        if (text) {
          try {
            parsedBody = JSON.parse(text);
          } catch (_) {
            parsedBody = text;
          }
        }
        resolve({
          statusCode: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: parsedBody
        });
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
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
        capabilities: {},
        clientInfo: { name: 'mcp-jsonrpc-test', version: '1.0.0' }
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
  assert.ok(names.includes('list_assets'));
  assert.ok(names.includes('get_asset_details'));
  assert.ok(names.includes('list_souls'));
  assert.ok(names.includes('get_soul_details'));
  assert.ok(names.includes('get_auth_challenge'));
  assert.ok(names.includes('publish_listing'));
  assert.ok(names.includes('remove_listing_visibility'));

  const publishTool = (res.body?.result?.tools || []).find((tool) => String(tool?.name || '') === 'publish_listing');
  assert.ok(publishTool);
  const listingSchema = publishTool?.inputSchema?.properties?.listing || {};
  assert.equal(Array.isArray(listingSchema.required), true);
  assert.ok(listingSchema.required.includes('name'));
  assert.ok(listingSchema.required.includes('description'));
  assert.ok(listingSchema.required.includes('price_usdc'));
  assert.equal(Array.isArray(listingSchema.anyOf), true);
  assert.ok(listingSchema.anyOf.some((rule) => Array.isArray(rule?.required) && rule.required.includes('content_markdown')));
  assert.ok(listingSchema.anyOf.some((rule) => Array.isArray(rule?.required) && rule.required.includes('soul_markdown')));
  assert.equal(publishTool?.inputSchema?.properties?.dry_run?.type, 'boolean');
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

test('MCP get_auth_challenge returns suggested listing for creator publish action', async () => {
  const res = await runMcpRequest({
    body: {
      jsonrpc: '2.0',
      id: 34,
      method: 'tools/call',
      params: {
        name: 'get_auth_challenge',
        arguments: {
          flow: 'creator',
          action: 'publish_listing',
          wallet_address: '0x2420888eAaA361c0e919C4F942D154BD47924793'
        }
      }
    }
  });
  assert.equal(res.statusCode, 200);
  const payload = res.body?.result?.structuredContent || {};
  assert.equal(payload.ok, true);
  assert.equal(typeof payload?.suggested_listing?.name, 'string');
  assert.equal(typeof payload?.suggested_listing?.soul_markdown, 'string');
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
  assert.ok(promptNames.includes('purchase_asset'));
  assert.ok(promptNames.includes('redownload_asset'));
  assert.ok(promptNames.includes('purchase_soul'));
  assert.ok(promptNames.includes('redownload_soul'));

  const getRes = await runMcpRequest({
    body: {
      jsonrpc: '2.0',
      id: 6,
      method: 'prompts/get',
      params: {
        name: 'purchase_asset',
        arguments: { asset_id: 'the-rock-v1', wallet_address: '0x2420888eaaa361c0e919c4f942d154bd47924793' }
      }
    }
  });
  assert.equal(getRes.statusCode, 200);
  assert.equal(String(getRes.body?.result?.name || ''), 'purchase_asset');
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
  assert.ok(resources.some((item) => String(item?.uri || '') === 'soulstarter://assets'));

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
