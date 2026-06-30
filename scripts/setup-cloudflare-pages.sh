#!/usr/bin/env bash
#
# ApexOS - Cloudflare Pages Setup Script
# Sets up Cloudflare Pages project and configuration
#
# Usage: bash scripts/setup-cloudflare-pages.sh

set -e

echo "================================================"
echo "ApexOS Cloudflare Pages Setup"
echo "================================================"
echo ""

# Check wrangler
if ! command -v wrangler &> /dev/null; then
    echo "Installing wrangler CLI..."
    npm install -g wrangler
fi

# Login if not already
echo "Checking Cloudflare authentication..."
if ! wrangler whoami &> /dev/null; then
    echo "Please login to Cloudflare:"
    wrangler login
fi

ACCOUNT_ID=$(wrangler whoami --format=json 2>/dev/null | grep -o '"account_id":"[^"]*"' | cut -d'"' -f4)

if [ -z "$ACCOUNT_ID" ]; then
    echo "Could not retrieve account ID. Please run: wrangler whoami"
    exit 1
fi

echo "Account ID: $ACCOUNT_ID"
echo ""

# Check D1 database
echo "Checking D1 database..."
DB_INFO=$(wrangler d1 list 2>/dev/null | grep "apex-os-db" || true)

if [ -z "$DB_INFO" ]; then
    echo "Creating D1 database 'apex-os-db'..."
    wrangler d1 create apex-os-db
else
    echo "D1 database already exists."
fi

# Get database ID
DB_ID=$(wrangler d1 list 2>/dev/null | grep "apex-os-db" | awk '{print $2}')
echo "Database ID: $DB_ID"
echo ""

# Update wrangler.toml with database ID
if ! grep -q "database_id = " wrangler.toml; then
    echo "Updating wrangler.toml with database ID..."
    sed -i.bak "s/database_id = \".*\"/database_id = \"$DB_ID\"/" wrangler.toml 2>/dev/null || \
    sed -i "" "s/database_id = \".*\"/database_id = \"$DB_ID\"/" wrangler.toml
    echo "Updated wrangler.toml"
else
    echo "wrangler.toml already has database_id configured."
fi

# Create Pages project via API
echo ""
echo "Creating Cloudflare Pages project..."
echo "Please go to https://pages.cloudflare.com/ and create a new project:"
echo "  - Name: apex-os"
echo "  - Connect your GitHub repository"
echo "  - Build command: pnpm build"
echo "  - Build output directory: .open-next"
echo "  - Node version: 20"
echo "  - Package manager: pnpm"
echo ""
echo "After creating the project, add the following environment variables:"
echo "See .env.production.example for the full list."

echo ""
echo -e "${GREEN}Setup complete!${NC}"
