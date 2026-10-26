#!/usr/bin/env bash
# scripts/reconcile-historical-payouts.sh
# Phase 07 Mandatory Pre-Flight: Read-Only Historical Payout & Earnings Ledger Reconciliation
#
# Usage:
#   bash scripts/reconcile-historical-payouts.sh [--remote] [--config wrangler.jsonc]
#
# By default, runs against local D1 unless --remote is passed.
# Never mutates or deletes any row.

set -euo pipefail

export PATH="/opt/homebrew/opt/node@26/bin:$(pwd)/node_modules/.bin:${PATH}"

REMOTE_FLAG=""
CONFIG_FILE="wrangler.jsonc"
DB_NAME="apex-os-db"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)
      REMOTE_FLAG="--remote"
      shift
      ;;
    --staging)
      CONFIG_FILE="wrangler.staging.jsonc"
      DB_NAME="apex-os-staging-db"
      shift
      ;;
    --config)
      CONFIG_FILE="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

echo "============================================================"
echo " ApexOS Phase 07 Historical Payout Reconciliation (Read-Only)"
echo " Config: ${CONFIG_FILE} | Database: ${DB_NAME} | Mode: ${REMOTE_FLAG:-local}"
echo "============================================================"

# 1. Completed payouts missing transaction_id or containing MOCK_SIGNED_TX_PAYLOAD or non-Stellar chain
ANOMALOUS_PAYOUTS_SQL="SELECT id, affiliate_id, amount, net_amount, status, chain, transaction_id, created_at FROM payouts WHERE (status = 'completed' AND (transaction_id IS NULL OR trim(transaction_id) = '' OR lower(coalesce(chain, 'stellar')) IN ('solana', 'ethereum'))) OR transaction_id LIKE '%MOCK_SIGNED%' ORDER BY created_at DESC;"

# 2. Earnings marked is_paid = 1 without a completed payout
ORPHANED_EARNINGS_SQL="SELECT e.id, e.affiliate_id, e.amount, e.is_paid, e.payout_id, p.status AS payout_status FROM earnings e LEFT JOIN payouts p ON e.payout_id = p.id WHERE e.is_paid = 1 AND (e.payout_id IS NULL OR p.id IS NULL OR p.status != 'completed') ORDER BY e.id ASC;"

echo "[1/2] Checking payouts table for fabricated or unverified completions..."
./node_modules/.bin/wrangler d1 execute "${DB_NAME}" --config "${CONFIG_FILE}" ${REMOTE_FLAG} --command "${ANOMALOUS_PAYOUTS_SQL}" --json

echo "[2/2] Checking earnings table for orphaned paid rows (is_paid=1 without completed payout)..."
./node_modules/.bin/wrangler d1 execute "${DB_NAME}" --config "${CONFIG_FILE}" ${REMOTE_FLAG} --command "${ORPHANED_EARNINGS_SQL}" --json

echo "============================================================"
echo " Reconciliation query execution complete."
echo " If any rows were returned above, record founder remediation"
echo " decision in plans/261020-zero-bug-go-live/go-live-signoff.md"
echo " before running production cutover."
echo "============================================================"
