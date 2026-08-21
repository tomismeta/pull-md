import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import mcpHandler from '../api/retired.js';

async function connectWithOfficialClient() {
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
    Promise.resolve(mcpHandler(req, res)).catch((error) => {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const client = new Client({ name: 'pullmd-retirement-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));

  try {
    await client.connect(transport);
  } finally {
    await transport.close().catch(() => {});
    await client.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
}

test('official MCP SDK receives permanent HTTP 410 during initialization', async () => {
  await assert.rejects(connectWithOfficialClient, (error) => {
    assert.equal(error?.code, 410);
    assert.match(String(error?.message || ''), /PULL\.md has been retired/);
    assert.match(String(error?.message || ''), /service_retired/);
    return true;
  });
});
