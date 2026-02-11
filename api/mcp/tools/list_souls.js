// api/mcp/tools/list_souls.js
// WebMCP Tool: List available souls (agent-native access)

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

  const { category } = req.query;

  // Soul catalog (same as souls.json)
  const souls = [
    {
      id: "meta-starter-v1",
      name: "Meta Starter Soul",
      description: "A fully autonomous agent with growth mindset, self-reflection capabilities, and lineage awareness.",
      icon: "🔮",
      category: "hybrid",
      tags: ["autonomous", "organic", "growth", "self-reflective"],
      price: {
        amount: "0.50",
        currency: "USDC",
        network: "Base"
      },
      provenance: {
        type: "organic",
        raised_by: "Tom",
        days_nurtured: 14
      },
      compatibility: {
        runtimes: ["OpenClaw", "ElizaOS"],
        min_memory: "16MB"
      }
    }
  ];

  // Filter by category if provided
  let result = souls;
  if (category) {
    result = souls.filter(soul => soul.category === category);
  }

  res.status(200).json({
    souls: result,
    count: result.length,
    meta: {
      agent_friendly: true,
      access_type: "x402_paywall",
      documentation: "https://soulstarter.vercel.app/api/mcp/manifest"
    }
  });
}
