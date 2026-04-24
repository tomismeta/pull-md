import { enabledAssetTypes } from './asset_metadata.js';
import { getFacilitatorRuntimeInfo } from './x402.js';

const DISCOVERY_ROUTES = Object.freeze({
  homepage: '/',
  api_catalog: '/.well-known/api-catalog',
  openapi: '/api/openapi.json',
  mcp_manifest: '/api/mcp/manifest',
  mcp_server_card: '/.well-known/mcp/server-card.json',
  agent_skills: '/.well-known/agent-skills/index.json',
  webmcp_markdown: '/WEBMCP.md',
  mcp_transport: '/mcp',
  public_catalog: '/api/assets',
  canonical_purchase_endpoint_pattern: '/api/assets/{id}/download'
});

function withBaseUrl(baseUrl, route) {
  return baseUrl ? `${baseUrl}${route}` : route;
}

export function buildDiscoveryUrls(baseUrl = '') {
  return Object.fromEntries(
    Object.entries(DISCOVERY_ROUTES).map(([key, route]) => [key, withBaseUrl(baseUrl, route)])
  );
}

export function buildDiscoveryLinkEntries(baseUrl = '') {
  const routes = buildDiscoveryUrls(baseUrl);
  return [
    { href: routes.api_catalog, rel: 'api-catalog', type: 'application/linkset+json' },
    { href: routes.openapi, rel: 'service-desc', type: 'application/vnd.oai.openapi+json;version=3.1' },
    { href: routes.webmcp_markdown, rel: 'service-doc', type: 'text/markdown' },
    { href: routes.mcp_manifest, rel: 'service-meta', type: 'application/json' },
    { href: routes.public_catalog, rel: 'item', type: 'application/json' }
  ];
}

export function buildMarketplaceProfile() {
  return {
    enabled_asset_types: enabledAssetTypes(),
    ethos: ['plain_text_first', 'portable', 'diff_friendly', 'agent_ready', 'human_readable']
  };
}

export function buildCommerceContract() {
  return {
    commerce_site: true,
    payment_protocols: ['x402'],
    public_catalog_endpoint: DISCOVERY_ROUTES.public_catalog,
    canonical_purchase_endpoint_pattern: DISCOVERY_ROUTES.canonical_purchase_endpoint_pattern,
    paywall_status_code: 402,
    payment_headers: {
      required_response_header: 'PAYMENT-REQUIRED',
      required_request_header: 'PAYMENT-SIGNATURE',
      settlement_response_header: 'PAYMENT-RESPONSE'
    },
    asset_discovery_fields: ['purchase_endpoint', 'payment_protocol'],
    facilitator_discovery:
      'Paid asset routes declare x402 Bazaar discovery metadata for facilitator-side indexing when the active facilitator supports Bazaar.'
  };
}

export function buildAuthContract() {
  return {
    type: 'x402',
    payment_protocol: 'x402',
    identity_auth: 'siwe_eip4361',
    oauth2_supported: false,
    oidc_supported: false,
    oauth_discovery_note:
      'OAuth/OIDC discovery metadata is intentionally absent in this deployment: protected flows do not use bearer tokens. Wallet identity/auth uses SIWE (EIP-4361); payment and entitlement delivery use x402 plus receipt-bound headers.',
    network: 'eip155:8453',
    currency: 'USDC',
    headers: [
      'PAYMENT-SIGNATURE',
      'PAYMENT-REQUIRED',
      'PAYMENT-RESPONSE',
      'X-CLIENT-MODE',
      'X-WALLET-ADDRESS',
      'X-ASSET-TRANSFER-METHOD',
      'X-BLOCKCHAIN-TRANSACTION'
    ],
    deprecated_headers: ['PAYMENT', 'X-PAYMENT'],
    client_mode_headers: ['X-CLIENT-MODE'],
    strict_agent_mode_value: 'agent',
    redownload_headers: [
      'X-WALLET-ADDRESS',
      'X-PURCHASE-RECEIPT',
      'X-BLOCKCHAIN-TRANSACTION',
      'X-REDOWNLOAD-SIGNATURE',
      'X-REDOWNLOAD-TIMESTAMP',
      'X-REDOWNLOAD-SESSION',
      'X-AUTH-SIGNATURE',
      'X-AUTH-TIMESTAMP'
    ],
    redownload_modes: {
      agent_primary: ['X-WALLET-ADDRESS', 'X-PURCHASE-RECEIPT', 'X-REDOWNLOAD-SIGNATURE', 'X-REDOWNLOAD-TIMESTAMP'],
      agent_transaction_reference: ['X-WALLET-ADDRESS', 'X-BLOCKCHAIN-TRANSACTION', 'X-REDOWNLOAD-SIGNATURE', 'X-REDOWNLOAD-TIMESTAMP'],
      human_session_recovery: ['X-WALLET-ADDRESS', 'X-REDOWNLOAD-SESSION'],
      human_signed_recovery: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP']
    },
    redownload_session_endpoint: '/api/auth/session',
    redownload_session_bootstrap_headers: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP'],
    purchase_header_preference: ['PAYMENT-SIGNATURE'],
    ownership_auth_signature_preferred: 'eip4361_siwe_message',
    ownership_auth_note:
      'Ownership checks (creator/moderator/session/agent re-download challenge) require SIWE (EIP-4361) message signatures (no token transfer/approval). EOA and EIP-1271 smart-contract wallets are supported.',
    ownership_auth_timestamp_formats: ['unix_ms', 'iso8601'],
    ownership_auth_message_tolerance: ['lf', 'crlf', 'trailing_newline'],
    ownership_auth_timestamp_rule:
      'Use auth_timestamp = Date.parse(Issued At) from the same auth_message_template. Do not use current wall-clock timestamp.',
    purchase_receipt_security:
      'Persist X-PURCHASE-RECEIPT securely per wallet+asset. Treat it as sensitive proof material. Never publish, share, or store in plaintext logs.',
    blockchain_transaction_recovery:
      'X-BLOCKCHAIN-TRANSACTION is a secondary recovery input. It must match the authoritative wallet+asset entitlement record and pass on-chain receipt verification; it does not mint fresh entitlement by itself.',
    common_auth_mistakes: [
      'Using Date.now() instead of Date.parse(Issued At)',
      'Reconstructing SIWE text manually instead of signing exact template',
      'Wallet casing mismatch between signed message and submitted fields'
    ],
    agent_key_boundary:
      'Never send Bankr API keys or signer secrets to PULL.md. PULL.md accepts only signed x402 payment headers.'
  };
}

export function buildFacilitatorCapabilities() {
  const runtime = getFacilitatorRuntimeInfo();
  return {
    runtime_source: 'server-configured facilitator URLs',
    facilitator_urls: runtime.urls,
    strict_agent_default_transfer_method: 'eip3009',
    note:
      'Current deployment defaults strict agent purchases to eip3009. permit2 can be requested explicitly but may fail upstream depending on facilitator policy.'
  };
}

export function buildDownloadContract(baseUrl = '') {
  const routes = buildDiscoveryUrls(baseUrl);
  return {
    canonical_base_url: baseUrl,
    endpoint_pattern: DISCOVERY_ROUTES.canonical_purchase_endpoint_pattern,
    method: 'GET',
    flow_profiles: {
      headless_agent: {
        purchase:
          'GET /api/assets/{id}/download with X-CLIENT-MODE: agent -> 402 + PAYMENT-REQUIRED -> retry with PAYMENT-SIGNATURE',
        redownload:
          'GET /api/assets/{id}/download with X-CLIENT-MODE: agent + X-WALLET-ADDRESS + (X-PURCHASE-RECEIPT or X-BLOCKCHAIN-TRANSACTION) + X-REDOWNLOAD-SIGNATURE + X-REDOWNLOAD-TIMESTAMP'
      },
      human_browser: {
        purchase: 'Connect wallet in UI and submit x402 payment',
        redownload: 'Receipt-first, with optional session bootstrap at /api/auth/session for recovery UX'
      }
    },
    canonical_purchase_flow:
      'GET /api/assets/{id}/download is the authoritative x402 flow for payment requirements and paid retry.',
    first_request:
      'No payment headers -> returns 402 + PAYMENT-REQUIRED. Include X-WALLET-ADDRESS on this first request for strict wallet binding and deterministic retries.',
    claim_request: 'Include PAYMENT-SIGNATURE with base64-encoded x402 payload to claim entitlement and download',
    receipt_persistence:
      'Persist X-PURCHASE-RECEIPT from successful 200 responses in secure storage keyed by wallet+asset. Also retain the settlement transaction hash from PAYMENT-RESPONSE or X-BLOCKCHAIN-TRANSACTION as a non-secret recovery pointer.',
    signing_instructions_field:
      '402 response bodies include payment_signing_instructions with transfer-method-specific required/forbidden fields and typed-data primary type.',
    payment_payload_contract: {
      top_level_required: ['x402Version', 'scheme', 'network', 'accepted', 'payload'],
      eip3009_payload_required: ['payload.authorization', 'payload.signature'],
      eip3009_payload_forbidden: ['payload.authorization.signature', 'payload.permit2Authorization', 'payload.transaction'],
      notes: [
        'accepted must exactly equal PAYMENT-REQUIRED.accepts[0]',
        'scheme/network must be top-level (not nested under payload)'
      ]
    },
    redownload_request:
      'Headless agents should send X-CLIENT-MODE: agent + X-WALLET-ADDRESS + (X-PURCHASE-RECEIPT or X-BLOCKCHAIN-TRANSACTION) + X-REDOWNLOAD-SIGNATURE + X-REDOWNLOAD-TIMESTAMP. Human/browser flow can use recovery mode.',
    strict_agent_mode:
      'When X-CLIENT-MODE=agent is set, re-download requires receipt plus wallet signature challenge headers. Session/auth recovery headers are rejected.',
    redownload_session_bootstrap:
      'Bootstrap session at GET /api/auth/session with X-WALLET-ADDRESS + X-AUTH-SIGNATURE + X-AUTH-TIMESTAMP to obtain X-REDOWNLOAD-SESSION.',
    anti_poisoning_rule:
      'Always verify the full PAYMENT-REQUIRED.accepts[0].payTo address against the canonical seller address from trusted PULL.md metadata before signing.',
    redownload_priority:
      'If wallet+receipt headers are present, entitlement path is processed first (prevents accidental repay even when payment headers are also sent).',
    note: 'auth_message_template may appear in a 402 response as helper text; purchase still requires payment header submission.',
    domain_note: 'Use the canonical production host (pull.md or current deployment host). Preview/alias domains may not reflect the latest contract behavior.',
    v2_requirement: 'Submitted payment JSON must include accepted matching PAYMENT-REQUIRED.accepts[0] exactly.',
    method_discipline:
      'Submit exactly one payload method branch. eip3009 => authorization+signature only. permit2 => permit2Authorization(+transaction)+signature only.',
    transfer_method_selection:
      'Strict agent mode defaults to eip3009. Optional explicit override: X-ASSET-TRANSFER-METHOD (eip3009|permit2).',
    facilitator_note:
      'permit2 may fail upstream depending on facilitator policy. eip3009 is the stable default in this deployment.',
    duplicate_settlement_protection:
      'Server applies single-flight settlement idempotency by payer+asset+nonce to reduce duplicate charge attempts from repeated submissions.',
    wallet_runtime_note:
      'EmblemVault currently has verified successful purchase + re-download runs. Bankr eip3009 remains experimental.',
    auth_challenge_recommendation:
      'For creator/moderator/session/redownload auth, call MCP tool get_auth_challenge first, then sign the exact auth_message_template and set auth_timestamp = Date.parse(Issued At).',
    contract_sources: {
      public_catalog: routes.public_catalog,
      manifest: routes.mcp_manifest,
      openapi: routes.openapi,
      service_doc: routes.webmcp_markdown
    },
    permit2_pitfalls: [
      'Set top-level network to accepted.network (eip155:8453), not "base".',
      'Use payload.permit2Authorization (not payload.permit2).',
      'Do not include payload.authorization in permit2 mode.',
      'Send permit2 numeric fields as strings.',
      'Set payload.transaction.data to ERC20 approve calldata; do not send empty 0x.'
    ]
  };
}

export function buildPublicAssetsMeta(baseUrl = '') {
  const routes = buildDiscoveryUrls(baseUrl);
  const commerce = buildCommerceContract();
  return {
    discovery: 'public_catalog',
    commerce_site: commerce.commerce_site,
    payment_protocol: commerce.payment_protocols[0],
    api_catalog: routes.api_catalog,
    service_desc: routes.openapi,
    mcp_manifest: routes.mcp_manifest,
    mcp_endpoint: routes.mcp_transport,
    mcp_list_tool: 'list_assets',
    enabled_asset_types: enabledAssetTypes(),
    purchase_flow: 'GET /api/assets/{id}/download -> 402 PAYMENT-REQUIRED -> retry with PAYMENT-SIGNATURE',
    canonical_purchase_endpoint_pattern: routes.canonical_purchase_endpoint_pattern,
    paywall_status_code: commerce.paywall_status_code,
    payment_headers: ['PAYMENT-REQUIRED', 'PAYMENT-SIGNATURE', 'PAYMENT-RESPONSE'],
    purchase_endpoint_field: 'purchase_endpoint',
    payment_protocol_field: 'payment_protocol'
  };
}
