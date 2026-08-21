import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import os from 'os';
import path from 'path';

import downloadHandler from '../api/assets/[id]/download.js';
import {
  REDOWNLOAD_GRACE_END_AT,
  RETIRED_AT,
  buildRetirementProblem,
  evaluateRetiredDownloadAccess
} from '../api/_lib/retirement.js';
import manifestHandler from '../api/mcp/manifest.js';
import { createPurchaseReceipt } from '../api/_lib/payments.js';
import retiredHandler from '../api/retired.js';

function runRequest(handler, { method = 'GET', headers = {}, query = {}, body = {}, url = '/' } = {}) {
  return new Promise((resolve, reject) => {
    const req = { method, headers, query, body, url };
    const response = {
      statusCode: 200,
      headers: {},
      body: null,
      setHeader(key, value) {
        this.headers[String(key).toLowerCase()] = value;
      },
      getHeader(key) {
        return this.headers[String(key).toLowerCase()];
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

test('retirement problem is a stable HTTP 410 contract', async () => {
  const res = await runRequest(retiredHandler, {
    method: 'GET',
    headers: { host: 'pull.md', 'x-forwarded-proto': 'https' },
    query: { path: 'api/openapi.json' },
    url: '/api/openapi.json'
  });

  assert.equal(res.statusCode, 410);
  assert.match(String(res.headers['content-type'] || ''), /application\/problem\+json/i);
  assert.equal(res.headers['x-pullmd-retired'], 'true');
  assert.equal(res.body?.code, 'service_retired');
  assert.equal(res.body?.status, 410);
  assert.equal(res.body?.retired_at, RETIRED_AT);
  assert.equal(res.body?.redownload_grace?.ends_at, REDOWNLOAD_GRACE_END_AT);
  assert.equal(res.body?.service_status?.new_purchases, 'retired');
});

test('MCP, catalog, and manifest handlers are retired', async () => {
  const requests = await Promise.all([
    runRequest(retiredHandler, {
      method: 'POST',
      headers: { host: 'pull.md', 'x-forwarded-proto': 'https' },
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
      url: '/mcp'
    }),
    runRequest(retiredHandler, {
      headers: { host: 'pull.md', 'x-forwarded-proto': 'https' },
      url: '/api/assets'
    }),
    runRequest(manifestHandler, {
      headers: { host: 'pull.md', 'x-forwarded-proto': 'https' },
      url: '/api/mcp/manifest'
    })
  ]);

  for (const res of requests) {
    assert.equal(res.statusCode, 410);
    assert.equal(res.body?.code, 'service_retired');
  }
});

test('retirement gate allows only existing entitlement recovery before cutoff', () => {
  const beforeCutoff = Date.parse('2026-09-01T00:00:00.000Z');
  const afterCutoff = Date.parse('2026-09-22T00:00:00.000Z');

  assert.deepEqual(
    evaluateRetiredDownloadAccess({ hasExistingEntitlementProof: true, now: beforeCutoff }),
    { allowed: true, reason: 'existing_entitlement_grace' }
  );
  assert.deepEqual(
    evaluateRetiredDownloadAccess({ hasExistingEntitlementProof: false, now: beforeCutoff }),
    { allowed: false, reason: 'new_purchases_disabled' }
  );
  assert.deepEqual(
    evaluateRetiredDownloadAccess({ hasExistingEntitlementProof: true, now: afterCutoff }),
    { allowed: false, reason: 'redownload_grace_ended' }
  );
});

test('download endpoint refuses new quotes and paid retries before loading payment infrastructure', async () => {
  const priorBundled = process.env.ENABLE_BUNDLED_SOULS;
  process.env.ENABLE_BUNDLED_SOULS = '1';
  try {
    const scenarios = [
      { assetId: 'meta-starter-v1', extraHeaders: {} },
      { assetId: 'meta-starter-v1', extraHeaders: { 'payment-signature': 'not-a-settlement' } },
      { assetId: 'not-a-real-asset', extraHeaders: {} }
    ];
    for (const { assetId, extraHeaders } of scenarios) {
      const res = await runRequest(downloadHandler, {
        method: 'GET',
        headers: { host: 'pull.md', 'x-forwarded-proto': 'https', ...extraHeaders },
        query: { id: assetId },
        url: `/api/assets/${assetId}/download`
      });
      assert.equal(res.statusCode, 410);
      assert.equal(res.body?.code, 'service_retired');
      assert.equal(res.body?.service_status?.new_purchases, 'retired');
      assert.match(String(res.headers['cache-control'] || ''), /private, no-store/);
    }
  } finally {
    if (priorBundled === undefined) delete process.env.ENABLE_BUNDLED_SOULS;
    else process.env.ENABLE_BUNDLED_SOULS = priorBundled;
  }
});

test('valid existing receipt still delivers markdown during the recovery window', async () => {
  const envKeys = [
    'DATABASE_URL',
    'ENABLE_BUNDLED_SOULS',
    'MARKETPLACE_DATABASE_URL',
    'MARKETPLACE_DRAFTS_DIR',
    'POSTGRES_URL',
    'PURCHASE_RECEIPT_SECRET',
    'SELLER_ADDRESS',
    'VERCEL'
  ];
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'pullmd-retirement-test-'));
  const wallet = '0x1111111111111111111111111111111111111111';

  try {
    process.env.DATABASE_URL = '';
    process.env.MARKETPLACE_DATABASE_URL = '';
    process.env.POSTGRES_URL = '';
    process.env.VERCEL = '';
    process.env.ENABLE_BUNDLED_SOULS = '1';
    process.env.MARKETPLACE_DRAFTS_DIR = tempDir;
    process.env.PURCHASE_RECEIPT_SECRET = 'retirement-recovery-test-secret';
    process.env.SELLER_ADDRESS = '0x2222222222222222222222222222222222222222';

    const receipt = createPurchaseReceipt({
      wallet,
      assetId: 'meta-starter-v1',
      transaction: `0x${'a'.repeat(64)}`
    });
    const res = await runRequest(downloadHandler, {
      method: 'GET',
      headers: {
        host: 'pull.md',
        'x-forwarded-proto': 'https',
        'x-wallet-address': wallet,
        'x-purchase-receipt': receipt
      },
      query: { id: 'meta-starter-v1' },
      url: '/api/assets/meta-starter-v1/download'
    });

    assert.equal(res.statusCode, 200);
    assert.match(String(res.headers['content-type'] || ''), /text\/markdown/i);
    assert.match(String(res.headers['content-disposition'] || ''), /meta-starter-v1-SOUL\.md/);
    assert.match(String(res.body || ''), /^# /m);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  }
});

test('Vercel routing sends all public API and discovery surfaces to retirement handler', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const routes = config.routes || [];
  const routeMap = new Map(routes.map((route) => [route.src, route.dest]));

  assert.match(String(routeMap.get('/mcp') || ''), /retired\.js/);
  assert.match(String(routeMap.get('/api/(.*)') || ''), /retired\.js/);
  assert.match(String(routeMap.get('/\\.well-known/(.*)') || ''), /retired\.js/);
  assert.equal(
    routes.find((route) => route.src === '/api/assets/([^/]+)/download')?.dest,
    '/api/assets/[id]/download.js?id=$1'
  );
});

test('retirement deployment contains only three serverless entrypoints', () => {
  const apiRoot = path.resolve(new URL('../api/', import.meta.url).pathname);
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === '_lib') continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(path.relative(apiRoot, fullPath).split(path.sep).join('/'));
      }
    }
  };
  walk(apiRoot);

  assert.deepEqual(files.sort(), [
    'assets/[id]/download.js',
    'mcp/manifest.js',
    'retired.js'
  ]);
});

test('retirement problem marks recovery unavailable after cutoff', () => {
  const problem = buildRetirementProblem({
    baseUrl: 'https://pull.md',
    path: '/mcp',
    now: Date.parse('2026-09-22T00:00:00.000Z')
  });
  assert.equal(problem.redownload_grace.available, false);
  assert.equal(problem.service_status.existing_entitlement_recovery, 'retired');
  assert.match(problem.detail, /grace period has ended/i);
});
