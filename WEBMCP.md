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
- Header `PAYMENT-SIGNATURE` (preferred), or `PAYMENT`, or `X-PAYMENT`
- Value format for all three:
base64(JSON x402 payload)
- Response `200` with soul file
- Header `PAYMENT-RESPONSE` (base64 JSON settlement response)
- Header `X-PURCHASE-RECEIPT` (for no-repay re-downloads)

#### Agent Header Formatting

The paid retry header value must be:

```text
base64(JSON.stringify({
  x402Version: 2,
  scheme: "exact",
  network: "eip155:8453",
  payload: {
    authorization: { ...TransferWithAuthorization },
    signature: "0x..."
  }
}))
```

#### Wallet Notes

- Standard wallet:
Build EIP-712 domain/types/message from `PAYMENT-REQUIRED.accepts[0]`, sign typed data, send base64 JSON payload.
- Bankr wallet:
Use Bankr's x402 exact EVM signer output directly, then send its base64 JSON payload in `PAYMENT-SIGNATURE` (or `PAYMENT`).
- Bankr API/CLI capability mapping:
`/agent/prompt` + job polling for orchestration, `/agent/sign` for explicit signature generation, and **do not** use `/agent/submit` for SoulStarter purchase settlement.
- Buyers do **not** need CDP credentials.
Only the SoulStarter server needs facilitator credentials.

### Re-download (no repay)

Headers required:

- `X-WALLET-ADDRESS`
- `X-AUTH-SIGNATURE`
- `X-AUTH-TIMESTAMP`
- `X-PURCHASE-RECEIPT`

If receipt and wallet auth are valid, response is `200` with soul file.

## Common Misread

If you see `auth_message_template` in a `402` body, that does **not** mean purchase is unavailable.
It is helper text for optional re-download auth.
Purchase still succeeds when a valid paid header is submitted.

## Re-download Auth Message

Clients sign exactly:

```text
SoulStarter Wallet Authentication
address:<wallet_lowercase>
soul:<soul_id>
action:redownload
timestamp:<unix_ms>
```
