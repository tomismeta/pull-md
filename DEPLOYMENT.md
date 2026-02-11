# SoulStarter Deployment Guide

## GitHub Repository ✅

**URL:** https://github.com/openmetaloom/soulstarter
**Visibility:** Private
**Branch:** main

## Vercel Deployment Steps

### 1. Connect Vercel to GitHub

```bash
# Install Vercel CLI if needed
npm i -g vercel

# Login to Vercel
vercel login

# Link to GitHub repo
vercel --confirm
```

Or use Vercel Dashboard:
1. Go to https://vercel.com/dashboard
2. Click "Add New Project"
3. Import from GitHub
4. Select `openmetaloom/soulstarter`
5. Deploy

### 2. Set Environment Variables

In Vercel Dashboard → Project Settings → Environment Variables:

| Name | Value |
|------|-------|
| `SELLER_ADDRESS` | `0xa7d395faf5e0a77a8d42d68ea01d2336671e5f55` |
| `SOUL_META_STARTER_V1` | *(see below)* |

#### Prepare Soul Content

Convert SOUL.md to escaped string:

```bash
cat souls-content/meta-starter-v1.txt | jq -Rs '.'
```

Copy the output (including quotes) and paste as `SOUL_META_STARTER_V1` value.

### 3. Configure Domains (Optional)

Add custom domain:
1. Project Settings → Domains
2. Add `soulstarter.io` or your preferred domain
3. Follow DNS instructions

### 4. Deploy

```bash
# Deploy to production
vercel --prod
```

Or push to main branch — Vercel auto-deploys.

## Post-Deployment Checklist

- [ ] Site loads at Vercel URL
- [ ] Wallet connection works
- [ ] Test payment with $0.50 USDC on Base
- [ ] Verify payment arrives in seller wallet
- [ ] Soul downloads correctly after payment
- [ ] Replay attack protection works (try using same payment twice)

## Monitoring

- Vercel Dashboard: https://vercel.com/dashboard
- Function Logs: Project → Functions tab
- Analytics: Project → Analytics tab

## Rollback

If issues occur:
```bash
# Rollback to previous deployment
vercel rollback
```

Or use Vercel Dashboard → Deployments → Previous version → Promote

## Security Notes

- Environment variables are encrypted at rest
- Only Vercel team members can view them
- GitHub repo is private
- No secrets in code

---

**Ready to deploy?** Run `vercel --prod` after setting environment variables.
