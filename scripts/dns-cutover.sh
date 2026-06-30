#!/usr/bin/env bash
#
# ApexOS - DNS Cutover Script
# Manages DNS cutover from staging to production
#
# Usage: bash scripts/dns-cutover.sh --domain yourdomain.com --action cutover|verify|rollback

set -e

DOMAIN=""
ACTION=""
OLD_DOMAIN="apex-os.pages.dev"

while [[ $# -gt 0 ]]; do
  case $1 in
    --domain)
      DOMAIN="$2"
      shift 2
      ;;
    --action)
      ACTION="$2"
      shift 2
      ;;
    --old-domain)
      OLD_DOMAIN="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 --domain yourdomain.com --action cutover|verify|rollback [--old-domain old.pages.dev]"
      exit 1
      ;;
  esac
done

if [ -z "$DOMAIN" ] || [ -z "$ACTION" ]; then
    echo "Error: --domain and --action are required"
    echo "Usage: $0 --domain yourdomain.com --action cutover|verify|rollback [--old-domain old.pages.dev]"
    exit 1
fi

echo "================================================"
echo "ApexOS DNS Cutover - $ACTION"
echo "Domain: $DOMAIN"
echo "================================================"
echo ""

case "$ACTION" in
    cutover)
        echo "Initiating DNS cutover to $DOMAIN..."
        echo ""
        echo "Steps:"
        echo "1. Add CNAME record in your DNS provider:"
        echo "   Name: @ (or www for www subdomain)"
        echo "   Value: $DOMAIN.pages.dev"
        echo "   TTL: 300 (5 minutes)"
        echo ""
        echo "2. Update Cloudflare Pages custom domain:"
        echo "   - Go to Cloudflare Pages dashboard"
        echo "   - Select apex-os project"
        echo "   - Settings → Custom domains"
        echo "   - Add $DOMAIN"
        echo ""
        echo "3. Wait for SSL certificate (usually 5-30 minutes)"
        echo ""
        echo "4. Update environment variables:"
        echo "   NEXT_PUBLIC_SITE_URL=https://$DOMAIN"
        echo "   NEXT_PUBLIC_APP_URL=https://$DOMAIN"
        echo ""
        echo "5. Redeploy to apply new environment variables"
        echo ""
        read -p "Press Enter when DNS has propagated and SSL is ready..."
        ;;
    verify)
        echo "Verifying DNS cutover for $DOMAIN..."
        echo ""
        echo "Checking DNS resolution..."
        dig +short "$DOMAIN" || nslookup "$DOMAIN" || host "$DOMAIN"
        echo ""
        echo "Checking HTTPS response..."
        curl -I "https://$DOMAIN" 2>/dev/null | head -10
        echo ""
        echo "Checking Pages deployment status..."
        curl -s "https://$DOMAIN/api/health" | jq . 2>/dev/null || curl "https://$DOMAIN/api/health" 2>/dev/null
        ;;
    rollback)
        echo "WARNING: Rolling back to $OLD_DOMAIN"
        echo ""
        echo "1. Remove custom domain from Cloudflare Pages"
        echo "2. Revert DNS to point to $OLD_DOMAIN.pages.dev"
        echo "3. Update NEXT_PUBLIC_SITE_URL back to $OLD_DOMAIN.pages.dev"
        echo "4. Redeploy"
        read -p "Press Enter to confirm rollback..."
        ;;
    *)
        echo "Invalid action. Use: cutover, verify, or rollback"
        exit 1
        ;;
esac

echo ""
echo "================================================"
echo "DNS operation complete"
echo "================================================"
