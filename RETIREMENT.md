# PULL.md Retirement Runbook

PULL.md entered retirement on August 21, 2026. This runbook records the operational contract required to keep the shutdown safe and reversible during the entitlement recovery window.

## Production Contract

- `GET /` remains available as the canonical human and agent-readable retirement notice.
- MCP, publishing, moderation, auth, catalog, discovery, and new-purchase endpoints return `410 Gone`.
- `GET /api/assets/{id}/download` accepts existing entitlement proof only through `2026-09-21T23:59:59.000Z`.
- Unpaid requests and `PAYMENT-SIGNATURE` retries return `410 Gone` before x402 quote or settlement code runs.
- Recovery closes automatically after the cutoff; no follow-up deployment is required.

## Retained Infrastructure

Do not remove or rotate the following before the recovery cutoff:

- the `pull.md` domain and Vercel project
- the production database
- `PURCHASE_RECEIPT_SECRET` and any configured previous receipt secrets
- `SELLER_ADDRESS` and blockchain RPC configuration used to verify historical entitlement proofs
- bundled and published markdown content needed for delivery

The GitHub repository may be archived after the retirement deployment is verified. Archiving the repository does not remove the Vercel deployment or production data.

## Backup

A production export was completed before deployment at `~/pull-md-retirement-backups/2026-08-21-production`.

- Tables: 8
- Rows: 2,665
- SHA-256 checksums verified: 8 of 8
- Directory permissions: `0700`
- File permissions: `0600`

To create another immutable export:

```bash
npm run db:export-retirement -- /absolute/new/output/directory
```

The export command refuses to overwrite an existing directory or file.

## Verification

Run these checks after preview and production deployments:

```bash
curl -i https://pull.md/
curl -i -H 'Accept: text/markdown' https://pull.md/
curl -i https://pull.md/mcp
curl -i https://pull.md/api/assets
curl -i https://pull.md/api/openapi.json
curl -i https://pull.md/.well-known/api-catalog
curl -i https://pull.md/api/assets/meta-starter-v1/download
curl -i https://pull.md/robots.txt
curl -i https://pull.md/sitemap.xml
```

Expected results:

- Root HTML and markdown return `200` with `X-PULLMD-RETIRED: true`.
- Former APIs return `410` with `Content-Type: application/problem+json`.
- An unentitled download returns `410` with `Cache-Control: private, no-store, max-age=0`.
- A valid historical receipt returns the original markdown before the cutoff.
- Robots and sitemap return `200` and advertise only the retirement notice.

Never paste a production receipt, wallet signature, secret, or database row into logs or issue comments while testing recovery.

## After The Cutoff

After September 21, verify that entitlement requests return `410` and the response reports `existing_entitlement_recovery: retired`. Keep the retirement notice and domain under owner control unless a separate decision is made to remove them. Database deletion, secret rotation, and Vercel project removal are independent destructive actions and are not part of this retirement deployment.
