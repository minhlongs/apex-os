#!/usr/bin/env bash
set -euo pipefail

# scripts/verify-deployment.sh
# Verifies /api/version SHA match (when EXPECTED_SHA is provided) and runs
# scripts/smoke-protected-routes.sh against the target deployment URL.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${1:-${DEPLOY_URL:-}}"
EXPECTED_SHA="${2:-${EXPECTED_SHA:-}}"

if [[ -z "${BASE_URL}" ]]; then
  echo "Usage: $0 <base-url> [expected-sha]" >&2
  exit 1
fi
BASE_URL="${BASE_URL%/}"

echo "Verifying /api/version on ${BASE_URL}..."
VERSION_JSON="$(curl -sf "${BASE_URL}/api/version")"
echo "Response: ${VERSION_JSON}"

ACTUAL_SHA="$(node -e '
  const data = JSON.parse(process.argv[1]);
  if (typeof data.sha !== "string" || !("builtAt" in data) || typeof data.environment !== "string") {
    process.exit(2);
  }
  process.stdout.write(data.sha);
' "${VERSION_JSON}")"

if [[ -n "${EXPECTED_SHA}" ]]; then
  if [[ "${ACTUAL_SHA}" != "${EXPECTED_SHA}" ]]; then
    echo "FATAL: /api/version sha mismatch! Expected '${EXPECTED_SHA}', got '${ACTUAL_SHA}'" >&2
    exit 1
  fi
  echo "PASS: /api/version sha matches '${EXPECTED_SHA}'"
else
  echo "PASS: /api/version returned valid schema (sha='${ACTUAL_SHA}')"
fi

bash "${SCRIPT_DIR}/smoke-protected-routes.sh" "${BASE_URL}"
echo "VERIFY_DEPLOYMENT_PASSED"
