// api/mcp/tools/purchase_soul.js
// WebMCP Tool: Initiate soul purchase (returns x402 requirements)

export default async function handler(req, res) {
  // CORS
  const origin = req.headers.origin;
  const allowedOrigins = [
    'https://soulstarter.vercel.app',
    'https://soulstarter.io',
    'http://localhost:3000',
    'http://localhost:8080'
  ];
  
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { soul_id, wallet_address } = req.body || {};

  // Validation
  if (!soul_id) {
    return res.status(400).json({
      error: "Missing required parameter: soul_id"
    });
  }

  if (!wallet_address) {
    return res.status(400).json({
      error: "Missing required parameter: wallet_address",
      message: "Wallet address required for x402 payment"
    });
  }

  // Validate soul exists
  const validSouls = ['meta-starter-v1'];
  if (!validSouls.includes(soul_id)) {
    return res.status(404).json({
      error: "Soul not found",
      available_souls: validSouls
    });
  }

  // Validate wallet address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet_address)) {
    return res.status(400).json({
      error: "Invalid wallet address format",
      message: "Must be valid Ethereum address (0x...)"
    });
  }

  // Configuration
  const CONFIG = {
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    sellerAddress: process.env.SELLER_ADDRESS?.trim(),
    network: 'eip155:8453',
    price: '500000' // $0.50 = 500000 micro-USDC
  };

  if (!CONFIG.sellerAddress) {
    return res.status(500).json({
      error: "Server configuration error"
    });
  }

  // Generate payment requirements (x402 402 response format)
  const nonce = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  
  const paymentRequirements = {
    scheme: 'exact',
    network: CONFIG.network,
    payload: {
      token: CONFIG.usdcAddress,
      to: CONFIG.sellerAddress,
      amount: CONFIG.price,
      timestamp: Date.now(),
      nonce: nonce
    },
    metadata: {
      buyer: wallet_address,
      product: soul_id,
      description: `Purchase ${soul_id} from SoulStarter`
    }
  };

  // Return 402 status with payment requirements
  res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(paymentRequirements)).toString('base64'));
  
  res.status(402).json({
    error: "Payment required",
    message: "x402 payment required to complete purchase",
    payment: {
      amount: "$0.50",
      currency: "USDC",
      network: "Base",
      recipient: CONFIG.sellerAddress
    },
    instructions: {
      step_1: "Sign the payment payload with your wallet",
      step_2: "POST to /api/souls/{soul_id}/download with PAYMENT-SIGNATURE header",
      step_3: "Receive soul content on successful payment"
    },
    requirements: paymentRequirements,
    documentation: "https://soulstarter.vercel.app/api/mcp/manifest"
  });
}
