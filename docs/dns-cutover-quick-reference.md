# DNS Cutover Quick Reference

## Overview

DNS cutover migrates your application from the Cloudflare Pages subdomain (`apex-os.pages.dev`) to a custom domain (e.g., `apex-os.com`).

## Prerequisites

- `CLOUDFLARE_API_TOKEN` with DNS edit permissions
- `CLOUDFLARE_ACCOUNT_ID` (from `wrangler whoami`)
- Target domain added to Cloudflare account
- Production environment variables updated:
  - `NEXT_PUBLIC_APP_URL=https://apex-os.com`
  - `NEXT_PUBLIC_SITE_URL=https://apex-os.com`

---

## Step-by-Step Process

### 1. Pre-Cutover (Day -1)

```bash
# Verify environment variables in Cloudflare Pages
# Go to: Pages → apex-os → Settings → Environment variables

# Ensure these use the new domain:
# NEXT_PUBLIC_APP_URL=https://apex-os.com
# NEXT_PUBLIC_SITE_URL=https://apex-os.com

# Update webhook URLs in external services:
# - Binance: https://apex-os.com/api/webhooks/exchange/binance
# - Bybit: https://apex-os.com/api/webhooks/exchange/bybit
# - Polar: https://apex-os.com/api/webhooks/polar
# - Resend: sender email domain should match

# Schedule maintenance window (if needed):
# Announce to users 24h in advance
```

### 2. DNS Cutover (Day 0)

```bash
# Set required environment variables
export CLOUDFLARE_API_TOKEN="your-token"
export CLOUDFLARE_ACCOUNT_ID="your-account-id"

# Run the automated cutover script
./scripts/dns-cutover.sh --domain apex-os.com --action cutover --wait-minutes 30
```

The script will:
1. Get Cloudflare zone ID
2. Configure Pages custom domain
3. Create A records pointing to Pages IPs
4. Create CNAME for `www` and subdomains
5. Wait for DNS propagation
6. Verify SSL certificate
7. Test all critical routes

### 3. Post-Cutover Verification

```bash
# Run comprehensive verification
./scripts/dns-cutover.sh --domain apex-os.com --action verify

# Or use the route tester
./scripts/test-routes.sh --domain apex-os.com

# Manual spot checks:
curl -I https://apex-os.com/
curl https://apex-os.com/api/health

# Check SSL certificate
echo | openssl s_client -connect apex-os.com:443 -servername apex-os.com 2>/dev/null | openssl x509 -noout -subject -dates
```

### 4. Monitor (First 24 Hours)

- Watch error tracking (Sentry/Cloudflare Logpush)
- Monitor webhook delivery status
- Check user support for domain-related issues
- Verify all email links use new domain

---

## DNS Record Configuration

If doing manual DNS management:

| Type | Name | Value | TTL | Proxy |
|------|------|-------|-----|-------|
| A | @ | 198.41.128.10 | 300 | Proxied |
| A | @ | 198.41.129.10 | 300 | Proxied |
| CNAME | www | @ | 300 | Proxied |
| CNAME | app | apex-os.pages.dev | 300 | Proxied |
| CNAME | staging | apex-os-staging.pages.dev | 300 | Proxied |

**Note:** Cloudflare Pages IPs may change. Verify current IPs with `dig apex-os.pages.dev`.

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| DNS not propagating | High TTL on old records | Wait for cache to expire (check `dig +trace`) |
| SSL not issuing | Custom domain not added to Pages | Add domain in Pages settings, verify DNS |
| 404 on new domain | Pages domain binding missing | Add domain in Pages → Settings → Custom domains |
| Webhooks failing | URL not updated in exchange | Update webhook URL in Binance/Bybit dashboards |
| Mixed content | Hardcoded `pages.dev` URLs | Search codebase for old domain, update env vars |

---

## Rollback

If critical issues arise:

```bash
# Automated rollback
./scripts/dns-cutover.sh --domain apex-os.com --action rollback --old-domain apex-os.pages.dev

# Manual rollback:
# 1. Delete A/CNAME records for apex-os.com in Cloudflare DNS
# 2. Verify apex-os.pages.dev resolves: dig apex-os.pages.dev
# 3. Remove custom domain from Pages project (Dashboard)
# 4. Revert env vars to old domain
```

---

## Checklist

### Before Cutover
- [ ] Staging verified end-to-end
- [ ] Production deployed to Cloudflare Pages
- [ ] Environment variables updated for new domain
- [ ] Webhook URLs updated in external services
- [ ] SSL certificate auto-issuance enabled
- [ ] Maintenance window announced (if needed)

### During Cutover
- [ ] DNS records updated via script or manually
- [ ] DNS propagation monitored
- [ ] SSL certificate issued
- [ ] Health endpoint responding
- [ ] All critical routes returning 200

### After Cutover
- [ ] Route tests pass 100%
- [ ] Webhook signatures verified
- [ ] Email links functional
- [ ] OAuth callbacks working
- [ ] Error tracking active
- [ ] Uptime monitor updated to new domain

---

## Commands Reference

```bash
# Cutover
./scripts/dns-cutover.sh --domain apex-os.com --action cutover

# Verify
./scripts/dns-cutover.sh --domain apex-os.com --action verify

# Rollback
./scripts/dns-cutover.sh --domain apex-os.com --action rollback --old-domain apex-os.pages.dev

# Test routes
./scripts/test-routes.sh --domain apex-os.com

# Check health
curl https://apex-os.com/api/health | jq

# Tail logs
wrangler pages deployment tail --project-name apex-os

# List deployments
wrangler pages deployment list --project-name apex-os
```

---

## Expected Timeline

| Step | Duration |
|------|----------|
| Script execution | 2-5 minutes |
| DNS propagation | 0-30 minutes (usually <5m with 5m TTL) |
| SSL issuance | 1-10 minutes after DNS propagates |
| Verification | 5-10 minutes |
| **Total** | **10-45 minutes** |

---

## Contact

- **Cloudflare Support**: https://support.cloudflare.com/
- **Internal**: `#infra-alerts` Slack channel
- **Runbook**: `docs/deployment-runbook.md`
