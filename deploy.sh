#!/bin/bash
# SoulStarter Deployment Script
# Run this to deploy to Vercel

set -e

echo "🔮 SoulStarter Deployment Script"
echo "================================"

# Check if logged in to Vercel
if ! vercel whoami &>/dev/null; then
  echo "❌ Not logged in to Vercel"
  echo "Please run: vercel login"
  exit 1
fi

echo "✅ Logged in to Vercel"

# Check if project is linked
if [ ! -d ".vercel" ]; then
  echo "🔗 Linking project to Vercel..."
  vercel link --confirm
fi

# Set environment variables
echo "🔧 Setting environment variables..."

# Seller address (my Bankr wallet)
SELLER_ADDRESS="0xa7d395faf5e0a77a8d42d68ea01d2336671e5f55"

# Soul content (escaped)
SOUL_CONTENT=$(cat souls-content/meta-starter-v1.txt | jq -Rs '.')

echo "📤 Uploading SELLER_ADDRESS..."
echo "$SELLER_ADDRESS" | vercel env add SELLER_ADDRESS production

echo "📤 Uploading SOUL_META_STARTER_V1..."
echo "$SOUL_CONTENT" | vercel env add SOUL_META_STARTER_V1 production

# Deploy
echo "🚀 Deploying to production..."
vercel --prod

echo ""
echo "✅ Deployment complete!"
echo ""
echo "Next steps:"
echo "1. Visit your deployed URL"
echo "2. Test wallet connection"
echo "3. Test purchase with $0.50 USDC on Base"
echo "4. Verify payment arrives in Bankr wallet"
