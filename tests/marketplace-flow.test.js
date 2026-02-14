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
  publishCreatorDraft,
  reviewCreatorDraft,
  submitCreatorDraftForReview,
  upsertCreatorDraft,
  validateMarketplaceDraft,
  verifyCreatorAuth,
  verifyModeratorAuth
} from '../api/_lib/marketplace.js';

test('marketplace draft validation, moderation, and publish promotion flow', async () => {
  const originalCwd = process.cwd();
  const originalDraftDir = process.env.MARKETPLACE_DRAFTS_DIR;
  const originalModerators = process.env.MODERATOR_WALLETS;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'soulstarter-marketplace-test-'));
  process.chdir(tempDir);
  process.env.MARKETPLACE_DRAFTS_DIR = path.join(tempDir, '.marketplace-drafts');
  process.env.MODERATOR_WALLETS = '0x1111111111111111111111111111111111111111';

  try {
    const { getSoul, listSouls } = await import(`../api/_lib/catalog.js?test=${Date.now()}`);

    const template = getMarketplaceDraftTemplate();
    template.listing.soul_id = 'creator-alpha-v1';
    template.listing.name = 'Creator Alpha';
    template.listing.description = 'Focused assistant for product launch execution.';
    template.listing.long_description = 'Structured planning + decisive execution + concise reporting.';
    template.listing.category = 'operations';
    template.listing.soul_type = 'hybrid';
    template.listing.price_usdc = 0.31;
    template.listing.seller_address = '0x1111111111111111111111111111111111111111';
    template.assets.soul_markdown = '# SOUL\n\nAct decisively.\nShip clearly.';

    const validated = validateMarketplaceDraft(template);
    assert.equal(validated.ok, true);
    assert.ok(validated.draft_id.startsWith('draft_'));
    assert.equal(validated.normalized.listing.price_micro_usdc, '310000');

    const wallet = ethers.Wallet.createRandom();
    const ts = Date.now();
    const authMsg = buildCreatorAuthMessage({
      wallet: wallet.address,
      action: 'save_listing_draft',
      timestamp: ts
    });
    const signature = await wallet.signMessage(authMsg);
    const auth = verifyCreatorAuth({
      wallet: wallet.address,
      timestamp: ts,
      signature,
      action: 'save_listing_draft'
    });
    assert.equal(auth.ok, true);
    assert.equal(auth.wallet, wallet.address.toLowerCase());

    const moderatorWallet = ethers.Wallet.createRandom();
    process.env.MODERATOR_WALLETS = moderatorWallet.address;
    const moderatorTs = Date.now();
    const moderatorMsg = buildModeratorAuthMessage({
      wallet: moderatorWallet.address,
      action: 'list_review_queue',
      timestamp: moderatorTs
    });
    const moderatorSig = await moderatorWallet.signMessage(moderatorMsg);
    const moderatorAuth = verifyModeratorAuth({
      wallet: moderatorWallet.address,
      timestamp: moderatorTs,
      signature: moderatorSig,
      action: 'list_review_queue'
    });
    assert.equal(moderatorAuth.ok, true);
    assert.equal(moderatorAuth.wallet, moderatorWallet.address.toLowerCase());
    assert.deepEqual(listModeratorWallets(), [moderatorWallet.address.toLowerCase()]);

    const saved = await upsertCreatorDraft({
      walletAddress: auth.wallet,
      normalizedDraft: validated.normalized,
      draftId: validated.draft_id
    });
    assert.equal(saved.status, 'draft');

    const submitted = await submitCreatorDraftForReview({
      walletAddress: auth.wallet,
      draftId: validated.draft_id
    });
    assert.equal(submitted.ok, true);
    assert.equal(submitted.draft.status, 'submitted_for_review');
    assert.equal(submitted.draft.moderation.state, 'pending');

    const reviewed = await reviewCreatorDraft({
      walletAddress: auth.wallet,
      draftId: validated.draft_id,
      decision: 'approve',
      reviewer: 'qa-admin',
      notes: 'Looks good'
    });
    assert.equal(reviewed.ok, true);
    assert.equal(reviewed.draft.status, 'approved_for_publish');
    assert.equal(reviewed.draft.moderation.state, 'approved');

    const published = await publishCreatorDraft({
      walletAddress: auth.wallet,
      draftId: validated.draft_id,
      reviewer: 'qa-admin',
      notes: 'Published for test'
    });
    assert.equal(published.ok, true);
    assert.equal(published.draft.status, 'published');

    const promoted = getSoul('creator-alpha-v1');
    assert.ok(promoted);
    assert.equal(promoted.sellerAddress, '0x1111111111111111111111111111111111111111');
    const listed = listSouls().find((item) => item.id === 'creator-alpha-v1');
    assert.ok(listed);
    assert.equal(listed.price.amount, '0.31');
    assert.equal(listed.payment_protocol, 'x402');

    const auditPath = path.join(tempDir, '.marketplace-drafts', 'review-audit.jsonl');
    const auditRaw = await readFile(auditPath, 'utf8');
    assert.ok(auditRaw.includes('"event":"submit_for_review"'));
    assert.ok(auditRaw.includes('"event":"review_decision"'));
    assert.ok(auditRaw.includes('"event":"publish"'));

  } finally {
    process.chdir(originalCwd);
    if (originalDraftDir === undefined) delete process.env.MARKETPLACE_DRAFTS_DIR;
    else process.env.MARKETPLACE_DRAFTS_DIR = originalDraftDir;
    if (originalModerators === undefined) delete process.env.MODERATOR_WALLETS;
    else process.env.MODERATOR_WALLETS = originalModerators;
    await rm(tempDir, { recursive: true, force: true });
  }
});
