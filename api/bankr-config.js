// api/bankr-config.js
// Provides Bankr configuration to client (API key for signing)

export default async function handler(req, res) {
  // CORS
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only provide public address, not API key (for security)
  // Client will need to get API key through other means or use MetaMask
  const bankrAddress = process.env.BANKR_ADDRESS || process.env.SELLER_ADDRESS;
  
  if (!bankrAddress) {
    return res.status(500).json({ error: 'Bankr not configured' });
  }

  return res.json({
    address: bankrAddress,
    network: 'eip155:8453',
    available: true
  });
}
