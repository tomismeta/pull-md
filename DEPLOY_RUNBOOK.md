# PullMd Deploy Runbook

## Production Deploy Command

```bash
npx vercel --prod --yes --token <VERCEL_TOKEN>
```

## Important Vercel Team Policy

This project enforces a **Git author access check** at deploy time.

If deploy fails with:

`Git author <email> must have access to the team ... projects on Vercel`

then Vercel is validating the commit author email from `HEAD`.

## Working Fix (Used Successfully)

1. Check token owner email:

```bash
npx vercel api /v2/user --token <VERCEL_TOKEN>
```

2. Set repo-local git author to that email:

```bash
git config user.name "openmetaloom"
git config user.email "openmetaloom@gmail.com"
```

3. Create a new commit so `HEAD` has an allowed author:

```bash
git add -A
git commit -m "feat: simplify creator publish flow and hide-only moderation"
```

4. Deploy again:

```bash
npx vercel --prod --yes --token <VERCEL_TOKEN>
```

## Verify Production Alias

```bash
npx vercel inspect pullmd.vercel.app --token <VERCEL_TOKEN> --scope open-meta-looms-projects
```

Look for:
- `status: Ready`
- `url: https://pullmd-<deployment>.vercel.app`
- alias includes `https://pullmd.vercel.app`

## Rollback (No Rebuild)

Use if needed:

```bash
npx vercel ls pullmd --token <VERCEL_TOKEN> --scope open-meta-looms-projects
npx vercel promote <deployment-url> --token <VERCEL_TOKEN> --scope open-meta-looms-projects
```

## Telemetry Emergency Controls

Immediate kill switch (no code rollback):

1. In Vercel project env vars, set:
   - `TELEMETRY_ENABLED=false`
2. Redeploy production.

This disables telemetry ingestion and moderator telemetry dashboard reads while keeping purchase/re-download flows active.

Telemetry schema isolation:

1. In Vercel project env vars, set:
   - `TELEMETRY_DB_SCHEMA=telemetry`
2. Redeploy production.

Telemetry tables will be created under `<schema>.marketplace_telemetry_events`.
When schema is non-`public`, legacy `public.marketplace_telemetry_events` is dropped automatically (no migration path).

Full code rollback:

1. Revert the isolated telemetry commit:

```bash
git revert <telemetry-commit-sha>
git push origin main
```

2. Deploy production:

```bash
npx vercel --prod --yes --token <VERCEL_TOKEN>
```
