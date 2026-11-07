#!/usr/bin/env bash
set -euo pipefail

# scripts/assert-staging-isolation.sh
# Bidirectional check: Fails closed if production and staging share any D1, KV, or R2 resource IDs.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROD_CONFIG="${REPO_ROOT}/wrangler.jsonc"
STAGING_CONFIG="${1:-${REPO_ROOT}/wrangler.staging.jsonc}"

PROD_DB_ID="3436aa7d-3065-4103-96e1-ddbd8b372246"
STAGING_DB_ID="be4ed659-c877-4820-ae6e-9747bc7ee316"
PROD_KV_ID="5628adf57f1548b5af615de4e9021893"
STAGING_KV_ID="f2cf595dec5543dc96f6370bebbc8754"
PROD_R2_BUCKET="apex-os-uploads"
STAGING_R2_BUCKET="apex-os-uploads-staging"

if [[ ! -f "${STAGING_CONFIG}" ]]; then
  echo "ERROR: Staging config not found at ${STAGING_CONFIG}" >&2
  exit 1
fi

if [[ ! -f "${PROD_CONFIG}" ]]; then
  echo "ERROR: Production config not found at ${PROD_CONFIG}" >&2
  exit 1
fi

# 1. Staging checks
if grep -q "${PROD_DB_ID}" "${STAGING_CONFIG}"; then
  echo "FATAL: Production D1 database_id (${PROD_DB_ID}) found in ${STAGING_CONFIG}!" >&2
  exit 1
fi

if ! grep -q "${STAGING_DB_ID}" "${STAGING_CONFIG}"; then
  echo "FATAL: Expected staging D1 database_id (${STAGING_DB_ID}) missing from ${STAGING_CONFIG}!" >&2
  exit 1
fi

if grep -q "${PROD_KV_ID}" "${STAGING_CONFIG}"; then
  echo "FATAL: Production KV namespace (${PROD_KV_ID}) found in ${STAGING_CONFIG}!" >&2
  exit 1
fi

if ! grep -q "${STAGING_KV_ID}" "${STAGING_CONFIG}"; then
  echo "FATAL: Expected staging KV namespace (${STAGING_KV_ID}) missing from ${STAGING_CONFIG}!" >&2
  exit 1
fi

if grep -q "\"${PROD_R2_BUCKET}\"" "${STAGING_CONFIG}"; then
  echo "FATAL: Production R2 bucket (${PROD_R2_BUCKET}) found in ${STAGING_CONFIG}!" >&2
  exit 1
fi

if ! grep -q "\"${STAGING_R2_BUCKET}\"" "${STAGING_CONFIG}"; then
  echo "FATAL: Expected staging R2 bucket (${STAGING_R2_BUCKET}) missing from ${STAGING_CONFIG}!" >&2
  exit 1
fi

if ! grep -q '"name": "apex-os-staging"' "${STAGING_CONFIG}"; then
  echo "FATAL: Expected worker name \"apex-os-staging\" missing from ${STAGING_CONFIG}!" >&2
  exit 1
fi

# 2. Production checks
if grep -q "${STAGING_DB_ID}" "${PROD_CONFIG}"; then
  echo "FATAL: Staging D1 database_id (${STAGING_DB_ID}) found in production config ${PROD_CONFIG}!" >&2
  exit 1
fi

if grep -q "${STAGING_KV_ID}" "${PROD_CONFIG}"; then
  echo "FATAL: Staging KV namespace (${STAGING_KV_ID}) found in production config ${PROD_CONFIG}!" >&2
  exit 1
fi

if grep -q "\"${STAGING_R2_BUCKET}\"" "${PROD_CONFIG}"; then
  echo "FATAL: Staging R2 bucket (${STAGING_R2_BUCKET}) found in production config ${PROD_CONFIG}!" >&2
  exit 1
fi

echo "STAGING_ISOLATED"
