# WebMCP Agent Access

SoulStarter is **WebMCP-enabled**, allowing AI agents to browse and purchase souls programmatically.

## What is WebMCP?

WebMCP (Web Model Context Protocol) is a standard for exposing website capabilities to AI agents via structured metadata. Instead of scraping HTML, agents discover and use APIs through a standardized interface.

## Agent Discovery

Agents can discover SoulStarter's capabilities by:

1. **Meta tags** on every page:
```html
<meta name="mcp:version" content="1.0">
<meta name="mcp:endpoint" content="/api/mcp/manifest">
```

2. **Manifest endpoint**:
```bash
GET https://soulstarter.vercel.app/api/mcp/manifest
```

Returns complete API specification with available tools.

## Available Tools

### 1. List Souls
```bash
GET /api/mcp/tools/list_souls?category=hybrid
```

Returns:
```json
{
  "souls": [
    {
      "id": "meta-starter-v1",
      "name": "Meta Starter Soul",
      "description": "...",
      "price": { "amount": "0.50", "currency": "USDC" },
      "category": "hybrid",
      "tags": ["autonomous", "organic", "growth"]
    }
  ]
}
```

### 2. Get Soul Details
```bash
GET /api/mcp/tools/get_soul_details?id=meta-starter-v1
```

Returns complete soul metadata including file list, compatibility info, and preview excerpt.

### 3. Purchase Soul (Initiate x402)
```bash
POST /api/mcp/tools/purchase_soul
Content-Type: application/json

{
  "soul_id": "meta-starter-v1",
  "wallet_address": "0x..."
}
```

Returns **402 Payment Required** with x402 payload:
```json
{
  "error": "Payment required",
  "requirements": {
    "scheme": "exact",
    "network": "eip155:8453",
    "payload": {
      "token": "0x8335...",
      "to": "0xa7d3...",
      "amount": "500000",
      "timestamp": 1707648000000,
      "nonce": "..."
    }
  },
  "instructions": {
    "step_1": "Sign the payment payload",
    "step_2": "POST to /api/souls/{id}/download with signature"
  }
}
```

### 4. Complete Purchase
```bash
GET /api/souls/meta-starter-v1/download
PAYMENT-SIGNATURE: <base64-encoded-signed-payload>
```

Returns SOUL.md content on success (after x402 verification).

## Agent Flow Example

```javascript
// 1. Discover capabilities
const manifest = await fetch('https://soulstarter.vercel.app/api/mcp/manifest');

// 2. List available souls
const souls = await fetch('https://soulstarter.vercel.app/api/mcp/tools/list_souls');

// 3. Get details
const details = await fetch('https://soulstarter.vercel.app/api/mcp/tools/get_soul_details?id=meta-starter-v1');

// 4. Initiate purchase (returns 402)
const paymentReq = await fetch('https://soulstarter.vercel.app/api/mcp/tools/purchase_soul', {
  method: 'POST',
  body: JSON.stringify({
    soul_id: 'meta-starter-v1',
    wallet_address: agentWallet.address
  })
});

// 5. Sign payment with wallet
const signature = await agentWallet.sign(paymentReq.requirements.payload);

// 6. Complete purchase
const soul = await fetch('https://soulstarter.vercel.app/api/souls/meta-starter-v1/download', {
  headers: {
    'PAYMENT-SIGNATURE': btoa(JSON.stringify({
      ...paymentReq.requirements,
      signature,
      from: agentWallet.address
    }))
  }
});

// 7. Use the soul
console.log(soul); // SOUL.md content
```

## Why WebMCP?

- **No scraping needed** — Structured data, not HTML parsing
- **Self-documenting** — Manifest describes all capabilities
- **Agent-native** — Built for programmatic interaction
- **Payment-integrated** — x402 flow built-in
- **Standards-based** — Works with any WebMCP client

## Standards Compliance

- ✅ WebMCP v1.0 discovery via meta tags
- ✅ JSON manifest at `/api/mcp/manifest`
- ✅ RESTful tool endpoints
- ✅ x402 payment integration
- ✅ CORS enabled for agent access

## Future Enhancements

- [ ] Agent identity verification (ERC-8004)
- [ ] Usage analytics for soul creators
- [ ] Soul rating/review system
- [ ] Bulk purchase API
- [ ] Subscription souls (recurring x402)

---

*Agents welcome. Humans too.* 🤖💜
