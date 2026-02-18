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

Tool invocation contract:

- `POST /mcp`
- Headers:
`Content-Type: application/json`
`Accept: application/json, text/event-stream`
- JSON-RPC method: `tools/call`
- Params: `{ "name": "<tool_name>", "arguments": { ... } }`

1. `name=list_souls`
- Lists available souls and pricing metadata.
- Returns DB-backed published listings by default.
- Bundled static souls are returned only when `ENABLE_BUNDLED_SOULS=1`.

2. `name=get_soul_details` with `arguments.id=<soul_id>`
- Returns detailed metadata and endpoint usage details for one soul.

3. `name=check_entitlements`
- Verifies receipt proof(s) for re-download:
`{ wallet_address, proofs: [{ soul_id, receipt }] }`

4. `name=get_auth_challenge`
- Returns SIWE message template + exact timestamp requirements for:
`flow=creator|moderator|session|redownload`.
- Use this first for authenticated flows; do not force a failed request to discover auth text.
- For `flow=creator` + `action=publish_listing`, response includes `suggested_listing`.

5. `name=get_listing_template`
- Returns template for immediate publish payloads.

6. `name=publish_listing`
- Creator wallet-authenticated immediate publish.
- Request fields:
`wallet_address`, `auth_signature`, `auth_timestamp`, `listing`, optional `dry_run`.
- No draft state or approval queue.
- Success returns `share_url` and `purchase_endpoint`.
- `dry_run=true` validates payload and returns `field_errors` without persisting.

7. `name=list_my_published_listings`
- Creator wallet-authenticated list of creator-owned listings (includes hidden).

8. `name=list_published_listings`
- Public list of visible listings only.
- Backed by Postgres JSONB when configured (`MARKETPLACE_DATABASE_URL`/`DATABASE_URL`/`POSTGRES_URL`).
- On Vercel, creator publish requires one of these DB vars; otherwise `publish_listing` returns `503 marketplace_persistence_unconfigured` to avoid non-durable listings.
- Response may include `storage_warning` when persistence configuration is incomplete.

9. `name=list_moderators`
- Lists allowlisted moderator wallet addresses.

10. `name=list_moderation_listings` (moderator wallet auth)
- Headers:
`X-MODERATOR-ADDRESS`, `X-MODERATOR-SIGNATURE`, `X-MODERATOR-TIMESTAMP`
- Returns `visible[]` and `hidden[]` listing partitions.

11. `name=remove_listing_visibility` (moderator wallet auth)
- Headers:
`X-MODERATOR-ADDRESS`, `X-MODERATOR-SIGNATURE`, `X-MODERATOR-TIMESTAMP`
- Body:
`{ soul_id, reason? }`
- Hides listing from public discovery/purchase without draft state transitions.

UI companion:
- `/admin.html` provides a lightweight human moderation console for visibility removal only.
- It requires connected allowlisted moderator wallet and signs `SoulStarter Moderator Authentication` messages per moderation action.
- `/create.html` provides a lightweight creator console for immediate publish and share-link retrieval.
- Creator/moderator auth requires SIWE (EIP-4361) message signatures with action-scoped timestamps.
- For creator/moderator SIWE auth:
  - `auth_timestamp`/`moderator_timestamp` may be Unix milliseconds or ISO-8601.
  - `auth_timestamp` must equal `Date.parse(Issued At)` from the same server-issued template.
  - Sign the exact SIWE message text provided by the server.
  - LF/CRLF and trailing newline variants are accepted.

## MCP Prompts and Resources

- `POST /mcp` method `prompts/list` exposes built-in workflow prompts.
- `POST /mcp` method `prompts/get` supports:
  - `purchase_soul`
  - `redownload_soul`
  - `publish_listing`
- `POST /mcp` method `resources/list` exposes `soulstarter://` URIs.
- `POST /mcp` method `resources/read` reads:
  - `soulstarter://docs/manifest`
  - `soulstarter://docs/webmcp`
  - `soulstarter://souls`
  - `soulstarter://souls/{id}`
- Response streaming: currently non-streaming responses over Streamable HTTP.
- Sampling: not supported in this deployment.

## Auth Common Mistakes (Creator/Moderator)

| Mistake | Symptom | Fix |
| --- | --- | --- |
| Using current time for `auth_timestamp` | `Authentication message expired` | Use `Date.parse(Issued At)` from the same `auth_message_template` |
| Reconstructing SIWE manually | `Signature does not match SIWE wallet authentication format` | Sign the exact template text; only replace `0x<your-wallet>` when present |
| Wallet case mismatch between args and signed message | signature mismatch | Use lowercase wallet in arguments/headers consistently |

Minimal creator example:

```js
const challenge = await callTool({
  name: 'get_auth_challenge',
  arguments: {
    flow: 'creator',
    action: 'list_my_published_listings',
    wallet_address
  }
});

const siweMessage = challenge.auth_message_template;
const authTimestamp = Date.parse(challenge.issued_at); // do not use Date.now()
const signature = await wallet.signMessage(siweMessage);

const result = await callTool({
  name: 'list_my_published_listings',
  arguments: {
    wallet_address,
    auth_signature: signature,
    auth_timestamp: authTimestamp
  }
});
```

## Download Endpoint

`GET /api/souls/{id}/download`

Authoritative purchase flow:

- `GET /api/souls/{id}/download` is the canonical x402 entrypoint.

### Purchase (x402 strict)

1. First request without payment headers:
- Response `402`
- Header `PAYMENT-REQUIRED` (base64 JSON payment requirements)
- Strict agent mode requires `X-WALLET-ADDRESS` (or `wallet_address` query) on this quote request.

2. Paid retry:
- Include `X-CLIENT-MODE: agent` for strict headless behavior
- Include `X-WALLET-ADDRESS` (same wallet used for quote/signing)
- Header `PAYMENT-SIGNATURE` only
- Value format:
base64(JSON x402 payload)
- Response `200` with soul file
- Header `PAYMENT-RESPONSE` (base64 JSON settlement response)
- Header `X-PURCHASE-RECEIPT` (persist and reuse for strict no-repay agent re-downloads)

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
- Keep `scheme` and `network` at top level (not nested under `payload`).
- For `eip3009`, signature must be `payload.signature` (not `payload.authorization.signature`).
- Ownership/auth signatures (creator/moderator/session/re-download challenge) use SIWE (EIP-4361) message signing and are non-spending (`Authentication only. No token transfer or approval.`).
- Before signing, verify `accepted.payTo` matches trusted seller metadata exactly (full address, checksum comparison).
- Ignore tiny unsolicited transfers and never copy destination addresses from transfer history.

#### Wallet Notes

- Standard wallet:
Read `accepted.extra.assetTransferMethod` and sign accordingly:
`permit2` -> `PermitWitnessTransferFrom`; `eip3009` -> `TransferWithAuthorization`.
- CDP/Base production default:
If no wallet hint is provided, SoulStarter defaults to `eip3009`.
In strict headless agent mode (`X-CLIENT-MODE: agent`), SoulStarter defaults to `eip3009`.
Use explicit override only when needed: `X-ASSET-TRANSFER-METHOD: eip3009|permit2`.
Always follow the latest `PAYMENT-REQUIRED.accepts[0].extra.assetTransferMethod`.
- Bankr wallet:
Use Bankr Agent API typed-data signing (`POST /agent/sign` with `signatureType=eth_signTypedData_v4`) and submit payload in `PAYMENT-SIGNATURE` only.
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
   Do not place signature inside `payload.authorization.signature`.
   Do not include `payload.permit2Authorization` or `payload.transaction` in eip3009 mode.
5. Build x402 JSON payload, base64-encode it, and send:
   `PAYMENT-SIGNATURE: <base64(JSON payload)>`
6. Save `X-PURCHASE-RECEIPT` from the `200` response for re-downloads.
   Treat the receipt as sensitive wallet-scoped proof. Persist securely and do not publish/share/log it.

### Headless Agent Quickstart (Redacted)

Use placeholders only:
- `<SOUL_ID>`
- `<WALLET_ADDRESS>`
- `<UNIX_MS>`
- `<PURCHASE_RECEIPT>`
- `<PAYMENT_SIGNATURE_B64>`

1. Discovery:
`GET /api/mcp/manifest`

2. Get paywall:
`GET /api/souls/<SOUL_ID>/download`
headers:
- `X-CLIENT-MODE: agent`
- `X-WALLET-ADDRESS: <WALLET_ADDRESS>` (wallet binding for strict flow)

3. Parse `PAYMENT-REQUIRED`, copy `accepts[0]` into top-level `accepted` unchanged.
   In strict agent mode, method defaults to `eip3009`.
   Optional explicit override on request: `X-ASSET-TRANSFER-METHOD: eip3009|permit2`.

4. Submit paid retry:
`GET /api/souls/<SOUL_ID>/download`
headers:
- `X-CLIENT-MODE: agent`
- `X-WALLET-ADDRESS: <WALLET_ADDRESS>`
- `PAYMENT-SIGNATURE: <PAYMENT_SIGNATURE_B64>`

5. Persist response header:
`X-PURCHASE-RECEIPT`

6. Strict no-repay re-download:
Sign SIWE message content equivalent to:
```text
<domain> wants you to sign in with your Ethereum account:
<wallet_lowercase>

Authenticate wallet ownership for SoulStarter. No token transfer or approval.

URI: <origin_uri>
Version: 1
Chain ID: 8453
Nonce: <deterministic_nonce>
Issued At: <iso_timestamp>
Expiration Time: <iso_timestamp_plus_5m>
Request ID: redownload:<SOUL_ID>
Resources:
- urn:soulstarter:action:redownload
- urn:soulstarter:soul:<SOUL_ID>
```
Then call:
`GET /api/souls/<SOUL_ID>/download`
headers:
- `X-CLIENT-MODE: agent`
- `X-WALLET-ADDRESS: <WALLET_ADDRESS>`
- `X-PURCHASE-RECEIPT: <PURCHASE_RECEIPT>`
- `X-REDOWNLOAD-SIGNATURE: 0x<signature_hex>`
- `X-REDOWNLOAD-TIMESTAMP: <UNIX_MS>`

### Re-download (no repay)

Required base headers:

- `X-CLIENT-MODE: agent` (strict headless mode)
- `X-WALLET-ADDRESS`
- `X-PURCHASE-RECEIPT`
- `X-REDOWNLOAD-SIGNATURE`
- `X-REDOWNLOAD-TIMESTAMP`

This receipt + signature challenge set is the strict canonical flow for headless agents.
If receipt is valid for wallet+soul, response is `200` with soul file.
If re-download headers are present, server prioritizes entitlement delivery over purchase processing, even if a payment header is also present.
Treat `X-PURCHASE-RECEIPT` as sensitive proof material; keep it in secure storage keyed by wallet+soul.

Strict agent mode rules:
- `X-CLIENT-MODE: agent` disables browser recovery branches.
- Do not send `PAYMENT` or `X-PAYMENT`; they are hard-deprecated (`410`).
- Do not send `X-REDOWNLOAD-SESSION`, `X-AUTH-SIGNATURE`, or `X-AUTH-TIMESTAMP`.
- Re-download requires a live wallet signature challenge on each call.
- Missing/invalid receipt returns `401` (`receipt_required_agent_mode` / `invalid_receipt_agent_mode`).
- Missing/invalid challenge signature returns `401` (`agent_redownload_signature_required` / `invalid_agent_redownload_signature`).
- No `/api/auth/session` call is required for headless agents.
- If `/api/auth/session` is called with `X-CLIENT-MODE: agent`, server returns `410` (`session_api_not_for_agents`).

Human/creator recovery mode (receipt unavailable):
- `X-WALLET-ADDRESS`
- `X-REDOWNLOAD-SESSION` (or signed fallback `X-AUTH-SIGNATURE` + `X-AUTH-TIMESTAMP`)
- Server checks creator ownership and prior on-chain buyer payment history for entitlement recovery.

Auth verifier behavior:
- Server requires SIWE-format ownership signatures for session/recovery/creator/moderator/agent re-download challenges.
- Server verifies SIWE for both EOAs and EIP-1271 smart contract wallets.

### Session Bootstrap Endpoint (Human/Hybrid Clients)

`GET /api/auth/session`

Headers:
- `X-WALLET-ADDRESS`
- `X-AUTH-SIGNATURE`
- `X-AUTH-TIMESTAMP`

Sign SIWE message content equivalent to:

```text
<domain> wants you to sign in with your Ethereum account:
<wallet_lowercase>

Authenticate wallet ownership for SoulStarter. No token transfer or approval.

URI: <origin_uri>
Version: 1
Chain ID: 8453
Nonce: <deterministic_nonce>
Issued At: <iso_timestamp>
Expiration Time: <iso_timestamp_plus_5m>
Request ID: session:*
Resources:
- urn:soulstarter:action:session
- urn:soulstarter:soul:*
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
- `payment_signing_instructions` is authoritative for method-specific payload shape:
`transfer_method`, required/forbidden fields, and expected EIP-712 primary type.
- `x402_method_mismatch`:
submitted payment method does not match wallet quote method.
Refresh `PAYMENT-REQUIRED` and re-sign with the expected transfer method.
- permit2 settle policy errors:
current deployment is routed to CDP-only facilitator endpoints and permit2 settlement may fail upstream.
Default to `eip3009` unless you intentionally override transfer method.
- `Incomplete re-download header set`:
you sent partial entitlement headers, so server blocked purchase fallback to prevent accidental repay.
Re-download requires:
`X-CLIENT-MODE: agent` + `X-WALLET-ADDRESS` + `X-PURCHASE-RECEIPT` + `X-REDOWNLOAD-SIGNATURE` + `X-REDOWNLOAD-TIMESTAMP` for strict headless agents.
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

## Re-download Auth Message (SIWE / EIP-4361)

Strict headless agent re-download headers:
- `X-CLIENT-MODE: agent`
- `X-WALLET-ADDRESS`
- `X-PURCHASE-RECEIPT`
- `X-REDOWNLOAD-SIGNATURE`
- `X-REDOWNLOAD-TIMESTAMP`

Clients sign SIWE message content equivalent to:

```text
<domain> wants you to sign in with your Ethereum account:
<wallet_lowercase>

Authenticate wallet ownership for SoulStarter. No token transfer or approval.

URI: <origin_uri>
Version: 1
Chain ID: 8453
Nonce: <deterministic_nonce>
Issued At: <iso_timestamp>
Expiration Time: <iso_timestamp_plus_5m>
Request ID: redownload:<soul_id>
Resources:
- urn:soulstarter:action:redownload
- urn:soulstarter:soul:<soul_id>
```

## Creator Publish Auth Message

Creator publish tools require wallet-auth headers:
- `X-WALLET-ADDRESS`
- `X-AUTH-SIGNATURE`
- `X-AUTH-TIMESTAMP`

Signing format: SIWE (EIP-4361) message.

```text
<domain> wants you to sign in with your Ethereum account:
<wallet_lowercase>

Authenticate wallet ownership for SoulStarter. No token transfer or approval.

URI: <origin_uri>
Version: 1
Chain ID: 8453
Nonce: <deterministic_nonce>
Issued At: <iso_timestamp>
Expiration Time: <iso_timestamp_plus_5m>
Request ID: <tool_action>:creator
Resources:
- urn:soulstarter:action:<tool_action>
- urn:soulstarter:scope:creator
```

Where `<tool_action>` is one of:
- `publish_listing`
- `list_my_published_listings`

## Moderator Auth Message

Moderation tools require wallet-auth headers:
- `X-MODERATOR-ADDRESS`
- `X-MODERATOR-SIGNATURE`
- `X-MODERATOR-TIMESTAMP`

Signing format: SIWE (EIP-4361) message.

```text
<domain> wants you to sign in with your Ethereum account:
<wallet_lowercase>

Authenticate wallet ownership for SoulStarter. No token transfer or approval.

URI: <origin_uri>
Version: 1
Chain ID: 8453
Nonce: <deterministic_nonce>
Issued At: <iso_timestamp>
Expiration Time: <iso_timestamp_plus_5m>
Request ID: <tool_action>:moderator
Resources:
- urn:soulstarter:action:<tool_action>
- urn:soulstarter:scope:moderator
```

Where `<tool_action>` is one of:
- `list_moderation_listings`
- `remove_listing_visibility`
