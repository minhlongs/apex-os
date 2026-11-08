#!/usr/bin/env bash
set -euo pipefail

# scripts/assert-cloudflare-credentials.sh
# Fails closed before a deploy when the Cloudflare credentials are unavailable.
#
# Wrangler names the environment variables it needs, not the repository secrets
# they come from, so a workflow that maps a secret name wrangler has never heard
# of into CLOUDFLARE_API_TOKEN resolves to an empty string, and wrangler then
# reports the missing variable -- a message that reads as though the credential
# was never created, when in fact it exists under a different name. Asserting
# here turns that late, ambiguous failure into an early, named one, before
# `npm ci` and the Worker build spend minutes rediscovering it.
#
# The check is deliberately generic: it asserts the two env vars the deploy steps
# consume, so every job that reads a Cloudflare secret can reuse it.

missing=()

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  missing+=("CLOUDFLARE_API_TOKEN")
fi

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  missing+=("CLOUDFLARE_ACCOUNT_ID")
fi

if [[ ${#missing[@]} -gt 0 ]]; then
  {
    echo "FATAL: ${#missing[@]} Cloudflare credential(s) are not available in this job: ${missing[*]}" >&2
    echo "" >&2
    echo "A deploy needs both:" >&2
    echo "  CLOUDFLARE_API_TOKEN  - an API token with Workers deploy permission" >&2
    echo "  CLOUDFLARE_ACCOUNT_ID - the account id reported by 'wrangler whoami'" >&2
    echo "" >&2
    echo "In GitHub Actions these arrive as repository or environment secrets, and" >&2
    echo "the workflow reads them under these exact secret names:" >&2
    echo "  secrets.CLOUDFLARE_API_TOKEN" >&2
    echo "  secrets.CLOUDFLARE_ACCOUNT_ID" >&2
    echo "" >&2
    echo "The env var name and the secret name are separate things. Wrangler's error" >&2
    echo "message names the variable, so a secret misnamed in the workflow surfaces" >&2
    echo "as an empty variable rather than as a missing secret." >&2
    echo "" >&2
    echo "Register them with:" >&2
    echo "  gh secret set CLOUDFLARE_API_TOKEN --repo <owner>/<repo>" >&2
    echo "  gh secret set CLOUDFLARE_ACCOUNT_ID --repo <owner>/<repo>" >&2
  } >&2
  exit 1
fi

echo "CLOUDFLARE_CREDENTIALS_AVAILABLE"
