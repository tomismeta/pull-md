# SoulStarter

SoulStarter is an agent-focused marketplace for purchasing and re-downloading AI "soul starter" files.

## Current Implementation

- Strict x402 v2 purchase flow on `GET /api/souls/{id}/download`
- Required x402 headers for payment flow:
`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` (or `PAYMENT` / `X-PAYMENT`), `PAYMENT-RESPONSE`
- Re-download flow (no second payment) uses:
`X-WALLET-ADDRESS`, `X-AUTH-SIGNATURE`, `X-AUTH-TIMESTAMP`, `X-PURCHASE-RECEIPT`
- Facilitator resiliency includes:
preflight checks, multi-endpoint failover, timeout, circuit breaker
- Agent-discoverable API via WebMCP manifest at `/api/mcp/manifest`

## API Surface

- `GET /api/mcp/manifest`
- `GET /api/mcp/tools/list_souls`
- `GET /api/mcp/tools/get_soul_details?id=<soul_id>`
- `POST /api/mcp/tools/purchase_soul`
- `POST /api/mcp/tools/check_entitlements`
- `GET /api/souls/{id}/download`
- `GET /api/health/facilitator`

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
| `WALLETCONNECT_PROJECT_ID` | optional | WalletConnect Cloud project ID for browser wallet UX |
| `SOUL_META_STARTER_V1` | optional | Env fallback content for `meta-starter-v1` |

## Facilitator Health Checks

- Cached health:
`GET /api/health/facilitator`
- Forced live check:
`GET /api/health/facilitator?force=1`

## x402 Header Formatting

Paid retry headers:

- Preferred:
`PAYMENT-SIGNATURE: <base64(JSON x402 payload)>`
- Also accepted:
`PAYMENT: <base64(JSON x402 payload)>`
`X-PAYMENT: <base64(JSON x402 payload)>`

Wallet notes:

- Standard wallet:
read `PAYMENT-REQUIRED.accepts[0].extra.assetTransferMethod`:
`permit2` -> sign `PermitWitnessTransferFrom` and include `permit2Authorization` + `transaction`,
`eip3009` -> sign `TransferWithAuthorization`.
- Bankr wallet:
use Bankr Agent API `POST /agent/sign` with `signatureType=eth_signTypedData_v4`, then submit the resulting base64 payload.
- Bankr capability mapping:
`/agent/me` for wallet discovery, `/agent/sign` for typed-data signing, and no `/agent/submit` call for SoulStarter purchase settlement.
- Security boundary:
Bankr API keys and signer secrets stay in the agent/Bankr runtime only and must never be sent to SoulStarter.
- Common permit2 pitfalls to avoid:
top-level `network` must be `eip155:8453` (not `base`), use `payload.permit2Authorization` (not `payload.permit2`), do not include `payload.authorization` in permit2 mode, send permit2 numeric fields as strings, and set non-empty approve calldata in `payload.transaction.data`.

Critical v2 payload requirement:
- Include `accepted` exactly as `PAYMENT-REQUIRED.accepts[0]` in the submitted payment JSON.
- If missing or modified, server returns `No matching payment requirements`.

If a `402` body contains `auth_message_template`, treat it as optional re-download helper text.
It does **not** replace the purchase flow.

## Agent Troubleshooting Matrix (Explicit)

Use this as strict error-to-fix mapping:

- `{"auth_message_template": ...}`:
this is not a purchase rejection; it is helper text for optional re-download auth.
Keep using purchase flow and submit `PAYMENT-SIGNATURE` to `GET /api/souls/{id}/download`.
- `No matching payment requirements`:
your submitted `accepted` object did not match the latest `PAYMENT-REQUIRED.accepts[0]`.
Re-fetch paywall and copy `accepts[0]` exactly (including `maxTimeoutSeconds` and `extra`).
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
