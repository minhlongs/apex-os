#!/usr/bin/env bash
#
# migrate-to-affiliate.sh
# Migration script for ApexOS affiliate/cashback schema transformation
#
# This script is IDEMPOTENT - safe to run multiple times.
#
# It will:
#  1. Optionally backup current database
#  2. Drop old trading tables (signals, copy_relationships, paper_accounts)
#  3. Update profiles with new role values (shopper, affiliate)
#  4. Create new affiliate tables (affiliate_codes, deals, referral_tree, etc.)
#
# Usage:
#   ./scripts/migrate-to-affiliate.sh [--local] [--dry-run] [--backup]
#
# Options:
#   --local       Run against local D1 database (wrangler dev)
#   --dry-run     Show SQL without executing
#   --backup      Create database backup before migration
#   --help        Show this help message
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_SQL="$PROJECT_ROOT/src/database/migrations/003_affiliate_schema.sql"
BACKUP_DIR="$PROJECT_ROOT/backups"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default options
DRY_RUN=false
LOCAL=false
DO_BACKUP=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --local)
            LOCAL=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --backup)
            DO_BACKUP=true
            shift
            ;;
        --help|-h)
            grep '^#' "$0" | grep -v '#!/' | sed 's/^# \?//'
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  ApexOS Affiliate Schema Migration                        ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if migration SQL exists
if [[ ! -f "$MIGRATION_SQL" ]]; then
    echo -e "${RED}ERROR: Migration SQL not found at: $MIGRATION_SQL${NC}"
    exit 1
fi

# Check wrangler
if ! command -v wrangler &> /dev/null; then
    echo -e "${RED}ERROR: wrangler CLI not found. Install with: npm install -g wrangler${NC}"
    exit 1
fi

# Check if logged in to Cloudflare
if ! wrangler whoami &> /dev/null; then
    echo -e "${RED}ERROR: Not logged in to Cloudflare. Run: wrangler login${NC}"
    exit 1
fi

DATABASE="apex-os-db"

echo -e "${YELLOW}Configuration:${NC}"
echo "  Database: $DATABASE"
echo "  Local:    $LOCAL"
echo "  Backup:   $DO_BACKUP"
echo "  Dry-run:  $DRY_RUN"
echo "  SQL File: $MIGRATION_SQL"
echo ""

# Backup if requested
if [[ "$DO_BACKUP" == "true" ]]; then
    echo -e "${BLUE}Creating database backup...${NC}"
    mkdir -p "$BACKUP_DIR"
    BACKUP_FILE="$BACKUP_DIR/apex-os-db-backup-$(date +%Y%m%d-%H%M%S).sql"

    if [[ "$LOCAL" == "true" ]]; then
        wrangler d1 execute "$DATABASE" --local --command ".dump" > "$BACKUP_FILE" 2>/dev/null || true
    else
        wrangler d1 execute "$DATABASE" --command ".dump" > "$BACKUP_FILE" 2>/dev/null || true
    fi

    if [[ -f "$BACKUP_FILE" ]]; then
        echo -e "${GREEN}✓ Backup created: $BACKUP_FILE${NC}"
    else
        echo -e "${YELLOW}⚠ Backup skipped (database may be empty or local dev not running)${NC}"
    fi
    echo ""
fi

# Warning for production
if [[ "$LOCAL" == "false" ]]; then
    echo -e "${RED}⚠️  WARNING: This will modify the PRODUCTION database!${NC}"
    read -p "Are you sure you want to continue? (type 'YES' to confirm): " CONFIRM
    if [[ "$CONFIRM" != "YES" ]]; then
        echo "Migration cancelled."
        exit 0
    fi
else
    echo -e "${GREEN}Running against local database${NC}"
fi

echo ""
echo -e "${BLUE}Migration steps:${NC}"
echo "  1. Drop old trading tables (signals, copy_relationships, paper_accounts)"
echo "  2. Update profiles table with new role constraint (shopper, affiliate)"
echo "  3. Create affiliate_codes table"
echo "  4. Create deals table"
echo "  5. Create referral_tree table"
echo "  6. Create deal_clicks table"
echo "  7. Create conversions table"
echo "  8. Create earnings table"
echo "  9. Create payouts table"
echo " 10. Create auto-update triggers"
echo " 11. Create performance views"
echo ""

# Dry run: just show the SQL
if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "${YELLOW}=== DRY RUN - SQL that would be executed: ===${NC}"
    cat "$MIGRATION_SQL"
    echo ""
    echo -e "${YELLOW}=== End of dry run ===${NC}"
    exit 0
fi

# Execute migration
echo -e "${GREEN}Starting migration...${NC}"
echo ""

if [[ "$LOCAL" == "true" ]]; then
    # Local execution
    echo -e "${BLUE}Executing against local D1 database...${NC}"
    if wrangler d1 execute "$DATABASE" --file "$MIGRATION_SQL" --local; then
        MIGRATION_EXIT=0
    else
        MIGRATION_EXIT=$?
    fi
else
    # Production execution
    echo -e "${BLUE}Executing against production D1 database...${NC}"
    if wrangler d1 execute "$DATABASE" --file "$MIGRATION_SQL"; then
        MIGRATION_EXIT=0
    else
        MIGRATION_EXIT=$?
    fi
fi

# Check exit status
if [[ $MIGRATION_EXIT -eq 0 ]]; then
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║  ✅ Migration completed successfully!                     ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${BLUE}Verification queries:${NC}"
    echo "  # List all tables"
    echo "  wrangler d1 execute $DATABASE --command \"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\""
    echo ""
    echo "  # Show profiles schema"
    echo "  wrangler d1 execute $DATABASE --command \".schema profiles\""
    echo ""
    echo "  # Check for dropped tables (should not exist)"
    echo "  wrangler d1 execute $DATABASE --command \"SELECT name FROM sqlite_master WHERE name IN ('signals', 'copy_relationships', 'paper_accounts')\""
    echo ""
    echo "  # Show new affiliate tables"
    echo "  wrangler d1 execute $DATABASE --command \"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%deal%' OR name LIKE '%affiliate%' OR name LIKE '%conversion%' OR name LIKE '%earnings%' OR name LIKE '%payout%' OR name LIKE '%referral%'\""
    echo ""
    echo -e "${BLUE}Next steps:${NC}"
    echo "  1. Update TypeScript types in src/types/profile.ts"
    echo "     - Add wallet_address?, preferred_chain? if needed"
    echo "     - Update UserRole enum to include 'shopper' and 'affiliate'"
    echo ""
    echo "  2. Test the application: pnpm dev"
    echo ""
    echo "  3. If issues occur, restore from backup:"
    echo "     wrangler d1 execute $DATABASE --file $BACKUP_FILE"
    echo ""
    exit 0
else
    echo ""
    echo -e "${RED}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║  ❌ Migration failed with exit code $MIGRATION_EXIT!          ║${NC}"
    echo -e "${RED}╚════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${YELLOW}Troubleshooting:${NC}"
    echo "  1. Check database connection:"
    echo "     wrangler d1 execute $DATABASE --command \"SELECT 1\""
    echo ""
    echo "  2. Test the SQL file directly:"
    echo "     wrangler d1 execute $DATABASE --file $MIGRATION_SQL --local (if using local)"
    echo ""
    echo "  3. Check wrangler.toml configuration:"
    echo "     cat $PROJECT_ROOT/wrangler.toml"
    echo ""
    echo "  4. If you created a backup (--backup), restore with:"
    echo "     wrangler d1 execute $DATABASE --file backups/YYYYMMDD-HHMMSS.sql"
    echo ""
    exit $MIGRATION_EXIT
fi
