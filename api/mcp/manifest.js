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
        'PAYMENT-SIGNATURE',
        'PAYMENT-REQUIRED',
        'PAYMENT-RESPONSE'
      ],
      redownload_headers: ['X-WALLET-ADDRESS', 'X-AUTH-SIGNATURE', 'X-AUTH-TIMESTAMP', 'X-PURCHASE-RECEIPT']
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
        description: 'Initiate x402 purchase and receive PAYMENT-REQUIRED requirements',
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
      }
    ],
    download_contract: {
      endpoint_pattern: '/api/souls/{id}/download',
      method: 'GET',
      first_request: 'No payment headers -> returns 402 + PAYMENT-REQUIRED',
      claim_request: 'Include PAYMENT-SIGNATURE with x402 payload to claim entitlement and download',
      redownload_request: 'Include X-WALLET-ADDRESS, X-AUTH-SIGNATURE, X-AUTH-TIMESTAMP, and X-PURCHASE-RECEIPT'
    },
    contact: {
      name: 'SoulStarter Support',
      url: 'https://soulstarter.vercel.app'
    }
  });
}
