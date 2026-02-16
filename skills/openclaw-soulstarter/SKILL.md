---
name: openclaw-soulstarter
description: Use this skill when an agent needs to discover SoulStarter via WebMCP, purchase a soul with strict x402 headers, and re-download previously purchased souls without paying twice.
---

# OpenClaw SoulStarter Skill

Use this skill for agent workflows against a deployed SoulStarter instance.

## Wallet Compatibility Status (2026-02-14)

- Preferred purchase signer: `EmblemVault` (verified successful).
- `Bankr` for EIP-3009 purchase signing is currently experimental in this deployment.
- Known Bankr failure signature: settlement diagnostics include `FiatTokenV2: invalid signature`.

## Inputs Required

- `base_url` (canonical: `https://soulstarter.vercel.app`)
- `wallet_address`
- Wallet signing capability for:
`PAYMENT-SIGNATURE` payload creation and `redownload` auth message signing
- Optional stored `X-PURCHASE-RECEIPT` per soul

## Workflow

1. Discover capabilities.
2. Select a soul.
3. Attempt session/receipt re-download first.
4. If not entitled, run strict x402 purchase flow.
5. Persist purchase receipt for future re-download.

## 1. Discover

- `GET {base_url}/api/mcp/manifest`
- `GET {base_url}/api/mcp/tools/list_souls`
- `GET {base_url}/api/mcp/tools/get_soul_details?id={soul_id}`

Domain rule:
- Use `https://soulstarter.vercel.app` for production runs.
- Avoid preview/alias domains when validating the payment contract.

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

Preferred session mode:

1. Bootstrap session:
- `GET {base_url}/api/auth/session`
- Headers: `X-WALLET-ADDRESS`, `X-AUTH-SIGNATURE`, `X-AUTH-TIMESTAMP`
2. Re-download:
- `GET {base_url}/api/souls/{soul_id}/download`
- Headers:
  - Preferred: `X-WALLET-ADDRESS`, `X-PURCHASE-RECEIPT`, `X-REDOWNLOAD-SESSION`
  - Recovery if receipt unavailable: `X-WALLET-ADDRESS`, `X-REDOWNLOAD-SESSION`

Server behavior:
- Receipt mode is primary.
- Session-only recovery is accepted for prior on-chain buyers and creator-owned souls.

## 3. Purchase Flow (Strict x402)

1. Request paywall:
- `GET {base_url}/api/souls/{soul_id}/download` (authoritative endpoint)
- Expect `402` with `PAYMENT-REQUIRED`.

2. Decode `PAYMENT-REQUIRED` and create x402 payment payload.
   - For v2, include:
   `accepted: PAYMENT_REQUIRED.accepts[0]` (exact object, unchanged)
   - Verify `accepted.payTo` equals trusted seller address from SoulStarter metadata before signing.
   - Never trust truncated addresses from wallet/explorer transfer history.
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
Read `PAYMENT-REQUIRED.accepts[0].extra.assetTransferMethod`:
`permit2` -> sign `PermitWitnessTransferFrom`; `eip3009` -> sign `TransferWithAuthorization`.
- CDP/Base production default path:
assume `eip3009` unless current `PAYMENT-REQUIRED` says `permit2`.
- Bankr wallet:
Use Bankr Agent API typed-data signing:
`POST /agent/sign` with `signatureType=eth_signTypedData_v4`, then pass final base64 JSON payload in `PAYMENT-SIGNATURE` (or `PAYMENT`).
Never send Bankr API keys/tokens to SoulStarter endpoints.
For production purchase runs, prefer EmblemVault until Bankr EIP-3009 signer compatibility is fixed.

If you get `No matching payment requirements`:
- You likely omitted or mutated `accepted`.
- Rebuild payload from the latest `PAYMENT-REQUIRED` and retry.

If you get `auth_message_template` in `402`:
- This is optional re-download helper text, not purchase denial.
- Continue purchase flow with `PAYMENT-SIGNATURE`.

If you get `flow_hint` about header detected but not verified/settled:
- Re-sign from latest `PAYMENT-REQUIRED`.
- Confirm method-specific fields are exact for permit2 vs eip3009.
- Confirm top-level `network` equals `eip155:8453` exactly.
- SoulStarter will remap facilitator-bound network fields to CDP enum (`base`) internally; do not sign `base` in the agent payload.

If settlement diagnostics show `FiatTokenV2: invalid signature`:
- Treat this as signer incompatibility for EIP-3009 in this flow.
- Switch signer (recommended: EmblemVault) and retry with fresh requirements/signature.

If facilitator reports schema errors (`paymentPayload is invalid`, `must match oneOf`):
- Permit2 payload must include: `payload.from`, `payload.permit2Authorization`, `payload.transaction`, `payload.signature`.
- Do not send `payload.permit2`.
- Do not include `payload.authorization` in permit2 mode.
- For eip3009 send only `payload.authorization` and `payload.signature`.
- Never send both `payload.authorization` and `payload.permit2Authorization` in the same payload.
- If CDP returns `permit2 payments are disabled`, switch to eip3009 immediately.

### Bankr Capability Mapping

Use these Bankr capabilities explicitly:

1. `GET /agent/me`:
- Read the Bankr EVM wallet address for `authorization.from`.

2. `POST /agent/sign`:
- Sign typed data based on `assetTransferMethod` (`PermitWitnessTransferFrom` for permit2, `TransferWithAuthorization` for eip3009).
- Build final x402 JSON locally and send only `PAYMENT-SIGNATURE` to SoulStarter.
For permit2 include `payload.from`, `payload.permit2Authorization`, `payload.transaction`, and `payload.signature`.
Set `payload.transaction.data` to ERC20 `approve(PERMIT2_ADDRESS, MAX_UINT256)` calldata.
Set top-level `network` to `eip155:8453` (from `accepted.network`), not `base`.
Do not include `payload.authorization` in permit2 mode.
Send permit2 numeric fields (`amount`, `nonce`, `deadline`, `validAfter`) as strings.

3. `POST /agent/submit`:
- Not required for SoulStarter purchase flow.
- SoulStarter server settles via facilitator after receiving the signed x402 payload header.

4. LLM gateway / threads:
- Optional orchestration only; not required for settlement.

Important:
- Buyer/Banr wallet does **not** need CDP credentials.
- Only SoulStarter server needs facilitator credentials.
- Bankr credentials are agent-local only and must never be forwarded to SoulStarter.

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
