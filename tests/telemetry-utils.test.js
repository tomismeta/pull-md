import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isTelemetryEnabled,
  normalizeTelemetrySchema,
  normalizeTelemetryWindowHours,
  recordTelemetryEvent
} from '../api/_lib/telemetry.js';

test('normalizeTelemetryWindowHours clamps to supported bounds', () => {
  assert.equal(normalizeTelemetryWindowHours(undefined), 24);
  assert.equal(normalizeTelemetryWindowHours('0'), 1);
  assert.equal(normalizeTelemetryWindowHours('-5'), 1);
  assert.equal(normalizeTelemetryWindowHours('24'), 24);
  assert.equal(normalizeTelemetryWindowHours('9999'), 720);
});

test('normalizeTelemetrySchema enforces safe postgres identifiers', () => {
  assert.equal(normalizeTelemetrySchema(undefined), 'telemetry');
  assert.equal(normalizeTelemetrySchema('TELEMETRY'), 'telemetry');
  assert.equal(normalizeTelemetrySchema('telemetry_v2'), 'telemetry_v2');
  assert.equal(normalizeTelemetrySchema('bad-name'), 'telemetry');
  assert.equal(normalizeTelemetrySchema('public;drop table x'), 'telemetry');
});

test('recordTelemetryEvent returns unconfigured when no database URL is present', async () => {
  const originalMarketplaceDbUrl = process.env.MARKETPLACE_DATABASE_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPostgresUrl = process.env.POSTGRES_URL;

  delete process.env.MARKETPLACE_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;

  try {
    const result = await recordTelemetryEvent({
      eventType: 'test.event',
      success: true
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'telemetry_unconfigured');
  } finally {
    if (originalMarketplaceDbUrl === undefined) delete process.env.MARKETPLACE_DATABASE_URL;
    else process.env.MARKETPLACE_DATABASE_URL = originalMarketplaceDbUrl;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = originalPostgresUrl;
  }
});

test('telemetry kill switch disables ingestion globally', async () => {
  const originalTelemetryEnabled = process.env.TELEMETRY_ENABLED;
  const originalMarketplaceDbUrl = process.env.MARKETPLACE_DATABASE_URL;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPostgresUrl = process.env.POSTGRES_URL;

  process.env.TELEMETRY_ENABLED = 'false';
  delete process.env.MARKETPLACE_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;

  try {
    assert.equal(isTelemetryEnabled(), false);
    const result = await recordTelemetryEvent({
      eventType: 'test.event',
      success: true
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'telemetry_disabled');
  } finally {
    if (originalTelemetryEnabled === undefined) delete process.env.TELEMETRY_ENABLED;
    else process.env.TELEMETRY_ENABLED = originalTelemetryEnabled;
    if (originalMarketplaceDbUrl === undefined) delete process.env.MARKETPLACE_DATABASE_URL;
    else process.env.MARKETPLACE_DATABASE_URL = originalMarketplaceDbUrl;
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = originalPostgresUrl;
  }
});
