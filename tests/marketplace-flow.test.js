import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { ethers } from 'ethers';

import {
  buildModeratorAuthMessage,
  buildCreatorAuthMessage,
  getMarketplaceDraftTemplate,
  listModeratorWallets,
  listPublishedListingSummaries,
  publishCreatorListingDirect,
  setListingVisibility,
  verifyCreatorAuth,
  verifyModeratorAuth
} from '../api/_lib/marketplace.js';

test('immediate publish + visibility removal flow', async () => {
  const originalCwd = process.cwd();
  const originalDraftDir = process.env.MARKETPLACE_DRAFTS_DIR;
  const originalModerators = process.env.MODERATOR_WALLETS;
  const originalMarketplaceDbUrl = process.env.MARKETPLACE_DATABASE_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPostgresUrl = process.env.POSTGRES_URL;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'soulstarter-marketplace-test-'));
  process.chdir(tempDir);
  process.env.MARKETPLACE_DRAFTS_DIR = path.join(tempDir, '.marketplace-drafts');
  process.env.MODERATOR_WALLETS = '0x1111111111111111111111111111111111111111';
  delete process.env.MARKETPLACE_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;

  try {
    const { getSoul, getSoulResolved, listSouls, listSoulsResolved, loadSoulContent } = await import(
      `../api/_lib/catalog.js?test=${Date.now()}`
    );

    const creatorWallet = ethers.Wallet.createRandom();
    const template = getMarketplaceDraftTemplate();
    template.name = 'Creator Alpha';
    template.description = 'Focused assistant for product launch execution.';
    template.price_usdc = 0.31;
    template.soul_markdown = '# SOUL\n\nAct decisively.\nShip clearly.';

    const creatorTs = Date.now();
    const creatorMsg = buildCreatorAuthMessage({
      wallet: creatorWallet.address,
      action: 'publish_listing',
      timestamp: creatorTs
    });
    const creatorSig = await creatorWallet.signMessage(creatorMsg);
    const creatorAuth = verifyCreatorAuth({
      wallet: creatorWallet.address,
      timestamp: creatorTs,
      signature: creatorSig,
      action: 'publish_listing'
    });
    assert.equal(creatorAuth.ok, true);
    assert.equal(creatorAuth.wallet, creatorWallet.address.toLowerCase());

    const publish = await publishCreatorListingDirect({
      walletAddress: creatorAuth.wallet,
      payload: template
    });
    assert.equal(publish.ok, true);
    assert.equal(publish.listing.soul_id, 'creator-alpha-v1');
    assert.equal(publish.listing.visibility, 'public');
    assert.equal(publish.listing.price_micro_usdc, '310000');
    assert.ok(String(publish.listing.share_path).startsWith('/soul.html?id='));

    const publishedPublic = await listPublishedListingSummaries({ includeHidden: false });
    assert.equal(publishedPublic.some((item) => item.soul_id === 'creator-alpha-v1'), true);
    const publishedByCreator = await listPublishedListingSummaries({
      includeHidden: true,
      publishedBy: creatorAuth.wallet
    });
    assert.equal(publishedByCreator.length, 1);

    const promoted = getSoul('creator-alpha-v1');
    assert.ok(promoted);
    const resolvedSoul = await getSoulResolved('creator-alpha-v1');
    assert.ok(resolvedSoul);
    const listed = listSouls().find((item) => item.id === 'creator-alpha-v1');
    assert.ok(listed);
    assert.equal(listed.price.amount, '0.31');
    assert.equal(listed.payment_protocol, 'x402');
    const resolvedListed = (await listSoulsResolved()).find((item) => item.id === 'creator-alpha-v1');
    assert.ok(resolvedListed);
    const resolvedContent = await loadSoulContent('creator-alpha-v1');
    assert.equal(resolvedContent, '# SOUL\n\nAct decisively.\nShip clearly.');

    const moderatorWallet = ethers.Wallet.createRandom();
    process.env.MODERATOR_WALLETS = moderatorWallet.address;
    const moderatorTs = Date.now();
    const moderatorMsg = buildModeratorAuthMessage({
      wallet: moderatorWallet.address,
      action: 'remove_listing_visibility',
      timestamp: moderatorTs
    });
    const moderatorSig = await moderatorWallet.signMessage(moderatorMsg);
    const moderatorAuth = verifyModeratorAuth({
      wallet: moderatorWallet.address,
      timestamp: moderatorTs,
      signature: moderatorSig,
      action: 'remove_listing_visibility'
    });
    assert.equal(moderatorAuth.ok, true);
    assert.equal(moderatorAuth.wallet, moderatorWallet.address.toLowerCase());
    assert.deepEqual(listModeratorWallets(), [moderatorWallet.address.toLowerCase()]);

    const hidden = await setListingVisibility({
      soulId: 'creator-alpha-v1',
      visibility: 'hidden',
      moderator: moderatorAuth.wallet,
      reason: 'policy violation test'
    });
    assert.equal(hidden.ok, true);
    assert.equal(hidden.listing.visibility, 'hidden');

    const afterHidePublic = await listPublishedListingSummaries({ includeHidden: false });
    assert.equal(afterHidePublic.some((item) => item.soul_id === 'creator-alpha-v1'), false);

    const afterHideCreator = await listPublishedListingSummaries({
      includeHidden: true,
      publishedBy: creatorAuth.wallet
    });
    assert.equal(afterHideCreator.length, 1);
    assert.equal(afterHideCreator[0].visibility, 'hidden');

    const nowMissing = await getSoulResolved('creator-alpha-v1');
    assert.equal(nowMissing, null);

    const auditPath = path.join(tempDir, '.marketplace-drafts', 'review-audit.jsonl');
    const auditRaw = await readFile(auditPath, 'utf8');
    assert.ok(auditRaw.includes('"event":"publish_direct"'));
    assert.ok(auditRaw.includes('"event":"visibility_hidden"'));
  } finally {
    process.chdir(originalCwd);
    if (originalDraftDir === undefined) delete process.env.MARKETPLACE_DRAFTS_DIR;
    else process.env.MARKETPLACE_DRAFTS_DIR = originalDraftDir;
    if (originalModerators === undefined) delete process.env.MODERATOR_WALLETS;
    else process.env.MODERATOR_WALLETS = originalModerators;
    if (originalMarketplaceDbUrl === undefined) delete process.env.MARKETPLACE_DATABASE_URL;
    else process.env.MARKETPLACE_DATABASE_URL = originalMarketplaceDbUrl;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = originalPostgresUrl;
    await rm(tempDir, { recursive: true, force: true });
  }
});
