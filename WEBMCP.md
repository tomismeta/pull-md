# WebMCP Contract

This document describes the exact agent-facing contract implemented by SoulStarter.

## Discovery

Agents should discover capabilities through:

- `GET /api/mcp/manifest`
- `mcp:*` meta tags in `/public/index.html` and `/public/soul.html`

## Tools

1. `GET /api/mcp/tools/list_souls`
- Lists available souls and pricing metadata.

2. `GET /api/mcp/tools/get_soul_details?id=<soul_id>`
- Returns detailed metadata and endpoint usage details for one soul.

3. `POST /api/mcp/tools/purchase_soul`
- Returns a strict x402 `402` response and `PAYMENT-REQUIRED`.

4. `POST /api/mcp/tools/check_entitlements`
- Verifies receipt proof(s) for re-download:
`{ wallet_address, proofs: [{ soul_id, receipt }] }`

## Download Endpoint

`GET /api/souls/{id}/download`

### Purchase (x402 strict)

1. First request without payment headers:
- Response `402`
- Header `PAYMENT-REQUIRED` (base64 JSON payment requirements)

2. Paid retry:
- Header `PAYMENT-SIGNATURE` (base64 JSON payment payload)
- Response `200` with soul file
- Header `PAYMENT-RESPONSE` (base64 JSON settlement response)
- Header `X-PURCHASE-RECEIPT` (for no-repay re-downloads)

### Re-download (no repay)

Headers required:

- `X-WALLET-ADDRESS`
- `X-AUTH-SIGNATURE`
- `X-AUTH-TIMESTAMP`
- `X-PURCHASE-RECEIPT`

If receipt and wallet auth are valid, response is `200` with soul file.

## Re-download Auth Message

Clients sign exactly:

```text
SoulStarter Wallet Authentication
address:<wallet_lowercase>
soul:<soul_id>
action:redownload
timestamp:<unix_ms>
```
