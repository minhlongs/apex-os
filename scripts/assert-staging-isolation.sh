#!/usr/bin/env bash
set -euo pipefail

# scripts/assert-staging-isolation.sh
# Fails closed if wrangler.staging.jsonc references the production D1 database ID
# or is missing the expected staging D1 database ID.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
STAGING_CONFIG="${1:-${REPO_ROOT}/wrangler.staging.jsonc}"

PROD_DB_ID="3436aa7d-3065-4103-96e1-ddbd8b372246"
STAGING_DB_ID="be4ed659-c877-4820-ae6e-9747bc7ee316"

if [[ ! -f "${STAGING_CONFIG}" ]]; then
  echo "ERROR: Staging config not found at ${STAGING_CONFIG}" >&2
  exit 1
fi

if grep -q "${PROD_DB_ID}" "${STAGING_CONFIG}"; then
  echo "FATAL: Production D1 database_id (${PROD_DB_ID}) found in ${STAGING_CONFIG}!" >&2
  exit 1
fi

if ! grep -q "${STAGING_DB_ID}" "${STAGING_CONFIG}"; then
  echo "FATAL: Expected staging D1 database_id (${STAGING_DB_ID}) missing from ${STAGING_CONFIG}!" >&2
  exit 1
fi

if ! grep -q '"name": "apex-os-staging"' "${STAGING_CONFIG}"; then
  echo "FATAL: Expected worker name \"apex-os-staging\" missing from ${STAGING_CONFIG}!" >&2
  exit 1
fi

echo "STAGING_ISOLATED"
