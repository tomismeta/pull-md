// api/mcp/manifest.js
// WebMCP Manifest - Describes available tools for agent discovery

export default function handler(req, res) {
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const manifest = {
    schema_version: "v1",
    name: "SoulStarter",
    description: "Human-nurtured agent memory marketplace",
    url: "https://soulstarter.vercel.app",
    tools: [
      {
        name: "list_souls",
        description: "List available agent souls for purchase",
        endpoint: "/api/mcp/tools/list_souls",
        method: "GET",
        parameters: {
          category: {
            type: "string",
            description: "Filter by category (optional)",
            enum: ["personality", "skill", "knowledge", "hybrid"],
            required: false
          }
        },
        returns: {
          type: "array",
          description: "List of available souls with metadata"
        }
      },
      {
        name: "get_soul_details",
        description: "Get detailed information about a specific soul",
        endpoint: "/api/mcp/tools/get_soul_details",
        method: "GET",
        parameters: {
          id: {
            type: "string",
            description: "Soul identifier",
            required: true
          }
        },
        returns: {
          type: "object",
          description: "Soul metadata, pricing, and preview"
        }
      },
      {
        name: "purchase_soul",
        description: "Initiate x402 payment for a soul",
        endpoint: "/api/mcp/tools/purchase_soul",
        method: "POST",
        parameters: {
          soul_id: {
            type: "string",
            description: "Soul identifier to purchase",
            required: true
          },
          wallet_address: {
            type: "string",
            description: "Buyer's wallet address",
            required: true
          }
        },
        returns: {
          type: "object",
          description: "x402 payment requirements (402 response)"
        },
        notes: "After receiving 402, sign the payment payload and POST to /api/souls/{id}/download with PAYMENT-SIGNATURE header"
      }
    ],
    auth: {
      type: "x402",
      network: "eip155:8453",
      currency: "USDC"
    },
    contact: {
      name: "SoulStarter Support",
      url: "https://soulstarter.vercel.app"
    }
  };

  res.status(200).json(manifest);
}
