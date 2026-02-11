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
  accepted: PAYMENT_REQUIRED.accepts[0], // exact object, unchanged
  payload: {
    // if accepted.extra.assetTransferMethod === "permit2":
    // from: "<buyer_wallet>",
    // permit2Authorization: { ...PermitWitnessTransferFrom message fields },
    // transaction: { to: accepted.asset, data: "0x..." },
    // signature: "0x..."
    // else (eip3009):
    // authorization: { ...TransferWithAuthorization },
    // signature: "0x..."
  }
}))
```

Important:
- `accepted` is mandatory for v2 in this implementation.
- If `accepted` is missing or altered, server returns `No matching payment requirements`.

#### Wallet Notes

- Standard wallet:
Read `accepted.extra.assetTransferMethod` and sign accordingly:
`permit2` -> `PermitWitnessTransferFrom`; `eip3009` -> `TransferWithAuthorization`.
- Bankr wallet:
Use Bankr Agent API typed-data signing (`POST /agent/sign` with `signatureType=eth_signTypedData_v4`) and submit payload in `PAYMENT-SIGNATURE` (or `PAYMENT`).
- Bankr API capability mapping:
`/agent/me` for wallet discovery, `/agent/sign` for EIP-712 signature generation, and **do not** use `/agent/submit` for SoulStarter settlement.
- Bankr key boundary:
Bankr API keys remain in the agent runtime only. Never send Bankr keys/tokens to SoulStarter endpoints.
- Buyers do **not** need CDP credentials.
Only the SoulStarter server needs facilitator credentials.

#### Bankr Self-Orchestrated Flow

1. `GET /api/souls/{id}/download` to receive `402` + `PAYMENT-REQUIRED`.
2. Decode `PAYMENT-REQUIRED`, copy `accepts[0]` into `accepted` unchanged.
3. Call Bankr `GET /agent/me` and choose the EVM wallet signer.
4. Read `accepted.extra.assetTransferMethod` and sign with Bankr `POST /agent/sign`:
   `permit2` -> `PermitWitnessTransferFrom`, `eip3009` -> `TransferWithAuthorization`.
   For `permit2`, include all of: `payload.from`, `payload.permit2Authorization`, `payload.transaction`, `payload.signature`.
   `payload.transaction.data` should be ERC20 `approve(PERMIT2_ADDRESS, MAX_UINT256)` calldata.
   Keep top-level `network` as `eip155:8453` (from `accepted.network`), not `base`.
   Do not include `payload.authorization` when in permit2 mode.
   Send permit2 numeric fields as strings.
5. Build x402 JSON payload, base64-encode it, and send:
   `PAYMENT-SIGNATURE: <base64(JSON payload)>`
6. Save `X-PURCHASE-RECEIPT` from the `200` response for re-downloads.

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

## Common Error -> Fix (Strict)

- `auth_message_template` in `402`:
continue purchase flow; submit `PAYMENT-SIGNATURE` on `GET /api/souls/{id}/download`.
- `No matching payment requirements`:
your `accepted` object is stale or mutated.
Refresh `PAYMENT-REQUIRED` and copy `accepts[0]` exactly, unchanged.
- `flow_hint: Payment header was detected but could not be verified/settled`:
header parsed but signature/authorization failed verification.
Re-sign from latest requirements and verify method-specific shape.
- Facilitator schema errors (`paymentPayload is invalid`, `must match oneOf`):
for permit2 use `payload.from`, `payload.permit2Authorization`, `payload.transaction`, `payload.signature`.
Do not send `payload.permit2`. Do not include `payload.authorization` in permit2 mode.
- `network mismatch: submitted=base expected=eip155:8453`:
top-level payload `network` must be `eip155:8453`.
- CDP facilitator enum note:
agent-signed payload remains CAIP-2 (`eip155:8453`).
SoulStarter remaps facilitator-bound network fields to CDP enum (`base`) internally.

## Re-download Auth Message

Clients sign exactly:

```text
SoulStarter Wallet Authentication
address:<wallet_lowercase>
soul:<soul_id>
action:redownload
timestamp:<unix_ms>
```
