import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAuthContract,
  buildCommerceContract,
  buildDiscoveryUrls,
  buildDownloadContract,
  buildPublicAssetsMeta
} from '../api/_lib/public_contract.js';

test('shared public contract keeps discovery and commerce surfaces aligned', () => {
  const baseUrl = 'https://pull.md';
  const discovery = buildDiscoveryUrls(baseUrl);
  const commerce = buildCommerceContract();
  const auth = buildAuthContract();
  const download = buildDownloadContract(baseUrl);
  const assetsMeta = buildPublicAssetsMeta();

  assert.equal(discovery.api_catalog, 'https://pull.md/.well-known/api-catalog');
  assert.equal(discovery.openapi, 'https://pull.md/api/openapi.json');
  assert.equal(discovery.mcp_manifest, 'https://pull.md/api/mcp/manifest');
  assert.equal(discovery.canonical_purchase_endpoint_pattern, 'https://pull.md/api/assets/{id}/download');

  assert.equal(commerce.commerce_site, true);
  assert.deepEqual(commerce.payment_protocols, ['x402']);
  assert.equal(commerce.canonical_purchase_endpoint_pattern, '/api/assets/{id}/download');

  assert.equal(auth.payment_protocol, 'x402');
  assert.equal(auth.identity_auth, 'siwe_eip4361');
  assert.equal(auth.oauth2_supported, false);

  assert.equal(download.endpoint_pattern, '/api/assets/{id}/download');
  assert.equal(download.contract_sources.public_catalog, 'https://pull.md/api/assets');
  assert.equal(download.contract_sources.manifest, 'https://pull.md/api/mcp/manifest');
  assert.equal(download.contract_sources.openapi, 'https://pull.md/api/openapi.json');

  assert.equal(assetsMeta.api_catalog, '/.well-known/api-catalog');
  assert.equal(assetsMeta.service_desc, '/api/openapi.json');
  assert.equal(assetsMeta.mcp_manifest, '/api/mcp/manifest');
  assert.equal(assetsMeta.canonical_purchase_endpoint_pattern, '/api/assets/{id}/download');
});
