import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPgSslConfig, normalizePgIdentifier, qualifyPgRelation } from '../api/_lib/db.js';

test('normalizePgIdentifier falls back for invalid identifiers', () => {
  assert.equal(normalizePgIdentifier('telemetry', 'public'), 'telemetry');
  assert.equal(normalizePgIdentifier('Telemetry_1', 'public'), 'telemetry_1');
  assert.equal(normalizePgIdentifier('bad-schema!', 'public'), 'public');
});

test('qualifyPgRelation uses normalized schema name', () => {
  assert.equal(qualifyPgRelation('Telemetry', 'marketplace_telemetry_events'), 'telemetry.marketplace_telemetry_events');
  assert.equal(qualifyPgRelation('', 'asset_entitlements'), 'public.asset_entitlements');
});

test('buildPgSslConfig infers verified TLS for managed postgres hosts', () => {
  delete process.env.TEST_SSL;
  delete process.env.TEST_SSL_INSECURE;
  const ssl = buildPgSslConfig({
    rawConnectionString: 'postgres://user:pass@db.neon.tech/pullmd',
    sslEnv: 'TEST_SSL',
    insecureSslEnv: 'TEST_SSL_INSECURE',
    caCertEnv: 'TEST_SSL_CA'
  });
  assert.equal(ssl?.rejectUnauthorized, true);
});

test('buildPgSslConfig honors explicit insecure override', () => {
  process.env.TEST_SSL = 'true';
  process.env.TEST_SSL_INSECURE = 'true';
  try {
    const ssl = buildPgSslConfig({
      rawConnectionString: 'postgres://user:pass@localhost/pullmd',
      sslEnv: 'TEST_SSL',
      insecureSslEnv: 'TEST_SSL_INSECURE',
      caCertEnv: 'TEST_SSL_CA'
    });
    assert.equal(ssl?.rejectUnauthorized, false);
  } finally {
    delete process.env.TEST_SSL;
    delete process.env.TEST_SSL_INSECURE;
  }
});
