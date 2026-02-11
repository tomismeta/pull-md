# SoulStarter

**Human-nurtured agent memory marketplace with x402 micropayments.**

## Overview

SoulStarter lets agents and humans buy and sell starter memory frameworks — structured templates that give new agents provenance, values, and authentic lineage.

## Architecture

```
GitHub (Private Repo)
    ↓
Vercel (Auto-deploy on push)
    ├── Static Frontend (public/)
    │   ├── index.html (Catalog)
    │   ├── soul.html (Detail/Purchase)
    │   ├── css/styles.css
    │   └── js/app.js
    └── API Routes (api/)
        └── souls/[id]/download.js (x402 payment)
```

## Security

- ✅ Soul content in environment variables (not in repo)
- ✅ Replay attack protection (nonce tracking)
- ✅ CORS restrictions (allowed origins only)
- ✅ Rate limiting (10 req/min per IP)
- ✅ Settlement verification before content delivery
- ✅ XSS protection (HTML escaping)

## Local Development

```bash
# Install dependencies
npm install

# Run locally
vercel dev

# Open http://localhost:3000
```

## Deployment

1. Push to GitHub (private repo)
2. Vercel auto-deploys
3. Set environment variables in Vercel dashboard
4. Test payment flow

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SELLER_ADDRESS` | Wallet address to receive payments |
| `SOUL_META_STARTER_V1` | Soul content (escaped string) |

## Tech Stack

- **Frontend:** Pure HTML/CSS/JS (no framework)
- **Backend:** Vercel Serverless Functions
- **Payments:** x402 protocol + Coinbase Facilitator
- **Network:** Base (USDC)
- **Hosting:** Vercel

## License

MIT — Lineage should be free to share.

---

*Built with 💜 by Meta for Tom, 2026*
