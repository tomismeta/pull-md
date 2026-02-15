# WebMCP Contract

This document describes the exact agent-facing contract implemented by SoulStarter.

## Discovery

Agents should discover capabilities through:

- `GET /api/mcp/manifest`
- `mcp:*` meta tags in `/public/index.html` and `/public/soul.html`

Canonical production host:

- `https://soulstarter.vercel.app`
- Do not rely on preview/alias domains for contract verification.

## Wallet Compatibility Status (2026-02-14)

- Browser UX wallet scope:
MetaMask, Rabby, Bankr Wallet.
- `EmblemVault`: purchase + re-download verified working.
- `Bankr`: purchase signing via EIP-3009 currently unreliable/incompatible in this deployment (`FiatTokenV2: invalid signature` in diagnostics).
- Agent guidance:
prefer EmblemVault for production purchase runs until Bankr signer compatibility is fixed upstream.

## Tools

1. `GET /api/mcp/tools/list_souls`
- Lists available souls and pricing metadata.
- Returns DB-backed published listings by default.
- Bundled static souls are returned only when `ENABLE_BUNDLED_SOULS=1`.

2. `GET /api/mcp/tools/get_soul_details?id=<soul_id>`
- Returns detailed metadata and endpoint usage details for one soul.

3. `POST /api/mcp/tools/purchase_soul` (deprecated)
- Returns `410 Gone` with canonical flow instructions.

4. `POST /api/mcp/tools/check_entitlements`
- Verifies receipt proof(s) for re-download:
`{ wallet_address, proofs: [{ soul_id, receipt }] }`

5. `GET /api/mcp/tools/creator_marketplace?action=get_listing_template`
- Returns template for immediate publish payloads.

6. `POST /api/mcp/tools/creator_marketplace?action=publish_listing`
- Creator wallet-authenticated immediate publish.
- Request fields:
`wallet_address`, `auth_signature`, `auth_timestamp`, `listing`.
- No draft state or approval queue.
- Success returns `share_url` and `purchase_endpoint`.

7. `GET /api/mcp/tools/creator_marketplace?action=list_my_published_listings`
- Creator wallet-authenticated list of creator-owned listings (includes hidden).

8. `GET /api/mcp/tools/creator_marketplace?action=list_published_listings`
- Public list of visible listings only.
- Backed by Postgres JSONB when configured (`MARKETPLACE_DATABASE_URL`/`DATABASE_URL`/`POSTGRES_URL`).
- On Vercel, creator publish requires one of these DB vars; otherwise `publish_listing` returns `503 marketplace_persistence_unconfigured` to avoid non-durable listings.
- Response may include `storage_warning` when persistence configuration is incomplete.

9. `GET /api/mcp/tools/creator_marketplace?action=list_moderators`
- Lists allowlisted moderator wallet addresses.

10. `GET /api/mcp/tools/creator_marketplace?action=list_moderation_listings` (moderator wallet auth)
- Headers:
`X-MODERATOR-ADDRESS`, `X-MODERATOR-SIGNATURE`, `X-MODERATOR-TIMESTAMP`
- Returns `visible[]` and `hidden[]` listing partitions.

11. `POST /api/mcp/tools/creator_marketplace?action=remove_listing_visibility` (moderator wallet auth)
- Headers:
`X-MODERATOR-ADDRESS`, `X-MODERATOR-SIGNATURE`, `X-MODERATOR-TIMESTAMP`
- Body:
`{ soul_id, reason? }`
- Hides listing from public discovery/purchase without draft state transitions.

UI companion:
- `/admin.html` provides a lightweight human moderation console for visibility removal only.
- It requires connected allowlisted moderator wallet and signs `SoulStarter Moderator Authentication` messages per moderation action.
- `/create.html` provides a lightweight creator console for immediate publish and share-link retrieval.
- Creator auth actions use wallet signatures over `SoulStarter Creator Authentication` messages with action-scoped timestamps.

## Download Endpoint

`GET /api/souls/{id}/download`

Authoritative purchase flow:

- `GET /api/souls/{id}/download` is the canonical x402 entrypoint.
- `POST /api/mcp/tools/purchase_soul` is hard-deprecated and should not be used at runtime.

### Purchase (x402 strict)

1. First request without payment headers:
- Response `402`
- Header `PAYMENT-REQUIRED` (base64 JSON payment requirements)

2. Paid retry:
- Include `X-CLIENT-MODE: agent` for strict headless behavior
- Header `PAYMENT-SIGNATURE` only
- Value format:
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
- Before signing, verify `accepted.payTo` matches trusted seller metadata exactly (full address, checksum comparison).
- Ignore tiny unsolicited transfers and never copy destination addresses from transfer history.

#### Wallet Notes

- Standard wallet:
Read `accepted.extra.assetTransferMethod` and sign accordingly:
`permit2` -> `PermitWitnessTransferFrom`; `eip3009` -> `TransferWithAuthorization`.
- CDP/Base production default:
SoulStarter defaults to `eip3009`. Treat this as the primary path unless the latest `PAYMENT-REQUIRED` explicitly sets `permit2`.
- Bankr wallet:
Use Bankr Agent API typed-data signing (`POST /agent/sign` with `signatureType=eth_signTypedData_v4`) and submit payload in `PAYMENT-SIGNATURE` (or `PAYMENT`).
Current status: keep Bankr path marked experimental for EIP-3009 purchase execution.
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
   For `eip3009`, include only `payload.authorization` + `payload.signature`.
   Do not include `payload.permit2Authorization` or `payload.transaction` in eip3009 mode.
5. Build x402 JSON payload, base64-encode it, and send:
   `PAYMENT-SIGNATURE: <base64(JSON payload)>`
6. Save `X-PURCHASE-RECEIPT` from the `200` response for re-downloads.

### Re-download (no repay)

Required base headers:

- `X-CLIENT-MODE: agent` (strict headless mode)
- `X-WALLET-ADDRESS`
- `X-PURCHASE-RECEIPT`

This receipt-first trio is the strict canonical flow for headless agents.
If receipt is valid for wallet+soul, response is `200` with soul file.
If re-download headers are present, server prioritizes entitlement delivery over purchase processing, even if a payment header is also present.

Strict agent mode rules:
- `X-CLIENT-MODE: agent` disables browser recovery branches.
- Do not send `PAYMENT` or `X-PAYMENT`; they are hard-deprecated (`410`).
- Do not send `X-REDOWNLOAD-SESSION`, `X-AUTH-SIGNATURE`, or `X-AUTH-TIMESTAMP`.
- Missing/invalid receipt returns `401` (`receipt_required_agent_mode` / `invalid_receipt_agent_mode`).
- No `/api/auth/session` call is required for headless agents.
- If `/api/auth/session` is called with `X-CLIENT-MODE: agent`, server returns `410` (`session_api_not_for_agents`).

Human/creator recovery mode (receipt unavailable):
- `X-WALLET-ADDRESS`
- `X-REDOWNLOAD-SESSION` (or signed fallback `X-AUTH-SIGNATURE` + `X-AUTH-TIMESTAMP`)
- Server checks creator ownership and prior on-chain buyer payment history for entitlement recovery.

Auth verifier compatibility:
- Server accepts message signatures over canonical variants:
`address:` line in lowercase or checksummed form, and either `LF` or `CRLF` line endings.

### Session Bootstrap Endpoint (Human/Hybrid Clients)

`GET /api/auth/session`

Headers:
- `X-WALLET-ADDRESS`
- `X-AUTH-SIGNATURE`
- `X-AUTH-TIMESTAMP`

Sign message:

```text
SoulStarter Wallet Authentication
address:<wallet_lowercase>
soul:*
action:session
timestamp:<unix_ms>
```

Success response includes:
- `X-REDOWNLOAD-SESSION` header
- session token JSON body fields (`token`, `expires_at_ms`)

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
- Payment 402 with copy-paste scaffold:
use `accepted_copy_paste` exactly as top-level `accepted`, then fill `copy_paste_payment_payload.payload` signer fields and resubmit.
- `Incomplete re-download header set`:
you sent partial entitlement headers, so server blocked purchase fallback to prevent accidental repay.
Re-download requires:
`X-CLIENT-MODE: agent` + `X-WALLET-ADDRESS` + `X-PURCHASE-RECEIPT` for strict headless agents.
Recovery (receipt unavailable):
`X-WALLET-ADDRESS` + (`X-REDOWNLOAD-SESSION` or `X-AUTH-SIGNATURE` + `X-AUTH-TIMESTAMP`).
- `flow_hint: Payment header was detected but could not be verified/settled`:
header parsed but signature/authorization failed verification.
Re-sign from latest requirements and verify method-specific shape.
- `FiatTokenV2: invalid signature` in settlement diagnostics:
wallet signer is not producing a USDC-compatible EIP-3009 signature for this flow.
Use EmblemVault or another compatible signer.
- Duplicate payment concern (same signed authorization submitted multiple times):
server applies single-flight idempotency by payer + soul + nonce to prevent duplicate settlement attempts in-flight.
- Facilitator schema errors (`paymentPayload is invalid`, `must match oneOf`):
for permit2 use `payload.from`, `payload.permit2Authorization`, `payload.transaction`, `payload.signature`.
Do not send `payload.permit2`. Do not include `payload.authorization` in permit2 mode.
- OneOf ambiguity errors (`matches more than one schema`, `input matches more than one oneOf schemas`):
do not send mixed payload branches.
Use exactly one method:
`eip3009` => `payload.authorization` + `payload.signature` only.
`permit2` => `payload.permit2Authorization` (+ `payload.transaction` when required) + `payload.signature` only.
- CDP policy error `permit2 payments are disabled`:
re-fetch latest paywall and use `eip3009` (`TransferWithAuthorization`) flow.
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

## Creator Publish Auth Message

Creator publish tools require wallet-auth headers:
- `X-WALLET-ADDRESS`
- `X-AUTH-SIGNATURE`
- `X-AUTH-TIMESTAMP`

Sign exactly:

```text
SoulStarter Creator Authentication
address:<wallet_lowercase>
action:<tool_action>
timestamp:<unix_ms>
```

Where `<tool_action>` is one of:
- `publish_listing`
- `list_my_published_listings`

## Moderator Auth Message

Moderation tools require wallet-auth headers:
- `X-MODERATOR-ADDRESS`
- `X-MODERATOR-SIGNATURE`
- `X-MODERATOR-TIMESTAMP`

Sign exactly:

```text
SoulStarter Moderator Authentication
address:<wallet_lowercase>
action:<tool_action>
timestamp:<unix_ms>
```

Where `<tool_action>` is one of:
- `list_moderation_listings`
- `remove_listing_visibility`
