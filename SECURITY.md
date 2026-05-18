# Security Notes

## Dependency Audit Policy

The production dependency gate is:

```sh
npm run audit:prod
```

This runs `npm audit --omit=dev` and should remain clean before production deploys.

For visibility into the full local toolchain, run:

```sh
npm run audit:all
```

As of 2026-05-18, the production/runtime dependency graph has zero npm audit findings.
The remaining full-audit findings are isolated to the dev-only `vercel` CLI dependency tree
(`vercel`, `@vercel/node`, framework adapters that depend on `@vercel/node`, and its nested
`undici` path).

Do not downgrade the Vercel CLI only to satisfy `npm audit fix --force`. In the current npm
advisory data, that suggested downgrade targets an older major version and is not the deploy
toolchain we run. Prefer upgrading Vercel normally when a patched release is available, then
rerun both audit commands and `npm run test:all`.

## Expected Validation

Before dependency or deployment changes are merged, run:

```sh
npm install
npm run audit:prod
npm run test:all
npx vercel build
```
