import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../db/migrations');

test('database migration modules are ordered and valid', async () => {
  const entries = (await fs.readdir(migrationsDir))
    .filter((name) => name.endsWith('.js') && !name.startsWith('_'))
    .sort();

  assert.deepEqual(entries, [
    '001-marketplace-core.js',
    '002-telemetry-core.js',
    '003-security-scan-store.js',
    '004-entitlements.js'
  ]);

  const ids = [];
  for (const entry of entries) {
    const mod = await import(pathToFileURL(path.join(migrationsDir, entry)).href);
    assert.equal(typeof mod.id, 'string');
    assert.equal(typeof mod.description, 'string');
    assert.equal(typeof mod.up, 'function');
    ids.push(mod.id);
  }

  assert.equal(new Set(ids).size, ids.length);
});
