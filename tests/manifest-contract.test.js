import test from 'node:test';
import assert from 'node:assert/strict';

import manifestHandler from '../api/mcp/manifest.js';

function runManifestRequest({ method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = { method, headers };
    const response = {
      statusCode: 200,
      headers: {},
      body: null,
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value;
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
      end() {
        resolve(this);
        return this;
      }
    };
    manifestHandler(req, response);
  });
}

test('manifest exposes strict agent guardrails and facilitator capability flags', async () => {
  const res = await runManifestRequest();
  assert.equal(res.statusCode, 200);
  const body = res.body;
  assert.ok(body);

  assert.equal(body.download_contract?.method, 'GET');
  assert.match(String(body.download_contract?.first_request || ''), /X-WALLET-ADDRESS/);
  assert.equal(body.facilitator_capabilities?.strict_agent_default_transfer_method, 'eip3009');
  assert.match(String(body.facilitator_capabilities?.note || ''), /permit2/i);
  assert.ok(body.error_codes?.x402_method_mismatch);
  assert.equal(body.error_codes?.contract_wallet_not_supported_by_facilitator, undefined);
  assert.equal(Array.isArray(body.mcp?.methods), true);
  assert.ok(body.mcp.methods.includes('prompts/list'));
  assert.ok(body.mcp.methods.includes('resources/list'));
  assert.ok((body.tools || []).some((tool) => String(tool?.name || '') === 'get_auth_challenge'));
  assert.equal(
    Array.isArray(body.tools) && body.tools.every((tool) => String(tool?.endpoint || '') === '/mcp'),
    true
  );
});
