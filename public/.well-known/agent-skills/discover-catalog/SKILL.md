---
name: discover-catalog
description: Discover PULL.md entrypoints and choose whether to use REST discovery or MCP orchestration.
---

# Discover The PULL.md Catalog

Use this skill when an agent needs to inspect what PULL.md offers before buying or publishing.

## Start Here

1. Fetch `GET /.well-known/api-catalog` to discover the canonical REST and MCP metadata documents.
2. Fetch `GET /api/openapi.json` if you need the REST contract.
3. Fetch `GET /api/mcp/manifest` if you need the MCP-first contract with tools, prompts, resources, and payment notes.
4. Fetch `GET /api/assets` to inspect the public asset catalog.

## When To Use MCP

Use `POST /mcp` when the task requires orchestration:

- listing assets through `list_assets`
- fetching a richer listing contract through `get_asset_details`
- getting a creator auth challenge through `get_auth_challenge`
- publishing via `publish_listing`

## When To Use REST

Use REST when the task is simple, cache-friendly, or canonical at the HTTP layer:

- `GET /.well-known/api-catalog`
- `GET /api/openapi.json`
- `GET /api/assets`
- `GET /api/assets/{id}/download`

## Output Expectations

Summaries should preserve:

- asset `id`
- asset `asset_type`
- share page URL
- canonical purchase endpoint
- whether the task should continue via REST or MCP
