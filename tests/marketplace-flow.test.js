import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { ethers } from 'ethers';

import {
  buildModeratorAuthMessage,
  buildCreatorAuthMessage,
  deletePublishedListingByModerator,
  getMarketplaceDraftTemplate,
  listModerationListingDetails,
  listModeratorWallets,
  listPublishedListingSummaries,
  publishCreatorListingDirect,
  setListingVisibility,
  updatePublishedListingByModerator,
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

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pullmd-marketplace-test-'));
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
    assert.ok(String(publish.listing.share_path).startsWith('/asset.html?id='));

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

    const unhidden = await setListingVisibility({
      soulId: 'creator-alpha-v1',
      visibility: 'public',
      moderator: moderatorAuth.wallet
    });
    assert.equal(unhidden.ok, true);
    assert.equal(unhidden.listing.visibility, 'public');

    const updated = await updatePublishedListingByModerator({
      soulId: 'creator-alpha-v1',
      moderator: moderatorAuth.wallet,
      updates: {
        listing: {
          name: 'Creator Alpha Revised',
          description: 'Updated by moderator for catalog quality.',
          price_usdc: 0.42,
          content_markdown: '# SOUL\\n\\nModerator update content.'
        }
      }
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.listing.name, 'Creator Alpha Revised');
    assert.equal(updated.listing.price_micro_usdc, '420000');

    const moderationRows = await listModerationListingDetails();
    const revised = moderationRows.find((item) => item.soul_id === 'creator-alpha-v1');
    assert.ok(revised);
    assert.equal(revised.visibility, 'public');
    assert.equal(String(revised.content_markdown || '').includes('Moderator update content.'), true);

    const deleted = await deletePublishedListingByModerator({
      soulId: 'creator-alpha-v1',
      moderator: moderatorAuth.wallet,
      reason: 'cleanup test'
    });
    assert.equal(deleted.ok, true);

    const afterDelete = await listPublishedListingSummaries({ includeHidden: true });
    assert.equal(afterDelete.some((item) => item.soul_id === 'creator-alpha-v1'), false);

    const auditPath = path.join(tempDir, '.marketplace-drafts', 'review-audit.jsonl');
    const auditRaw = await readFile(auditPath, 'utf8');
    assert.ok(auditRaw.includes('"event":"publish_direct"'));
    assert.ok(auditRaw.includes('"event":"visibility_hidden"'));
    assert.ok(auditRaw.includes('"event":"visibility_public"'));
    assert.ok(auditRaw.includes('"event":"moderator_edit"'));
    assert.ok(auditRaw.includes('"event":"moderator_delete"'));
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

test('publishCreatorListingDirect dry_run returns field-level errors and does not persist listings', async () => {
  const originalCwd = process.cwd();
  const originalDraftDir = process.env.MARKETPLACE_DRAFTS_DIR;
  const originalMarketplaceDbUrl = process.env.MARKETPLACE_DATABASE_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPostgresUrl = process.env.POSTGRES_URL;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pullmd-marketplace-dryrun-test-'));
  process.chdir(tempDir);
  process.env.MARKETPLACE_DRAFTS_DIR = path.join(tempDir, '.marketplace-drafts');
  delete process.env.MARKETPLACE_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;

  try {
    const wallet = ethers.Wallet.createRandom();
    const invalid = await publishCreatorListingDirect({
      walletAddress: wallet.address.toLowerCase(),
      payload: {
        name: 'x',
        description: 'short',
        price_usdc: 0
      },
      dryRun: true
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.code, 'validation_failed');
    assert.equal(Array.isArray(invalid.field_errors), true);
    assert.ok(invalid.field_errors.some((item) => String(item?.field || '') === 'listing.soul_markdown'));

    const template = getMarketplaceDraftTemplate();
    template.name = 'Dry Run Soul';
    template.description = 'This listing is only validated and not persisted.';
    template.price_usdc = 0.05;
    template.soul_markdown = '# SOUL\n\nDry-run validation only.';

    const validDryRun = await publishCreatorListingDirect({
      walletAddress: wallet.address.toLowerCase(),
      payload: template,
      dryRun: true
    });
    assert.equal(validDryRun.ok, true);
    assert.equal(validDryRun.code, 'validated');

    const listings = await listPublishedListingSummaries({
      includeHidden: true,
      publishedBy: wallet.address.toLowerCase()
    });
    assert.equal(listings.length, 0);
  } finally {
    process.chdir(originalCwd);
    if (originalDraftDir === undefined) delete process.env.MARKETPLACE_DRAFTS_DIR;
    else process.env.MARKETPLACE_DRAFTS_DIR = originalDraftDir;
    if (originalMarketplaceDbUrl === undefined) delete process.env.MARKETPLACE_DATABASE_URL;
    else process.env.MARKETPLACE_DATABASE_URL = originalMarketplaceDbUrl;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = originalPostgresUrl;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('catalog fallback reads Vercel draft directory when MARKETPLACE_DRAFTS_DIR is unset', async () => {
  const originalCwd = process.cwd();
  const originalDraftDir = process.env.MARKETPLACE_DRAFTS_DIR;
  const originalVercel = process.env.VERCEL;
  const originalMarketplaceDbUrl = process.env.MARKETPLACE_DATABASE_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPostgresUrl = process.env.POSTGRES_URL;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pullmd-vercel-catalog-test-'));
  process.chdir(tempDir);
  delete process.env.MARKETPLACE_DRAFTS_DIR;
  process.env.VERCEL = '1';
  delete process.env.MARKETPLACE_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  const vercelCatalogPath = '/tmp/pullmd-marketplace-drafts/published-catalog.json';
  let existingVercelCatalog = null;

  try {
    await mkdir('/tmp/pullmd-marketplace-drafts', { recursive: true });
    try {
      existingVercelCatalog = await readFile(vercelCatalogPath, 'utf8');
    } catch (_) {}
    const catalogPayload = {
      schema_version: 'published-catalog-v1',
      entries: [
        {
          id: 'vercel-catalog-soul-v1',
          name: 'Vercel Catalog Soul',
          description: 'Visible listing from Vercel fallback dir.',
          longDescription: 'Visible listing from Vercel fallback dir.',
          icon: 'VC',
          category: 'creator',
          tags: ['creator'],
          priceMicroUsdc: '120000',
          priceDisplay: '$0.12',
          provenance: { type: 'hybrid', raised_by: 'Creator', days_nurtured: 0 },
          compatibility: { runtimes: ['OpenClaw'], min_memory: '8MB', min_context: 4000 },
          preview: 'Visible listing from Vercel fallback dir.',
          contentInline: '# SOUL\n\nVercel fallback content.',
          sellerAddress: '0x7f46acb709cd8df5879f84915ca431fb740989e4',
          publishedBy: '0x7f46acb709cd8df5879f84915ca431fb740989e4',
          publishedAt: new Date().toISOString(),
          draftId: 'pub_test',
          sharePath: '/soul.html?id=vercel-catalog-soul-v1',
          visibility: 'public'
        }
      ]
    };
    await writeFile(vercelCatalogPath, JSON.stringify(catalogPayload, null, 2), 'utf8');

    const { listSoulsResolved, getSoulResolved, loadSoulContent } = await import(`../api/_lib/catalog.js?test=${Date.now()}`);
    const listed = (await listSoulsResolved()).find((item) => item.id === 'vercel-catalog-soul-v1');
    assert.ok(listed);
    const soul = await getSoulResolved('vercel-catalog-soul-v1');
    assert.ok(soul);
    const content = await loadSoulContent('vercel-catalog-soul-v1', { soul });
    assert.equal(content, '# SOUL\n\nVercel fallback content.');
  } finally {
    process.chdir(originalCwd);
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
    if (existingVercelCatalog !== null) {
      await writeFile(vercelCatalogPath, existingVercelCatalog, 'utf8');
    } else {
      await rm(vercelCatalogPath, { force: true });
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('creator auth accepts ISO timestamp and CRLF SIWE message variant', async () => {
  const wallet = ethers.Wallet.createRandom();
  const ts = Date.now();
  const iso = new Date(ts).toISOString();
  const base = buildCreatorAuthMessage({
    wallet: wallet.address,
    action: 'list_my_published_listings',
    timestamp: ts
  });
  const signature = await wallet.signMessage(base.replace(/\n/g, '\r\n'));
  const checked = verifyCreatorAuth({
    wallet: wallet.address,
    timestamp: iso,
    signature,
    action: 'list_my_published_listings'
  });
  assert.equal(checked.ok, true);
  assert.equal(checked.wallet, wallet.address.toLowerCase());
  assert.equal(checked.auth_format, 'siwe');
});

test('moderator auth accepts ISO timestamp and trailing newline SIWE message variant', async () => {
  const originalModerators = process.env.MODERATOR_WALLETS;
  const wallet = ethers.Wallet.createRandom();
  process.env.MODERATOR_WALLETS = wallet.address;
  try {
    const ts = Date.now();
    const iso = new Date(ts).toISOString();
    const base = buildModeratorAuthMessage({
      wallet: wallet.address,
      action: 'list_moderation_listings',
      timestamp: ts
    });
    const signature = await wallet.signMessage(`${base}\n`);
    const checked = verifyModeratorAuth({
      wallet: wallet.address,
      timestamp: iso,
      signature,
      action: 'list_moderation_listings'
    });
    assert.equal(checked.ok, true);
    assert.equal(checked.wallet, wallet.address.toLowerCase());
    assert.equal(checked.auth_format, 'siwe');
  } finally {
    if (originalModerators === undefined) delete process.env.MODERATOR_WALLETS;
    else process.env.MODERATOR_WALLETS = originalModerators;
  }
});
