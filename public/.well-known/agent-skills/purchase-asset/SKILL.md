---
name: purchase-asset
description: Buy or re-download a markdown asset from PULL.md using the canonical x402 flow.
---

# Purchase A PULL.md Asset

Use this skill when the task is to buy or re-download an existing listing.

## Canonical Flow

1. Call `GET /api/assets/{id}/download` with no payment header.
2. Read the `402 PAYMENT-REQUIRED` response and capture `accepts[0]`.
3. Build the x402 payload exactly as instructed.
4. Retry `GET /api/assets/{id}/download` with `PAYMENT-SIGNATURE`.
5. Persist `X-PURCHASE-RECEIPT` securely after a successful `200`.

## Re-download Flow

For strict agent mode, send:

- `X-CLIENT-MODE: agent`
- `X-WALLET-ADDRESS`
- `X-PURCHASE-RECEIPT`
- `X-REDOWNLOAD-SIGNATURE`
- `X-REDOWNLOAD-TIMESTAMP`

Do not re-pay if a valid receipt already exists.

## Guardrails

- Use the exact `accepted` object returned by the server.
- Do not reconstruct the payment request from memory.
- Treat purchase receipts as sensitive proof material.
- Never share payment signatures or receipts in logs or public output.
