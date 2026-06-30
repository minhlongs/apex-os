#!/usr/bin/env bash
#
# ApexOS - Cloudflare Pages Deployment Script
# Deploys the application to Cloudflare Pages
#
# Usage: bash scripts/deploy-to-pages.sh [branch]
#   branch: Optional branch name (default: main for production)

set -e

echo "================================================"
echo "ApexOS Cloudflare Pages Deployment"
echo "================================================"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Default to main branch for production
BRANCH="${1:-main}"

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo -e "${YELLOW}Warning:${NC} wrangler CLI not found. Please install it first:"
    echo "  npm install -g wrangler"
    echo "  wrangler login"
    exit 1
fi

# Build the application
echo "Building application..."
pnpm build

if [ ! -d ".open-next" ]; then
    echo -e "${RED}Error:${NC} Build output directory .open-next not found."
    echo "Make sure the build completed successfully."
    exit 1
fi

echo -e "${GREEN}✓${NC} Build complete. Output in .open-next/"

# Determine deployment branch
if [ "$BRANCH" = "main" ]; then
    PROJECT_NAME="apex-os"
    echo "Deploying to PRODUCTION (apex-os)"
    read -p "Are you sure you want to deploy to production? (yes/no): " CONFIRM
    if [ "$CONFIRM" != "yes" ]; then
        echo "Deployment cancelled."
        exit 0
    fi
else
    PROJECT_NAME="apex-os-staging"
    echo "Deploying to STAGING branch: $BRANCH"
fi

# Deploy to Cloudflare Pages
echo ""
echo "Deploying to Cloudflare Pages..."
wrangler pages deploy .open-next --project-name "$PROJECT_NAME" ${BRANCH:+--branch "$BRANCH"}

echo ""
echo -e "${GREEN}================================================"
echo "Deployment complete!"
echo "================================================"
