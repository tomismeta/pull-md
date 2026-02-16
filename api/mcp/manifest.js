export default function handler(req, res) {
  const allowedOrigins = [
    'https://soulstarter.vercel.app',
    'https://soulstarter.io',
    'http://localhost:3000',
    'http://localhost:8080'
  ];

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  return res.status(200).json({
    schema_version: 'v1',
    name: 'SoulStarter',
    description: 'Agent soul marketplace with x402 payments and receipt-first redownloads',
    url: 'https://soulstarter.vercel.app',
    auth: {
      type: 'x402',
      network: 'eip155:8453',
      currency: 'USDC',
      headers: [
        'PAYMENT-SIGNATURE',
        'PAYMENT-REQUIRED',
        'PAYMENT-RESPONSE',
        'X-CLIENT-MODE',
        'X-WALLET-ADDRESS',
        'X-ASSET-TRANSFER-METHOD'
      ],
      deprecated_headers: ['PAYMENT', 'X-PAYMENT'],
      client_mode_headers: ['X-CLIENT-MODE'],
      strict_agent_mode_value: 'agent',
      redownload_headers: [
        'X-WALLET-ADDRESS',
        'X-PURCHASE-RECEIPT',
        'X-REDOWNLOAD-SIGNATURE',
        'X-REDOWNLOAD-TIMESTAMP',
        'X-REDOWNLOAD-SESSION',
        'X-AUTH-SIGNATURE',
        'X-AUTH-TIMESTAMP'
      ],
      redownload_modes: {
        agent_primary: ['X-WALLET-ADDRESS', 'X-PURCHASE-RECEIPT', 'X-REDOWNLOAD-SIGNATURE', 'X-REDOWNLOAD-TIMESTAMP'],
        human_session_recovery: ['X-WALLET-ADDRESS', 'X-REDOWNLOAD-SESSION'],
        human_signed_recovery: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP']
      },
      redownload_session_endpoint: '/api/auth/session',
      redownload_session_bootstrap_headers: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP'],
      purchase_header_preference: ['PAYMENT-SIGNATURE'],
      ownership_auth_signature_preferred: 'eip4361_siwe_message',
      ownership_auth_note:
        'Ownership checks (creator/moderator/session/agent re-download challenge) require SIWE (EIP-4361) message signatures (no token transfer/approval). EOA and EIP-1271 smart-contract wallets are supported.',
      agent_key_boundary:
        'Never send Bankr API keys or signer secrets to SoulStarter. SoulStarter accepts only signed x402 payment headers.'
    },
    facilitator_capabilities: {
      runtime_source: 'server-configured facilitator URLs',
      strict_agent_default_transfer_method: 'eip3009',
      note:
        'Current deployment defaults strict agent purchases to eip3009. permit2 can be requested explicitly but may fail upstream depending on facilitator policy.'
    },
    error_codes: {
      agent_wallet_hint_required:
        'Strict agent purchase quote missing X-WALLET-ADDRESS (or wallet_address query).',
      agent_wallet_hint_required_paid_retry:
        'Strict agent paid retry missing X-WALLET-ADDRESS (or wallet_address query).',
      x402_method_mismatch:
        'Submitted payment method branch does not match wallet-quote transfer method.',
      invalid_agent_redownload_signature:
        'Strict agent redownload SIWE signature invalid or timestamp format mismatch.',
      receipt_required_agent_mode:
        'Strict agent redownload requires receipt + challenge signature headers.'
    },
    wallet_compatibility: {
      as_of: '2026-02-14',
      supported_browser_wallets: ['MetaMask', 'Rabby', 'Bankr Wallet'],
      recommended_for_purchase: 'MetaMask or Rabby',
      bankr_status: 'experimental',
      bankr_note:
        'Bankr EIP-3009 signatures may fail USDC contract verification in this flow (FiatTokenV2: invalid signature). Prefer EmblemVault until upstream signer compatibility is fixed.'
    },
    tools: [
      {
        name: 'list_souls',
        description: 'List available souls and pricing',
        endpoint: '/api/mcp/tools/list_souls',
        method: 'GET',
        returns: { type: 'object', description: 'Soul list with metadata and pricing' }
      },
      {
        name: 'get_soul_details',
        description: 'Get full metadata, auth message examples, and purchase endpoint for one soul',
        endpoint: '/api/mcp/tools/get_soul_details',
        method: 'GET',
        parameters: {
          id: { type: 'string', required: true, description: 'Soul identifier' }
        },
        returns: { type: 'object', description: 'Soul details and x402 interaction contract' }
      },
      {
        name: 'check_entitlements',
        description: 'Verify receipt proofs for wallet re-download entitlement',
        endpoint: '/api/mcp/tools/check_entitlements',
        method: 'POST',
        parameters: {
          wallet_address: { type: 'string', required: true, description: 'Wallet to check' },
          proofs: { type: 'array', required: true, description: 'List of { soul_id, receipt } proofs' }
        },
        returns: { type: 'object', description: 'Per-proof entitlement status' }
      },
      {
        name: 'get_listing_template',
        description: 'Get immediate publish payload template for creator soul listings',
        endpoint: '/api/mcp/tools/creator_marketplace',
        method: 'GET',
        parameters: {
          action: { type: 'string', required: true, description: 'Set action=get_listing_template' }
        },
        returns: { type: 'object', description: 'Template payload for immediate creator publish contract' }
      },
      {
        name: 'publish_listing',
        description: 'Creator-auth immediate publish. Returns shareable soul URL and purchase endpoint.',
        endpoint: '/api/mcp/tools/creator_marketplace',
        method: 'POST',
        parameters: {
          action: { type: 'string', required: true, description: 'Set action=publish_listing' },
          wallet_address: { type: 'string', required: true, description: 'Creator wallet address' },
          auth_signature: { type: 'string', required: true, description: 'Wallet signature over creator auth message' },
          auth_timestamp: { type: 'number', required: true, description: 'Unix ms timestamp used in auth message' },
          listing: { type: 'object', required: true, description: 'Minimal publish payload: name, price_usdc, description, soul_markdown' }
        },
        returns: { type: 'object', description: 'Published listing summary + share_url + purchase endpoint' }
      },
      {
        name: 'list_my_published_listings',
        description: 'List creator-owned published listings (including hidden listings)',
        endpoint: '/api/mcp/tools/creator_marketplace',
        method: 'GET',
        parameters: {
          action: { type: 'string', required: true, description: 'Set action=list_my_published_listings' }
        },
        auth_headers: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP'],
        returns: { type: 'object', description: 'Wallet-scoped list of published listing summaries' }
      },
      {
        name: 'list_published_listings',
        description: 'Public list of currently visible published listings',
        endpoint: '/api/mcp/tools/creator_marketplace',
        method: 'GET',
        parameters: {
          action: { type: 'string', required: true, description: 'Set action=list_published_listings' }
        },
        returns: { type: 'object', description: 'Public listing summaries for discoverability and purchase' }
      },
      {
        name: 'list_moderators',
        description: 'List allowlisted moderator wallet addresses',
        endpoint: '/api/mcp/tools/creator_marketplace',
        method: 'GET',
        parameters: {
          action: { type: 'string', required: true, description: 'Set action=list_moderators' }
        },
        returns: { type: 'object', description: 'Allowlisted moderator wallet addresses' }
      },
      {
        name: 'list_moderation_listings',
        description: 'Moderator-only list of visible and hidden listings',
        endpoint: '/api/mcp/tools/creator_marketplace',
        method: 'GET',
        admin_only: true,
        auth_headers: ['X-MODERATOR-ADDRESS', 'X-MODERATOR-SIGNATURE', 'X-MODERATOR-TIMESTAMP'],
        parameters: {
          action: { type: 'string', required: true, description: 'Set action=list_moderation_listings' }
        },
        returns: { type: 'object', description: 'Listing partitions for moderation visibility actions' }
      },
      {
        name: 'remove_listing_visibility',
        description: 'Moderator-only action to remove a listing from public visibility',
        endpoint: '/api/mcp/tools/creator_marketplace',
        method: 'POST',
        admin_only: true,
        auth_headers: ['X-MODERATOR-ADDRESS', 'X-MODERATOR-SIGNATURE', 'X-MODERATOR-TIMESTAMP'],
        parameters: {
          action: { type: 'string', required: true, description: 'Set action=remove_listing_visibility' },
          soul_id: { type: 'string', required: true, description: 'Published soul identifier to hide' },
          reason: { type: 'string', required: false, description: 'Optional moderation reason for audit trail' }
        },
        returns: { type: 'object', description: 'Updated listing visibility state' }
      }
    ],
    download_contract: {
      canonical_base_url: 'https://soulstarter.vercel.app',
      endpoint_pattern: '/api/souls/{id}/download',
      method: 'GET',
      flow_profiles: {
        headless_agent: {
          purchase:
            'GET /api/souls/{id}/download with X-CLIENT-MODE: agent -> 402 + PAYMENT-REQUIRED -> retry with PAYMENT-SIGNATURE',
          redownload:
            'GET /api/souls/{id}/download with X-CLIENT-MODE: agent + X-WALLET-ADDRESS + X-PURCHASE-RECEIPT + X-REDOWNLOAD-SIGNATURE + X-REDOWNLOAD-TIMESTAMP'
        },
        human_browser: {
          purchase: 'Connect wallet in UI and submit x402 payment',
          redownload: 'Receipt-first, with optional session bootstrap at /api/auth/session for recovery UX'
        }
      },
      canonical_purchase_flow: 'GET /api/souls/{id}/download is the authoritative x402 flow for payment requirements and paid retry.',
      first_request:
        'No payment headers -> returns 402 + PAYMENT-REQUIRED. Include X-WALLET-ADDRESS on this first request for strict wallet binding and deterministic retries.',
      claim_request: 'Include PAYMENT-SIGNATURE with base64-encoded x402 payload to claim entitlement and download',
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
        'Headless agents should send X-CLIENT-MODE: agent + X-WALLET-ADDRESS + X-PURCHASE-RECEIPT + X-REDOWNLOAD-SIGNATURE + X-REDOWNLOAD-TIMESTAMP. Human/browser flow can use recovery mode.',
      strict_agent_mode:
        'When X-CLIENT-MODE=agent is set, re-download requires receipt plus wallet signature challenge headers. Session/auth recovery headers are rejected.',
      redownload_session_bootstrap:
        'Bootstrap session at GET /api/auth/session with X-WALLET-ADDRESS + X-AUTH-SIGNATURE + X-AUTH-TIMESTAMP to obtain X-REDOWNLOAD-SESSION.',
      anti_poisoning_rule:
        'Always verify the full PAYMENT-REQUIRED.accepts[0].payTo address against the canonical seller address from trusted SoulStarter metadata before signing.',
      redownload_priority:
        'If wallet+receipt headers are present, entitlement path is processed first (prevents accidental repay even when payment headers are also sent).',
      note: 'auth_message_template may appear in a 402 response as helper text; purchase still requires payment header submission.',
      domain_note: 'Use the canonical production host (soulstarter.vercel.app). Preview/alias domains may not reflect the latest contract behavior.',
      v2_requirement: 'Submitted payment JSON must include accepted matching PAYMENT-REQUIRED.accepts[0] exactly.',
      method_discipline:
        'Submit exactly one payload method branch. eip3009 => authorization+signature only. permit2 => permit2Authorization(+transaction)+signature only.',
      transfer_method_selection:
        'Strict agent mode defaults to eip3009. Optional explicit override: X-ASSET-TRANSFER-METHOD (eip3009|permit2).',
      facilitator_note:
        'permit2 may fail upstream depending on facilitator policy. eip3009 is the stable default in this deployment.',
      duplicate_settlement_protection:
        'Server applies single-flight settlement idempotency by payer+soul+nonce to reduce duplicate charge attempts from repeated submissions.',
      wallet_runtime_note:
        'EmblemVault currently has verified successful purchase + re-download runs. Bankr eip3009 remains experimental.',
      permit2_pitfalls: [
        'Set top-level network to accepted.network (eip155:8453), not "base".',
        'Use payload.permit2Authorization (not payload.permit2).',
        'Do not include payload.authorization in permit2 mode.',
        'Send permit2 numeric fields as strings.',
        'Set payload.transaction.data to ERC20 approve calldata; do not send empty 0x.'
      ]
    },
    contact: {
      name: 'SoulStarter Support',
      url: 'https://soulstarter.vercel.app'
    }
  });
}
