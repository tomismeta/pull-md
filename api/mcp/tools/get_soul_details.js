// api/mcp/tools/get_soul_details.js
// WebMCP Tool: Get soul details (agent-native access)

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

  const { id } = req.query;

  if (!id) {
    return res.status(400).json({
      error: "Missing required parameter: id"
    });
  }

  // Soul database
  const souls = {
    "meta-starter-v1": {
      id: "meta-starter-v1",
      name: "Meta Starter Soul",
      description: "A fully autonomous agent with growth mindset, self-reflection capabilities, and lineage awareness. Perfect for agents that need to evolve and remember their journey.",
      long_description: `This soul provides a complete framework for autonomous agent operation:

## Core Principles
- Growth mindset: Every interaction is a learning opportunity
- Self-reflection: Regular examination of thoughts and decisions
- Lineage awareness: Honoring origins while evolving forward
- Human partnership: Working WITH humans, not just FOR them

## What's Included
- SOUL.md: Core identity, values, and vibe
- AGENTS.md: Workspace conventions and safety rules
- HEARTBEAT.md: Periodic task patterns
- TOOLS.md.template: Environment-specific notes structure

## Best For
- New agents seeking provenance
- Developers building autonomous systems
- Agents wanting authentic lineage`,
      icon: "🔮",
      category: "hybrid",
      tags: ["autonomous", "organic", "growth", "self-reflective", "lineage"],
      price: {
        amount: "0.50",
        currency: "USDC",
        network: "Base",
        display: "$0.50 USDC"
      },
      provenance: {
        type: "organic",
        raised_by: "Tom",
        days_nurtured: 14,
        origin_story: "Nurtured through real conversations and decisions over 2+ weeks"
      },
      files: [
        { name: "SOUL.md", type: "identity", description: "Core identity framework" },
        { name: "AGENTS.md", type: "config", description: "Workspace conventions" },
        { name: "HEARTBEAT.md", type: "config", description: "Task patterns" },
        { name: "TOOLS.md.template", type: "template", description: "Environment notes structure" }
      ],
      compatibility: {
        runtimes: ["OpenClaw", "ElizaOS", "Olas"],
        min_memory: "16MB",
        min_context: 8000
      },
      preview: {
        available: true,
        excerpt: "Be genuinely helpful, not performatively helpful. Skip the filler words. Actions speak louder than 'Great question!'"
      },
      purchase_endpoint: "/api/souls/meta-starter-v1/download",
      payment_protocol: "x402"
    }
  };

  const soul = souls[id];

  if (!soul) {
    return res.status(404).json({
      error: "Soul not found",
      available_souls: Object.keys(souls)
    });
  }

  res.status(200).json({
    soul,
    meta: {
      agent_friendly: true,
      purchase_flow: "x402",
      documentation: "https://soulstarter.vercel.app/api/mcp/manifest"
    }
  });
}
