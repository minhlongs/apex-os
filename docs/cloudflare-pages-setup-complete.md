# ApexOS Cloudflare Pages Production Configuration

## Summary

Cloudflare Pages production deployment for ApexOS has been fully configured with:

1. **Build Settings** - Automated via OpenNext adapter
2. **Environment Variables** - Production template with all required secrets
3. **Custom Domain** - Complete setup guide with DNS configuration
4. **Deployment Scripts** - Automated setup and deployment

---

## Files Created/Modified

### Configuration Files

| File | Status | Purpose |
|------|--------|---------|
| `open-next.config.ts` | Modified | OpenNext routing and build config |
| `wrangler.toml` | Modified | Cloudflare bindings + build settings |
| `.cloudflare/pages-config.toml` | Created | Pages build configuration reference |
| `.env.production.example` | Created | Production env vars template |

### Documentation

| File | Purpose |
|------|---------|
| `docs/cloudflare-pages-config.md` | Complete configuration reference |
| `docs/custom-domain-setup.md` | Custom domain setup guide |
| `docs/deployment-architecture.mdc` | Architecture diagrams (Mermaid) |

### Scripts

| Script | Purpose |
|--------|---------|
| `scripts/setup-cloudflare-pages.sh` | Interactive setup wizard |
| `scripts/deploy-to-pages.sh` | Production deployment script |

---

## Build Configuration

```
Build Command: pnpm build
Output Dir: .open-next/
Node Version: 20
Production Branch: main
```

**OpenNext Routes:**
```
/api/*              → cloudflare_workers
/admin/*            → cloudflare_workers
/_next/static/*     → cache_override
/static/*           → cache_override
/*                  → cloudflare_workers
```

---

## Required Production Environment Variables

### Core (Required)

| Variable | Type | Description |
|----------|------|-------------|
| `BETTER_AUTH_SECRET` | Secret | 32+ char random string |
| `NEXT_PUBLIC_APP_URL` | Public | Production URL (e.g., https://apex-os.com) |
| `NEXT_PUBLIC_SITE_URL` | Public | Site URL for SEO |
| `RESEND_API_KEY` | Secret | Resend API key (re_...) |
| `NEXT_PUBLIC_SENDER_EMAIL` | Public | Verified sender email |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | Public | Support email |

### Payouts (Required for production)

| Variable | Type | Description |
|----------|------|-------------|
| `STELLAR_SECRET_KEY` | Secret | Stellar wallet secret (G...) |
| `STELLAR_NETWORK` | Public | testnet or mainnet |
| `STELLAR_USDC_ISSUER` | Public | USDC issuer address |
| `STELLAR_USDC_CODE` | Public | Asset code (USDC) |

### Webhooks (Required for live data)

| Variable | Type | Description |
|----------|------|-------------|
| `BINANCE_WEBHOOK_SECRET` | Secret | Binance webhook secret |
| `BYBIT_WEBHOOK_SECRET` | Secret | Bybit webhook secret |

### Optional

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude AI features |
| `OPENAI_API_KEY` | OpenAI features |
| `NEXT_PUBLIC_POSTHOG_KEY/HOST` | Analytics |
| `NEXT_PUBLIC_SENTRY_DSN` | Error tracking |

See `.env.production.example` for complete list.

---

## Deployment Steps

### 1. Initial Setup (One-time)

```bash
# Run interactive setup wizard
bash scripts/setup-cloudflare-pages.sh
```

This will:
- Create/update Cloudflare Pages project
- Configure build settings
- Walk you through setting environment variables
- Optionally configure custom domain

### 2. Set Production Environment Variables

All secrets must be set in Cloudflare Pages Dashboard:

```
Pages → Project → Settings → Environment Variables → Production
```

Mark these as **Sensitive** (encrypted):
- `BETTER_AUTH_SECRET`
- `RESEND_API_KEY`
- `STELLAR_SECRET_KEY`
- `BINANCE_WEBHOOK_SECRET`
- `BYBIT_WEBHOOK_SECRET`
- `ANTHROPIC_API_KEY` (if used)

### 3. Deploy

```bash
# Production deployment
bash scripts/deploy-to-pages.sh main

# Or manually
pnpm build
wrangler pages deploy .open-next --project-name apex-os --branch main
```

### 4. Verify

```bash
# Check health endpoint
curl https://your-app.pages.dev/api/health

# Expected: {"status":"ok","timestamp":"...","environment":"production",...}
```

---

## Custom Domain Setup

### Quick Setup

```bash
# Add custom domain
wrangler pages project update apex-os --custom-domain apex-os.com
```

### DNS Configuration

Add CNAME record:
```
Type: CNAME
Name: @ (or www)
Target: apex-os.pages.dev
TTL: Auto
```

### Update Environment Variables

After custom domain is active, update:
```
NEXT_PUBLIC_APP_URL=https://apex-os.com
NEXT_PUBLIC_SITE_URL=https://apex-os.com
```

Then **redeploy**.

Full guide: `docs/custom-domain-setup.md`

---

## Cloudflare Resources Already Configured

| Resource | Binding | ID |
|----------|---------|-----|
| D1 Database (production) | `DB` | `3436aa7d-3065-4103-96e1-ddbd8b372246` |
| D1 Database (staging) | `apex_os_staging_db` | `be4ed659-c877-4820-ae6e-9747bc7ee316` |
| KV Namespace | `KV` | `5628adf57f1548b5af615de4e9021893` |
| R2 Bucket | `STORAGE` | `apex-os-uploads` |

---

## Quick Commands Reference

```bash
# Build
pnpm build

# Deploy
wrangler pages deploy .open-next

# View deployments
wrangler pages deployment list --project-name apex-os

# Tail logs
wrangler pages deployment tail --project-name apex-os

# Health check
curl https://apex-os.pages.dev/api/health

# Database access
wrangler d1 execute apex-os-db --command "SELECT name FROM sqlite_master WHERE type='table'"

# KV operations
wrangler kv:key put --binding=KV key value
wrangler kv:key get --binding=KV key
```

---

## Verification Checklist

- [ ] `wrangler.toml` build configuration added
- [ ] `open-next.config.ts` routes configured
- [ ] `.env.production.example` created
- [ ] `scripts/setup-cloudflare-pages.sh` created (executable)
- [ ] `scripts/deploy-to-pages.sh` created (executable)
- [ ] `docs/cloudflare-pages-config.md` created
- [ ] `docs/custom-domain-setup.md` created
- [ ] README deployment section updated

---

## Next Steps

1. **Run setup wizard**: `bash scripts/setup-cloudflare-pages.sh`
2. **Set production secrets** in Cloudflare Dashboard
3. **Deploy**: `bash scripts/deploy-to-pages.sh main`
4. **Configure custom domain** (if applicable)
5. **Verify** all endpoints working
6. **Set up monitoring** (see `docs/deployment-runbook.md`)

---

## Support & Resources

- **Deployment Runbook**: `docs/deployment-runbook.md`
- **Cloudflare Pages Docs**: https://developers.cloudflare.com/pages/
- **OpenNext Docs**: https://opennext.js.org/
- **Wrangler CLI**: https://developers.cloudflare.com/workers/wrangler/

---

**Configuration completed on:** 2026-06-22
**Configured by:** Claude Opus 4.8 (Anthropic)
**Project:** ApexOS - Global Crypto Cashback & Affiliate Hub
