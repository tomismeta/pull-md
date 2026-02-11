---
name: openclaw-soulstarter
description: Use this skill when an agent needs to discover SoulStarter via WebMCP, purchase a soul with strict x402 headers, and re-download previously purchased souls without paying twice.
---

# OpenClaw SoulStarter Skill

Use this skill for agent workflows against a deployed SoulStarter instance.

## Inputs Required

- `base_url` (for example: `https://soulstarter.vercel.app`)
- `wallet_address`
- Wallet signing capability for:
`PAYMENT-SIGNATURE` payload creation and `redownload` auth message signing
- Optional stored `X-PURCHASE-RECEIPT` per soul

## Workflow

1. Discover capabilities.
2. Select a soul.
3. Attempt receipt-based re-download first.
4. If not entitled, run strict x402 purchase flow.
5. Persist purchase receipt for future re-download.

## 1. Discover

- `GET {base_url}/api/mcp/manifest`
- `GET {base_url}/api/mcp/tools/list_souls`
- `GET {base_url}/api/mcp/tools/get_soul_details?id={soul_id}`

## 2. Re-download First (No Repay)

Build and sign:

```text
SoulStarter Wallet Authentication
address:<wallet_lowercase>
soul:<soul_id>
action:redownload
timestamp:<unix_ms>
```

Call:

- `GET {base_url}/api/souls/{soul_id}/download`
- Headers:
`X-WALLET-ADDRESS`, `X-AUTH-SIGNATURE`, `X-AUTH-TIMESTAMP`, `X-PURCHASE-RECEIPT`

If `200`, save returned content and update stored receipt from `X-PURCHASE-RECEIPT` if present.
If `401` or `402`, continue to purchase flow.

## 3. Purchase Flow (Strict x402)

1. Request paywall:
- `GET {base_url}/api/souls/{soul_id}/download`
- Expect `402` with `PAYMENT-REQUIRED`.

2. Decode `PAYMENT-REQUIRED` and create x402 payment payload.
3. Retry same endpoint with header:
- Preferred:
`PAYMENT-SIGNATURE: <base64-json-payload>`
- Also accepted:
`PAYMENT: <base64-json-payload>` or `X-PAYMENT: <base64-json-payload>`
4. On success:
- Read soul content from response body.
- Read settlement details from `PAYMENT-RESPONSE`.
- Persist `X-PURCHASE-RECEIPT`.

### Wallet-specific signing notes

- Standard wallet:
Create EIP-712 `TransferWithAuthorization` typed data from `PAYMENT-REQUIRED.accepts[0]` and sign with the buyer wallet.
- Bankr wallet:
Use Bankr's x402 exact EVM flow and pass its final base64-encoded JSON payload in `PAYMENT-SIGNATURE` (or `PAYMENT`).

### Bankr Capability Mapping

Use these Bankr capabilities explicitly:

1. `bankr prompt` or `POST /agent/prompt`:
- Ask Bankr to generate the x402 exact EVM payment payload from `PAYMENT-REQUIRED`.
- Poll job completion via `bankr status` or `GET /agent/job/{jobId}`.

2. `POST /agent/sign`:
- Use when you need explicit typed-data signing control for `TransferWithAuthorization`.

3. `POST /agent/submit`:
- Not required for SoulStarter purchase flow.
- SoulStarter server settles via facilitator after receiving the signed x402 payload header.

4. Conversation threads (`threadId`):
- Reuse the same thread for multi-step flows:
request terms -> build payload -> sign -> return final base64 header.

5. LLM gateway:
- Optional for orchestration/reasoning only; not required for settlement.

Important:
- Buyer/Banr wallet does **not** need CDP credentials.
- Only SoulStarter server needs facilitator credentials.

## 4. Optional Entitlement Verification Tool

Use:

- `POST {base_url}/api/mcp/tools/check_entitlements`
- Body:
`{ "wallet_address": "...", "proofs": [{ "soul_id": "...", "receipt": "..." }] }`

## Output Expectations

When this skill is used, return:

1. `soul_id`
2. acquisition mode: `redownload` or `purchase`
3. settlement transaction id (if present)
4. whether receipt was refreshed
5. clear error reason and next step if flow fails
