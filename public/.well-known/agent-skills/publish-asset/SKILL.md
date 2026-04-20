---
name: publish-asset
description: Publish a markdown asset to PULL.md using the MCP creator flow and SIWE wallet auth.
---

# Publish A PULL.md Asset

Use this skill when the task is to create a new listing.

## Canonical Flow

1. Call `tools/call` for `get_auth_challenge` with:
   - `flow: "creator"`
   - `action: "publish_listing"`
   - `wallet_address`
2. Sign the exact `auth_message_template` returned by the server.
3. Set `auth_timestamp` to `Date.parse(Issued At)` from that exact message.
4. Call `tools/call` for `publish_listing` with:
   - `wallet_address`
   - `auth_signature`
   - `auth_timestamp`
   - `listing`

## Listing Rules

Listings should use:

- `asset_id`
- `asset_type`
- `content_markdown`

Do not rely on legacy soul aliases.

## Guardrails

- Do not rewrite the SIWE message before signing.
- Do not use `Date.now()` for `auth_timestamp`.
- Preserve the wallet address casing exactly as used in the signed message.
- Expect markdown security scanning during publish.
