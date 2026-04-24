import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

test('asset entitlements persist to local file store and upsert by wallet+asset', async () => {
  const originalDraftDir = process.env.MARKETPLACE_DRAFTS_DIR;
  const originalVercel = process.env.VERCEL;
  const originalMarketplaceDbUrl = process.env.MARKETPLACE_DATABASE_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPostgresUrl = process.env.POSTGRES_URL;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pullmd-entitlements-test-'));
  process.env.MARKETPLACE_DRAFTS_DIR = tempDir;
  delete process.env.VERCEL;
  delete process.env.MARKETPLACE_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;

  try {
    const module = await import(`../api/_lib/entitlements.js?test=${Date.now()}`);
    const walletAddress = '0xa7d395faf5e0a77a8d42d68ea01d2336671e5f55';
    const assetId = 'creator-alpha-v1';

    await module.recordAssetEntitlement({
      walletAddress,
      assetId,
      transactionRef: '0xabc123',
      source: 'purchase',
      metadata: { transfer_method: 'eip3009' }
    });

    const first = await module.getAssetEntitlement({ walletAddress, assetId });
    assert.equal(first?.wallet_address, walletAddress);
    assert.equal(first?.asset_id, assetId);
    assert.equal(first?.transaction_ref, '0xabc123');
    assert.equal(first?.source, 'purchase');
    assert.equal(first?.metadata?.transfer_method, 'eip3009');

    await module.recordAssetEntitlement({
      walletAddress,
      assetId,
      transactionRef: '0xdef456',
      source: 'receipt',
      metadata: { imported: true }
    });

    module.clearEntitlementCache();
    const second = await module.getAssetEntitlement({ walletAddress, assetId });
    assert.equal(second?.transaction_ref, '0xdef456');
    assert.equal(second?.source, 'receipt');
    assert.equal(second?.metadata?.imported, true);
  } finally {
    if (originalDraftDir === undefined) delete process.env.MARKETPLACE_DRAFTS_DIR;
    else process.env.MARKETPLACE_DRAFTS_DIR = originalDraftDir;
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
    if (originalMarketplaceDbUrl === undefined) delete process.env.MARKETPLACE_DATABASE_URL;
    else process.env.MARKETPLACE_DATABASE_URL = originalMarketplaceDbUrl;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = originalPostgresUrl;
    await rm(tempDir, { recursive: true, force: true });
  }
});
