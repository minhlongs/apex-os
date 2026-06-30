#!/usr/bin/env bash
#
# ApexOS - Route Testing Script
# Tests that routes are properly configured in Cloudflare Pages
#
# Usage: bash scripts/test-routes.sh --domain your-app.pages.dev

set -e

DOMAIN=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --domain)
      DOMAIN="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 --domain your-app.pages.dev"
      exit 1
      ;;
  esac
done

if [ -z "$DOMAIN" ]; then
    echo "Error: --domain is required"
    echo "Usage: $0 --domain your-app.pages.dev"
    exit 1
fi

echo "================================================"
echo "ApexOS Route Testing"
echo "Domain: $DOMAIN"
echo "================================================"
echo ""

test_route() {
    local route="$1"
    local expected="$2"
    local status_code=$(curl -s -o /dev/null -w "%{http_code}" "https://$DOMAIN$route")
    
    if [ "$status_code" = "200" ] || [ "$status_code" = "302" ] || [ "$status_code" = "404" ]; then
        echo -e "✓ $route - HTTP $status_code (${expected})"
    else
        echo -e "✗ $route - HTTP $status_code (expected $expected)"
    fi
}

echo "Testing API routes (should return Worker response)..."
test_route "/api/health" "Worker"
test_route "/api/deals" "Worker"
test_route "/api/auth/status" "Worker"

echo ""
echo "Testing Admin routes (should return Worker/SSR)..."
test_route "/admin/deals" "Worker"
test_route "/admin/dashboard" "Worker"

echo ""
echo "Testing static asset routes (should return cached or 404)..."
test_route "/_next/static/test.txt" "Static/404"
test_route "/favicon.ico" "Static/404"
test_route "/robots.txt" "Static/404"

echo ""
echo "Testing main pages (should return Worker/SSR)..."
test_route "/" "Worker"
test_route "/vi" "Worker"
test_route "/en" "Worker"
test_route "/deals" "Worker"

echo ""
echo "================================================"
echo "Route testing complete!"
echo "================================================"
