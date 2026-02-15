import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyRedownloadHeaders } from '../api/souls/[id]/download.js';

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
