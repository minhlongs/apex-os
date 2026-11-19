#!/usr/bin/env bash
set -euo pipefail

# scripts/smoke-protected-routes.sh
# Probes public and protected endpoints on a deployed ApexOS Worker.
# Asserts zero 5xx responses and zero unauthenticated 200 responses on protected routes.

BASE_URL="${1:-}"
if [[ -z "${BASE_URL}" ]]; then
  echo "Usage: $0 <base-url>" >&2
  exit 1
fi
BASE_URL="${BASE_URL%/}"

FAILURES=0

check_route() {
  local method="$1"
  local path="$2"
  local mode="$3" # "public_200" | "public_non500" | "protected"
  local body="${4:-}"

  local url="${BASE_URL}${path}"
  local status

  if [[ -n "${body}" ]]; then
    status="$(curl -s -o /dev/null -w "%{http_code}" -X "${method}" -H "Content-Type: application/json" -d "${body}" "${url}" || echo "000")"
  else
    status="$(curl -s -o /dev/null -w "%{http_code}" -X "${method}" "${url}" || echo "000")"
  fi

  if [[ "${status}" == "000" ]] || [[ "${status}" =~ ^5 ]]; then
    echo "FAIL [${method} ${path}]: unexpected 5xx/network status ${status}" >&2
    FAILURES=$((FAILURES + 1))
    return
  fi

  if [[ "${mode}" == "public_200" ]]; then
    if [[ "${status}" != "200" ]]; then
      echo "FAIL [${method} ${path}]: expected 200, got ${status}" >&2
      FAILURES=$((FAILURES + 1))
      return
    fi
  elif [[ "${mode}" == "protected" ]]; then
    if [[ "${status}" == "200" ]]; then
      echo "FAIL [${method} ${path}]: protected route returned 200 without credentials!" >&2
      FAILURES=$((FAILURES + 1))
      return
    fi
  fi

  echo "PASS [${method} ${path}] -> ${status} (${mode})"
}

echo "Running protected-route smoke suite against ${BASE_URL}..."

# Public metadata & health routes
check_route "GET"  "/api/version"                 "public_200"
check_route "GET"  "/api/health"                  "public_non500"
check_route "GET"  "/api/auth/session"            "public_200"
check_route "GET"  "/api/terminal/snapshot"       "public_200"
check_route "GET"  "/en/legal/terms"              "public_200"
check_route "GET"  "/en/legal/non-custodial-disclosure" "public_200"
check_route "GET"  "/en/legal/geo-restriction"    "public_200"

# Protected webhook & operational routes (must reject unauthenticated requests, never 200 or 5xx)
check_route "POST" "/api/webhooks/ipn"            "protected" "{}"
check_route "POST" "/api/webhooks/telegram"       "protected" "{}"
check_route "POST" "/api/webhooks/kyc"            "protected" "{}"
check_route "POST" "/api/webhooks/exchange/kucoin" "protected" "{}"
check_route "POST" "/api/webhooks/exchange/okx"   "protected" "{}"
check_route "POST" "/api/terminal/actions"        "protected" "{}"
check_route "GET"  "/api/payouts"                 "protected"
check_route "GET"  "/api/affiliate/uids"          "protected"
check_route "GET"  "/api/affiliate/short-links"   "protected"
check_route "GET"  "/api/affiliate/ledger-summary" "protected"
check_route "GET"  "/api/admin/payouts/treasury"  "protected"
check_route "GET"  "/api/admin/runtime-flags"     "protected"
check_route "GET"  "/api/admin/reconciliation/poller" "protected"
check_route "POST" "/api/cron"                    "protected" "{}"

if [[ "${FAILURES}" -gt 0 ]]; then
  echo "SMOKE_FAILED: ${FAILURES} route check(s) failed." >&2
  exit 1
fi

echo "SMOKE_PASSED: all routes verified."
