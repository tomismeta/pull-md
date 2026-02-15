import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyClientMode, classifyRedownloadHeaders } from '../api/souls/[id]/download.js';

const WALLET = '0xa7d395faf5e0a77a8d42d68ea01d2336671e5f55';

test('classifyRedownloadHeaders supports receipt-first primary mode', () => {
  const result = classifyRedownloadHeaders({
    headers: {
      'x-wallet-address': WALLET,
      'x-purchase-receipt': 'receipt-token'
    }
  });
  assert.equal(result.mode, 'agent_primary_receipt');
  assert.equal(result.hasAnyValidEntitlementHeaders, true);
  assert.equal(result.hasReceiptRedownloadHeaders, true);
});

test('classifyRedownloadHeaders accepts receipt cookie fallback for browser redownloads', () => {
  const result = classifyRedownloadHeaders({
    headers: {
      'x-wallet-address': WALLET
    },
    soulId: 'sassy-starter-v1',
    cookieHeader: 'soulstarter_receipt_sassy-starter-v1=receipt-cookie-token'
  });
  assert.equal(result.mode, 'agent_primary_receipt');
  assert.equal(result.hasAnyValidEntitlementHeaders, true);
  assert.equal(result.receipt, 'receipt-cookie-token');
});

test('classifyRedownloadHeaders supports session recovery mode', () => {
  const result = classifyRedownloadHeaders({
    headers: {
      'x-wallet-address': WALLET
    },
    cookieHeader: 'soulstarter_redownload_session=session-token'
  });
  assert.equal(result.mode, 'human_recovery_session');
  assert.equal(result.hasAnyValidEntitlementHeaders, true);
  assert.equal(result.hasSessionRecoveryHeaders, true);
});

test('classifyRedownloadHeaders supports signed recovery mode', () => {
  const result = classifyRedownloadHeaders({
    headers: {
      'x-wallet-address': WALLET,
      'x-auth-signature': '0xsignature',
      'x-auth-timestamp': String(Date.now())
    }
  });
  assert.equal(result.mode, 'human_recovery_signed');
  assert.equal(result.hasAnyValidEntitlementHeaders, true);
  assert.equal(result.hasSignedRecoveryHeaders, true);
});

test('classifyRedownloadHeaders rejects incomplete redownload headers', () => {
  const result = classifyRedownloadHeaders({
    headers: {
      'x-wallet-address': WALLET
    }
  });
  assert.equal(result.mode, 'invalid');
  assert.equal(result.hasAnyRedownloadHeaders, true);
  assert.equal(result.hasAnyValidEntitlementHeaders, false);
});

test('classifyRedownloadHeaders ignores cookie-only session token without wallet header', () => {
  const result = classifyRedownloadHeaders({
    headers: {},
    cookieHeader: 'soulstarter_redownload_session=session-token'
  });
  assert.equal(result.mode, 'none');
  assert.equal(result.hasAnyRedownloadHeaders, false);
});

test('classifyRedownloadHeaders ignores cookie-only receipt without wallet header', () => {
  const result = classifyRedownloadHeaders({
    headers: {},
    soulId: 'the-rock-v1',
    cookieHeader: 'soulstarter_receipt_the-rock-v1=receipt-cookie-token'
  });
  assert.equal(result.mode, 'none');
  assert.equal(result.hasAnyRedownloadHeaders, false);
});

test('classifyClientMode enables strict agent mode via X-CLIENT-MODE', () => {
  const result = classifyClientMode({
    headers: {
      'x-client-mode': 'agent'
    }
  });
  assert.equal(result.strictAgentMode, true);
  assert.equal(result.rawMode, 'agent');
});

test('classifyClientMode defaults to non-strict mode when header is absent', () => {
  const result = classifyClientMode({
    headers: {}
  });
  assert.equal(result.strictAgentMode, false);
  assert.equal(result.rawMode, '');
});
