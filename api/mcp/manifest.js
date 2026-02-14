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
    description: 'Agent soul marketplace with x402 payments and wallet re-authenticated redownloads',
    url: 'https://soulstarter.vercel.app',
    auth: {
      type: 'x402',
      network: 'eip155:8453',
      currency: 'USDC',
      headers: [
        'PAYMENT',
        'X-PAYMENT',
        'PAYMENT-SIGNATURE',
        'PAYMENT-REQUIRED',
        'PAYMENT-RESPONSE'
      ],
      redownload_headers: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP', 'X-PURCHASE-RECEIPT'],
      purchase_header_preference: ['PAYMENT-SIGNATURE', 'PAYMENT', 'X-PAYMENT'],
      agent_key_boundary:
        'Never send Bankr API keys or signer secrets to SoulStarter. SoulStarter accepts only signed x402 payment headers.'
    },
    wallet_compatibility: {
      as_of: '2026-02-14',
      recommended_for_purchase: 'EmblemVault',
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
        name: 'purchase_soul',
        description:
          'Initiate x402 purchase and receive PAYMENT-REQUIRED requirements. Agent signs externally (e.g. Bankr) and submits PAYMENT-SIGNATURE only.',
        endpoint: '/api/mcp/tools/purchase_soul',
        method: 'POST',
        parameters: {
          soul_id: { type: 'string', required: true, description: 'Soul identifier to purchase' },
          wallet_address: { type: 'string', required: true, description: 'Buyer wallet address' }
        },
        returns: { type: 'object', description: '402 response body + PAYMENT-REQUIRED header details' }
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
        description: 'Get marketplace creator draft template for user-uploaded soul listings',
        endpoint: '/api/mcp/tools/get_listing_template',
        method: 'GET',
        returns: { type: 'object', description: 'Template payload for creator listing draft contracts' }
      },
      {
        name: 'validate_listing_draft',
        description: 'Validate and normalize a creator-provided marketplace listing draft',
        endpoint: '/api/mcp/tools/validate_listing_draft',
        method: 'POST',
        parameters: {
          listing: { type: 'object', required: true, description: 'Listing metadata and fee split fields' },
          assets: { type: 'object', required: true, description: 'Soul markdown and optional source attribution fields' }
        },
        returns: { type: 'object', description: 'Validation outcome, normalized draft, and deterministic draft_id' }
      },
      {
        name: 'save_listing_draft',
        description: 'Save a validated creator listing draft under wallet-scoped private storage',
        endpoint: '/api/mcp/tools/save_listing_draft',
        method: 'POST',
        parameters: {
          wallet_address: { type: 'string', required: true, description: 'Creator wallet address' },
          auth_signature: { type: 'string', required: true, description: 'Wallet signature over creator auth message' },
          auth_timestamp: { type: 'number', required: true, description: 'Unix ms timestamp used in auth message' },
          draft: { type: 'object', required: true, description: 'Draft payload to validate and persist' }
        },
        returns: { type: 'object', description: 'Saved draft metadata and deterministic draft_id' }
      },
      {
        name: 'list_my_listing_drafts',
        description: 'List creator-owned saved listing drafts (wallet-authenticated)',
        endpoint: '/api/mcp/tools/list_my_listing_drafts',
        method: 'GET',
        auth_headers: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP'],
        returns: { type: 'object', description: 'Wallet-scoped list of draft summaries' }
      },
      {
        name: 'get_my_listing_draft',
        description: 'Get full creator-owned draft payload by draft_id (wallet-authenticated)',
        endpoint: '/api/mcp/tools/get_my_listing_draft',
        method: 'GET',
        parameters: {
          draft_id: { type: 'string', required: true, description: 'Draft identifier from save/validate response' }
        },
        auth_headers: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP'],
        returns: { type: 'object', description: 'Full wallet-scoped draft record' }
      },
      {
        name: 'submit_listing_for_review',
        description: 'Move a creator draft from draft state to submitted_for_review with moderation metadata',
        endpoint: '/api/mcp/tools/submit_listing_for_review',
        method: 'POST',
        parameters: {
          wallet_address: { type: 'string', required: true, description: 'Creator wallet address' },
          auth_signature: { type: 'string', required: true, description: 'Wallet signature over creator auth message' },
          auth_timestamp: { type: 'number', required: true, description: 'Unix ms timestamp used in auth message' },
          draft_id: { type: 'string', required: true, description: 'Draft identifier to submit' }
        },
        returns: { type: 'object', description: 'Draft submission status with moderation state= pending' }
      },
      {
        name: 'review_listing_submission',
        description: 'Admin-only moderation decision for submitted creator drafts (approve or reject)',
        endpoint: '/api/mcp/tools/review_listing_submission',
        method: 'POST',
        admin_only: true,
        auth_headers: ['X-ADMIN-TOKEN'],
        parameters: {
          wallet_address: { type: 'string', required: true, description: 'Creator wallet address owning the draft' },
          draft_id: { type: 'string', required: true, description: 'Draft identifier under review' },
          decision: { type: 'string', required: true, description: 'approve | reject' },
          reviewer: { type: 'string', required: false, description: 'Optional reviewer id/name for audit trail' },
          notes: { type: 'string', required: false, description: 'Optional moderation notes' }
        },
        returns: { type: 'object', description: 'Updated draft moderation state and resulting status' }
      }
    ],
    download_contract: {
      canonical_base_url: 'https://soulstarter.vercel.app',
      endpoint_pattern: '/api/souls/{id}/download',
      method: 'GET',
      canonical_purchase_flow: 'GET /api/souls/{id}/download is the authoritative x402 flow for payment requirements and paid retry.',
      first_request: 'No payment headers -> returns 402 + PAYMENT-REQUIRED',
      claim_request: 'Include PAYMENT-SIGNATURE (or PAYMENT/X-PAYMENT) with base64-encoded x402 payload to claim entitlement and download',
      redownload_request: 'Include X-WALLET-ADDRESS, X-AUTH-SIGNATURE, X-AUTH-TIMESTAMP, and X-PURCHASE-RECEIPT',
      anti_poisoning_rule:
        'Always verify the full PAYMENT-REQUIRED.accepts[0].payTo address against the canonical seller address from trusted SoulStarter metadata before signing.',
      redownload_priority:
        'If re-download headers are present, entitlement path is processed first (prevents accidental repay even when payment headers are also sent).',
      note: 'auth_message_template may appear in a 402 response as helper text; purchase still requires payment header submission.',
      domain_note: 'Use the canonical production host (soulstarter.vercel.app). Preview/alias domains may not reflect the latest contract behavior.',
      v2_requirement: 'Submitted payment JSON must include accepted matching PAYMENT-REQUIRED.accepts[0] exactly.',
      method_discipline:
        'Submit exactly one payload method branch. eip3009 => authorization+signature only. permit2 => permit2Authorization(+transaction)+signature only.',
      cdp_default:
        'CDP Base mainnet path defaults to eip3009 in this deployment. If permit2 is disabled by facilitator policy, re-sign as eip3009.',
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
