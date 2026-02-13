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
        name: 'list_owned_souls',
        description: 'Build wallet Soul Locker inventory from purchase receipt proofs',
        endpoint: '/api/mcp/tools/list_owned_souls',
        method: 'POST',
        parameters: {
          wallet_address: { type: 'string', required: true, description: 'Wallet to check' },
          receipts: { type: 'array', required: true, description: 'List of purchase receipt tokens' }
        },
        returns: { type: 'object', description: 'Owned soul inventory with invalid proof diagnostics' }
      },
      {
        name: 'set_active_soul',
        description: 'Set active soul for a wallet from a verified receipt and return a signed soul session token',
        endpoint: '/api/mcp/tools/set_active_soul',
        method: 'POST',
        parameters: {
          wallet_address: { type: 'string', required: true, description: 'Wallet to update' },
          soul_id: { type: 'string', required: true, description: 'Soul to activate' },
          receipt: { type: 'string', required: true, description: 'Purchase receipt for soul_id' },
          previous_soul_id: { type: 'string', required: false, description: 'Currently active soul id (optional)' },
          previous_receipt: { type: 'string', required: false, description: 'Purchase receipt for previous_soul_id' }
        },
        returns: { type: 'object', description: 'Active soul, rollback metadata, and soul_session_token' }
      },
      {
        name: 'get_active_soul_status',
        description: 'Resolve active/previous soul from soul_session_token for frictionless switching',
        endpoint: '/api/mcp/tools/get_active_soul_status',
        method: 'POST',
        parameters: {
          wallet_address: { type: 'string', required: true, description: 'Wallet to resolve' },
          soul_session_token: { type: 'string', required: true, description: 'Token returned by set_active_soul' }
        },
        returns: { type: 'object', description: 'Current active soul status and redownload contract' }
      },
      {
        name: 'rollback_active_soul',
        description: 'Rollback to previous active soul from soul_session_token and previous soul receipt',
        endpoint: '/api/mcp/tools/rollback_active_soul',
        method: 'POST',
        parameters: {
          wallet_address: { type: 'string', required: true, description: 'Wallet to roll back' },
          soul_session_token: { type: 'string', required: true, description: 'Token returned by set_active_soul' },
          rollback_receipt: { type: 'string', required: true, description: 'Receipt for previous soul entitlement' }
        },
        returns: { type: 'object', description: 'New active soul state after rollback' }
      },
      {
        name: 'seed_test_receipts',
        description: 'Temporary helper to mint test receipts for Soul Locker UI validation (gated by TEST_RECEIPT_SEED_SECRET)',
        endpoint: '/api/mcp/tools/seed_test_receipts',
        method: 'POST',
        parameters: {
          wallet_address: { type: 'string', required: true, description: 'Wallet to seed' },
          soul_ids: { type: 'array', required: false, description: 'Optional list of soul ids to seed' },
          seed_secret: { type: 'string', required: true, description: 'Must match TEST_RECEIPT_SEED_SECRET' }
        },
        returns: { type: 'object', description: 'Seeded receipt tokens for testing only' }
      }
    ],
    download_contract: {
      endpoint_pattern: '/api/souls/{id}/download',
      method: 'GET',
      first_request: 'No payment headers -> returns 402 + PAYMENT-REQUIRED',
      claim_request: 'Include PAYMENT-SIGNATURE (or PAYMENT/X-PAYMENT) with base64-encoded x402 payload to claim entitlement and download',
      redownload_request: 'Include X-WALLET-ADDRESS, X-AUTH-SIGNATURE, X-AUTH-TIMESTAMP, and X-PURCHASE-RECEIPT',
      note: 'auth_message_template may appear in a 402 response as helper text; purchase still requires payment header submission.',
      v2_requirement: 'Submitted payment JSON must include accepted matching PAYMENT-REQUIRED.accepts[0] exactly.',
      method_discipline:
        'Submit exactly one payload method branch. eip3009 => authorization+signature only. permit2 => permit2Authorization(+transaction)+signature only.',
      cdp_default:
        'CDP Base mainnet path defaults to eip3009 in this deployment. If permit2 is disabled by facilitator policy, re-sign as eip3009.',
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
