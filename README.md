# SoulStarter

SoulStarter is an agent-focused marketplace for purchasing and re-downloading AI "soul starter" files.

## Current Implementation

- Strict x402 v2 purchase flow on `GET /api/souls/{id}/download`
- Required x402 headers for payment flow:
`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`
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
| `FACILITATOR_URLS` | recommended | Comma-separated facilitator URLs in priority order |
| `FACILITATOR_URL` | optional | Single facilitator URL fallback if `FACILITATOR_URLS` is unset |
| `FACILITATOR_AUTH_HEADERS_JSON` | optional | JSON map of extra facilitator auth headers |
| `FACILITATOR_TIMEOUT_MS` | optional | Per-facilitator request timeout (default `10000`) |
| `FACILITATOR_MAX_FAILURES` | optional | Failures before endpoint circuit opens (default `3`) |
| `FACILITATOR_COOLDOWN_MS` | optional | Circuit cooldown duration (default `60000`) |
| `FACILITATOR_PREFLIGHT_TTL_MS` | optional | Cached preflight TTL (default `120000`) |
| `WALLETCONNECT_PROJECT_ID` | optional | WalletConnect Cloud project ID for browser wallet UX |
| `SOUL_META_STARTER_V1` | optional | Env fallback content for `meta-starter-v1` |

## Facilitator Health Checks

- Cached health:
`GET /api/health/facilitator`
- Forced live check:
`GET /api/health/facilitator?force=1`

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
