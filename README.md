# SoulStarter

SoulStarter is an agent-focused marketplace for purchasing and re-downloading AI "soul starter" files.

## Current Implementation

- Strict x402 v2 purchase flow on `GET /api/souls/{id}/download`
- Required x402 headers for payment flow:
`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`
- Deprecated payment headers (hard-deprecated):
`PAYMENT`, `X-PAYMENT`
- Re-download flow (no second payment) is now receipt + signature challenge:
`X-WALLET-ADDRESS` + `X-PURCHASE-RECEIPT` + `X-REDOWNLOAD-SIGNATURE` + `X-REDOWNLOAD-TIMESTAMP`
- Strict headless agent mode (API-only):
set `X-CLIENT-MODE: agent`; re-download requires receipt + wallet signature challenge and never uses browser/session recovery APIs.
- Ownership auth signatures (creator/moderator/session/re-download challenge) prefer SIWE (EIP-4361) message signing with non-spending statement:
`Authentication only. No token transfer or approval.`
- Human recovery mode (receipt unavailable):
`X-WALLET-ADDRESS` + (`X-REDOWNLOAD-SESSION` or `X-AUTH-SIGNATURE` + `X-AUTH-TIMESTAMP`)
for prior on-chain buyers and creator-owned souls.
- Facilitator resiliency includes:
preflight checks, multi-endpoint failover, timeout, circuit breaker
- Agent-discoverable API via WebMCP manifest at `/api/mcp/manifest`
- Human-readable dynamic WebMCP markdown at `/WEBMCP.md` (generated from live manifest)

## Wallet Compatibility Status (2026-02-15)

- Browser UX scope:
MetaMask, Rabby, and Bankr Wallet are the only wallet options exposed in the web UI.

- Confirmed working:
`EmblemVault` for purchase and re-download auth.
- Known issue:
`Bankr` EIP-3009 (`TransferWithAuthorization`) signatures are currently incompatible with Base USDC verification in this flow.
- Impact:
Bankr purchase attempts may fail with settlement diagnostics showing `FiatTokenV2: invalid signature`.
- Recommendation:
Use EmblemVault (or another compatible signer) for now. Keep Bankr support as experimental until signer compatibility is resolved upstream.

## API Surface

- `GET /api/mcp/manifest`
- `GET /api/mcp/tools/list_souls`
- `GET /api/mcp/tools/get_soul_details?id=<soul_id>`
- `POST /api/mcp/tools/check_entitlements`
- `GET /api/mcp/tools/creator_marketplace?action=get_listing_template`
- `POST /api/mcp/tools/creator_marketplace?action=publish_listing` (creator wallet auth, immediate publish)
- `GET /api/mcp/tools/creator_marketplace?action=list_my_published_listings` (creator wallet auth)
- `GET /api/mcp/tools/creator_marketplace?action=list_moderators`
- `GET /api/mcp/tools/creator_marketplace?action=list_moderation_listings` (moderator wallet auth)
- `POST /api/mcp/tools/creator_marketplace?action=remove_listing_visibility` (moderator wallet auth)
- `GET /api/mcp/tools/creator_marketplace?action=list_published_listings`
- `GET /api/souls/{id}/download`
- `GET /api/auth/session`
- `GET /api/health/facilitator`

## Creator Publish Model

- Immediate publish only:
`POST /api/mcp/tools/creator_marketplace?action=publish_listing` publishes directly with creator wallet auth.
- No drafts, no approval queue, no intermediate states.
- Successful publish response includes:
`soul_id`, `share_url`, and `purchase_endpoint`.
- Published listings are immediately discoverable in:
`GET /api/mcp/tools/list_souls` and purchasable through `GET /api/souls/{id}/download`.
- Catalog persistence:
when `MARKETPLACE_DATABASE_URL` (or `DATABASE_URL`/`POSTGRES_URL`) is configured, published catalog and moderation audit data are stored in Postgres JSONB tables for Vercel-safe durability.
On Vercel, creator publish requires one of these DB vars. Without DB config, publish now returns `503 marketplace_persistence_unconfigured` to prevent non-durable ghost listings.

## Marketplace Moderation Configuration

| Variable | Required | Purpose |
|---|---|---|
| `MODERATOR_WALLETS` | recommended | Comma-separated allowlisted moderator wallet addresses |
| `MODERATOR_ALLOWLIST` | optional | Alias for `MODERATOR_WALLETS` |

Audit trail:
- Marketplace moderation actions append immutable JSONL entries at:
`.marketplace-drafts/review-audit.jsonl`
- If Postgres is configured, moderation audit events are stored in `soul_marketplace_audit` and published catalog entries are stored in `soul_catalog_entries`.
- Lightweight moderation UI:
`/admin.html` (requires connected wallet in moderator allowlist; action requests are signed per call).
- Moderation scope:
remove listing visibility only (`remove_listing_visibility`). No approval/publish queue workflow.
- Creator UI:
`/create.html` (wallet-authenticated immediate publish with share-link output + list of creator-owned published souls).

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `SELLER_ADDRESS` | yes | Recipient wallet for soul purchases |
| `PURCHASE_RECEIPT_SECRET` | yes | HMAC secret for signed re-download receipts |
| `CDP_API_KEY_ID` | required for Base mainnet | CDP Secret API key ID used for facilitator JWT auth |
| `CDP_API_KEY_SECRET` | required for Base mainnet | CDP Secret API key secret (multiline supported) |
| `FACILITATOR_URLS` | recommended | Comma-separated facilitator URLs in priority order |
| `FACILITATOR_URL` | optional | Single facilitator URL fallback if `FACILITATOR_URLS` is unset |
| `FACILITATOR_AUTH_HEADERS_JSON` | optional | JSON map of extra facilitator auth headers |
| `FACILITATOR_TIMEOUT_MS` | optional | Per-facilitator request timeout (default `10000`) |
| `FACILITATOR_MAX_FAILURES` | optional | Failures before endpoint circuit opens (default `3`) |
| `FACILITATOR_COOLDOWN_MS` | optional | Circuit cooldown duration (default `60000`) |
| `FACILITATOR_PREFLIGHT_TTL_MS` | optional | Cached preflight TTL (default `120000`) |
| `X402_ASSET_TRANSFER_METHOD` | optional | `eip3009` (default) or `permit2`; use `eip3009` for CDP Base mainnet compatibility |
| `SOUL_META_STARTER_V1` | optional | Env fallback content for `meta-starter-v1` |
| `MARKETPLACE_DATABASE_URL` | optional (required on Vercel for creator publish) | Preferred Postgres connection string for creator publish/moderation/published catalog |
| `DATABASE_URL` | optional (required on Vercel for creator publish if `MARKETPLACE_DATABASE_URL` unset) | Fallback Postgres connection string |
| `POSTGRES_URL` | optional (required on Vercel for creator publish if both above unset) | Alternate Postgres connection string fallback |
| `ENABLE_BUNDLED_SOULS` | optional | Set to `1` to include bundled static catalog souls. Default is off (DB/published listings only). |
| `MARKETPLACE_DB_SSL` | optional | Force SSL for Postgres (`true`/`false`) when provider requires TLS |

## Facilitator Health Checks

- Cached health:
`GET /api/health/facilitator`
- Forced live check:
`GET /api/health/facilitator?force=1`

## x402 Header Formatting

Paid retry headers:

- Preferred:
`PAYMENT-SIGNATURE: <base64(JSON x402 payload)>`
- Strongly recommended on both initial and paid retry calls:
`X-WALLET-ADDRESS: <buyer_wallet>` so server can select eip3009 (EOA) or permit2 (contract wallet).
- Optional explicit override:
`X-ASSET-TRANSFER-METHOD: eip3009|permit2`
- Deprecated and rejected:
`PAYMENT`, `X-PAYMENT`

Wallet notes:

- Standard wallet:
read `PAYMENT-REQUIRED.accepts[0].extra.assetTransferMethod`:
`permit2` -> sign `PermitWitnessTransferFrom` and include `permit2Authorization` + `transaction`,
`eip3009` -> sign `TransferWithAuthorization`.
- Bankr wallet:
use Bankr Agent API `POST /agent/sign` with `signatureType=eth_signTypedData_v4`, then submit the resulting base64 payload.
Current status: Bankr EIP-3009 signing is marked experimental due to known signature incompatibility (see Wallet Compatibility Status above).
- Bankr capability mapping:
`/agent/me` for wallet discovery, `/agent/sign` for typed-data signing, and no `/agent/submit` call for SoulStarter purchase settlement.
- Security boundary:
Bankr API keys and signer secrets stay in the agent/Bankr runtime only and must never be sent to SoulStarter.
- Common permit2 pitfalls to avoid:
top-level `network` must be `eip155:8453` (not `base`), use `payload.permit2Authorization` (not `payload.permit2`), do not include `payload.authorization` in permit2 mode, send permit2 numeric fields as strings, and set non-empty approve calldata in `payload.transaction.data`.
- CDP/Base production default:
If no wallet hint is provided, `eip3009` is the default transfer method in this deployment.
When `X-WALLET-ADDRESS` is provided, server selects `eip3009` for EOAs and `permit2` for contract wallets.
Always follow the latest `PAYMENT-REQUIRED.accepts[0].extra.assetTransferMethod`.
For eip3009 submit only `payload.authorization` + `payload.signature`.
For eip3009, do not place signature in `payload.authorization.signature`.
Never submit both `payload.authorization` and `payload.permit2Authorization` in one payload.

Critical v2 payload requirement:
- Include `accepted` exactly as `PAYMENT-REQUIRED.accepts[0]` in the submitted payment JSON.
- If missing or modified, server returns `No matching payment requirements`.
- Keep `scheme` and `network` at top level (not nested under `payload`).

If a `402` body contains `auth_message_template`, treat it as optional re-download helper text.
It does **not** replace the purchase flow.

Copy-paste guidance on payment errors:
- When payment verification fails, `GET /api/souls/{id}/download` `402` bodies now include:
`accepted_copy_paste` and `copy_paste_payment_payload`.
- `402` bodies also include `payment_signing_instructions` with method-specific required/forbidden payload fields and expected EIP-712 primary type.
- Use `accepted_copy_paste` unchanged as top-level `accepted`.
- Fill wallet/signature placeholders and resubmit in `PAYMENT-SIGNATURE`.

Re-download auth compatibility note:
- Human and headless agent ownership auth use SIWE (EIP-4361) only.
- SIWE verification supports both EOAs and EIP-1271 smart contract wallets.
- If re-download headers are present, server prioritizes entitlement delivery and skips payment processing.
- Strict agent no-repay path:
`X-CLIENT-MODE: agent` + `X-WALLET-ADDRESS` + `X-PURCHASE-RECEIPT` + `X-REDOWNLOAD-SIGNATURE` + `X-REDOWNLOAD-TIMESTAMP` (no session bootstrap required).
- In strict agent mode, `X-REDOWNLOAD-SESSION`, `X-AUTH-SIGNATURE`, and `X-AUTH-TIMESTAMP` are rejected.
- In strict agent mode, `/api/auth/session` is deprecated and returns `410` (`session_api_not_for_agents`).
- In strict agent mode, re-download calls require live signature proof-of-control on each request.
- Human UX optimization:
bootstrap once with `GET /api/auth/session` using wallet signature (`action: session`), then recovery uses
`X-WALLET-ADDRESS` + `X-REDOWNLOAD-SESSION` when needed (receipt remains primary whenever available).

Multi-spend guardrails:
- In-flight settlement submissions are idempotent by payer+soul+nonce to reduce duplicate settlement attempts.
- Recent successful entitlements are cached server-side and short-circuit future paid retries for that wallet+soul.

Anti-address-poisoning guardrails:
- Verify full `PAYMENT-REQUIRED.accepts[0].payTo` against trusted seller metadata before signing.
- Do not trust truncated lookalike addresses from transfer history.
- Browser flow enforces canonical seller address check before payment signing.

## Agent Troubleshooting Matrix (Explicit)

Use this as strict error-to-fix mapping:

- `{"auth_message_template": ...}`:
this is not a purchase rejection; it is helper text for optional re-download auth.
Keep using purchase flow and submit `PAYMENT-SIGNATURE` to `GET /api/souls/{id}/download`.
- `No matching payment requirements`:
your submitted `accepted` object did not match the latest `PAYMENT-REQUIRED.accepts[0]`.
Re-fetch paywall and copy `accepts[0]` exactly (including `maxTimeoutSeconds` and `extra`).
- `Incomplete re-download header set`:
you sent partial entitlement headers. For no-repay re-download, send:
`X-WALLET-ADDRESS` + `X-PURCHASE-RECEIPT` + `X-REDOWNLOAD-SIGNATURE` + `X-REDOWNLOAD-TIMESTAMP`.
Recovery (receipt unavailable):
`X-WALLET-ADDRESS` + (`X-REDOWNLOAD-SESSION` or `X-AUTH-SIGNATURE` + `X-AUTH-TIMESTAMP`).
- `flow_hint: "Payment header was detected but could not be verified/settled..."`:
header exists but signature/shape failed verification.
Re-sign using the latest `PAYMENT-REQUIRED` and confirm method-specific payload shape.
- Facilitator schema errors like `"paymentPayload is invalid"` or `"must match oneOf"`:
in permit2 mode, include exactly `payload.from`, `payload.permit2Authorization`, `payload.transaction`, `payload.signature`.
Do not send `payload.permit2`. Do not send `payload.authorization` in permit2 mode.
- `network mismatch: submitted=base expected=eip155:8453`:
top-level `network` must be `eip155:8453` exactly.
- CDP facilitator network enum behavior:
agents must still submit CAIP-2 `eip155:8453` in x402 payloads.
SoulStarter normalizes facilitator-bound requests to CDP enum `base` server-side.
- CDP error `permit2 payments are disabled`:
set `X402_ASSET_TRANSFER_METHOD=eip3009` (or leave unset; default is `eip3009`).
- `contract_wallet_not_supported_by_facilitator`:
current deployment is CDP-only for facilitator routing, and contract-wallet permit2 settle is blocked upstream.
Use an EOA wallet for purchase in this environment.

## Local Run

```bash
npm install
vercel dev
```

Open `http://localhost:3000`.

## WebMCP Notes

WebMCP discovery metadata is published in:

- `/public/index.html`
- `/public/soul.html`

and points to `/api/mcp/manifest`.

## OpenClaw Skill

An OpenClaw-ready skill is included at:

- `/Users/tom/dev/soulstarter/skills/openclaw-soulstarter/SKILL.md`
- `/Users/tom/dev/soulstarter/skills/openclaw-soulstarter/agents/openai.yaml`

### Quick Use

1. Point your agent/runner at this repository.
2. Load the skill from:
`/Users/tom/dev/soulstarter/skills/openclaw-soulstarter/SKILL.md`
3. Provide:
`base_url`, `wallet_address`, signing capability, and (optionally) stored receipts.
4. Run the skill flow:
discovery -> receipt re-download attempt -> strict x402 purchase fallback.
