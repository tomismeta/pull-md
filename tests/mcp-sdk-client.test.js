import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import mcpHandler from '../api/mcp/index.js';

function ensureResponseHelpers(res) {
  if (typeof res.status !== 'function') {
    res.status = function status(code) {
      this.statusCode = code;
      return this;
    };
  }
  if (typeof res.json !== 'function') {
    res.json = function json(payload) {
      if (!this.headersSent) this.setHeader('Content-Type', 'application/json');
      this.end(JSON.stringify(payload));
      return this;
    };
  }
}

async function withMcpSdkClient(run) {
  const server = http.createServer((req, res) => {
    ensureResponseHelpers(res);
    Promise.resolve(mcpHandler(req, res)).catch((error) => {
      if (!res.headersSent) {
        res.status(500).json({ error: error instanceof Error ? error.message : String(error || 'unknown_error') });
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);

  const client = new Client({ name: 'soulstarter-sdk-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: {
        Accept: 'application/json, text/event-stream'
      }
    }
  });

  try {
    await client.connect(transport);
    return await run({ client, transport });
  } finally {
    try {
      await transport.close();
    } catch (_) {
      // noop
    }
    try {
      await client.close();
    } catch (_) {
      // noop
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

test('official MCP SDK client can connect and execute SoulStarter tools/resources', async () => {
  await withMcpSdkClient(async ({ client }) => {
    const tools = await client.listTools();
    const toolNames = (tools?.tools || []).map((tool) => String(tool?.name || ''));
    assert.ok(toolNames.includes('list_assets'));
    assert.ok(toolNames.includes('list_souls'));
    assert.ok(toolNames.includes('get_auth_challenge'));

    const listAssetsResult = await client.callTool({
      name: 'list_assets',
      arguments: {}
    });
    assert.equal(listAssetsResult?.isError, undefined);
    assert.equal(Array.isArray(listAssetsResult?.structuredContent?.assets), true);

    const resources = await client.listResources();
    const resourceUris = (resources?.resources || []).map((item) => String(item?.uri || ''));
    assert.ok(resourceUris.includes('soulstarter://docs/manifest'));
    assert.ok(resourceUris.includes('soulstarter://assets'));

    const read = await client.readResource({ uri: 'soulstarter://docs/manifest' });
    assert.equal(Array.isArray(read?.contents), true);
    assert.equal(String(read?.contents?.[0]?.uri || ''), 'soulstarter://docs/manifest');
  });
});

test('official MCP SDK client receives structured tool errors for unknown tool names', async () => {
  await withMcpSdkClient(async ({ client }) => {
    const result = await client.callTool({
      name: 'unknown_tool',
      arguments: {}
    });
    assert.equal(result?.isError, true);
    assert.equal(String(result?.structuredContent?.code || ''), 'mcp_tool_not_found');
  });
});
