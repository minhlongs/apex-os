# ApexOS - Cloudflare Pages Production Configuration Summary

## Build Configuration

| Setting | Value |
|---------|-------|
| **Platform** | Cloudflare Pages |
| **Framework** | Next.js 16 (App Router) + OpenNext |
| **Build Command** | `pnpm build` |
| **Output Directory** | `.open-next` |
| **Node Version** | 20 |
| **Production Branch** | `main` |

## Cloudflare Resources

| Resource | Binding | Name | Purpose |
|----------|---------|------|---------|
| D1 Database | `DB` | `apex-os-db` | Primary database (SQLite) |
| D1 Database | `apex_os_staging_db` | `apex-os-staging-db` | Staging database |
| KV Namespace | `KV` | `apex-os-cache` | Caching, rate limiting |
| R2 Bucket | `STORAGE` | `apex-os-uploads` | File storage |

## Required Environment Variables (Production)

### Authentication
```bash
BETTER_AUTH_SECRET=<32+ char random string>
```

### Application
```bash
NEXT_PUBLIC_APP_URL=https://your-app.pages.dev
NEXT_PUBLIC_SITE_URL=https://your-domain.com
```

### Email (Resend)
```bash
RESEND_API_KEY=re_your_key
NEXT_PUBLIC_SENDER_EMAIL=noreply@yourdomain.com
NEXT_PUBLIC_SUPPORT_EMAIL=support@yourdomain.com
```

### Stellar Payouts
```bash
STELLAR_SECRET_KEY=Gyour_secret_key
STELLAR_NETWORK=testnet|mainnet
STELLAR_USDC_ISSUER=<issuer_address>
STELLAR_USDC_CODE=USDC
```

### Exchange Webhooks
```bash
BINANCE_WEBHOOK_SECRET=<your_secret>
BYBIT_WEBHOOK_SECRET=<your_secret>
```

## Optional Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude AI features |
| `OPENAI_API_KEY` | OpenAI features |
| `NEXT_PUBLIC_POSTHOG_KEY` | Analytics |
| `NEXT_PUBLIC_SENTRY_DSN` | Error tracking |
| `NEXT_PUBLIC_GA_ID` | Google Analytics |
| `NEXT_PUBLIC_ENABLED_FEATURES` | Feature flags |
| `NEXT_PUBLIC_MAINTENANCE_MODE` | Maintenance mode |

## Setup Steps

### 1. Create/Update Cloudflare Pages Project

```bash
# Run setup script
bash scripts/setup-cloudflare-pages.sh

# Or manual setup via Wrangler
wrangler pages project create apex-os --production-branch main
wrangler pages project update apex-os \
  --build-command "pnpm build" \
  --build-output-directory ".open-next" \
  --node-version 20
```

### 2. Set Production Environment Variables

Via Cloudflare Dashboard:
```
Pages → Project → Settings → Environment Variables → Production
```

Or via Wrangler CLI:
```bash
# For secrets (marked as Sensitive)
wrangler pages project secret put apex-os BETTER_AUTH_SECRET --value "your-secret"

# For public variables
wrangler pages project environment-variable create apex-os NEXT_PUBLIC_APP_URL \
  --value "https://your-app.pages.dev" \
  --environment production
```

### 3. Deploy

```bash
# Build and deploy
bash scripts/deploy-to-pages.sh main

# Or using wrangler directly
pnpm build
wrangler pages deploy .open-next --project-name apex-os --branch main
```

### 4. Configure Custom Domain (Optional)

```bash
# Add domain
wrangler pages project update apex-os --custom-domain apex-os.com

# DNS: Add CNAME record
#   Type: CNAME
#   Name: @ (or www)
#   Target: apex-os.pages.dev
```

## File Reference

| File | Purpose |
|------|---------|
| `open-next.config.ts` | OpenNext configuration with routes |
| `wrangler.toml` | Cloudflare Workers resources bindings |
| `.cloudflare/pages-config.toml` | Pages build configuration |
| `scripts/setup-cloudflare-pages.sh` | Interactive setup wizard |
| `scripts/deploy-to-pages.sh` | Production deployment script |
| `.env.production.example` | Production env vars template |
| `docs/custom-domain-setup.md` | Custom domain guide |

## Verification Commands

```bash
# Check build output
ls -la .open-next/

# List Pages deployments
wrangler pages deployment list --project-name apex-os

# Tail logs
wrangler pages deployment tail --project-name apex-os

# Test health endpoint
curl https://your-app.pages.dev/api/health

# Check D1 database
wrangler d1 execute apex-os-db --command "SELECT name FROM sqlite_master WHERE type='table'"
```

## Configuration Checklist

- [ ] `wrangler.toml` has correct database IDs
- [ ] `open-next.config.ts` has proper routes configuration
- [ ] All required environment variables set in Cloudflare Pages
- [ ] `BETTER_AUTH_SECRET` is 32+ characters, random, secure
- [ ] `NEXT_PUBLIC_APP_URL` matches deployment URL
- [ ] `pnpm build` completes successfully
- [ ] `.open-next/` directory exists after build
- [ ] Health endpoint returns 200
- [ ] Custom domain DNS configured (if applicable)
- [ ] SSL certificate active (if using custom domain)
- [ ] OAuth callback URLs updated (if using OAuth)

## Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| Build fails with `@opennextjs/cloudflare` error | Run `pnpm add -D @opennextjs/cloudflare` |
| `images` config error | Ensure `images.unoptimized: true` in next.config.js |
| D1 database not found | Verify database_id in wrangler.toml |
| Env vars not available | Set in Cloudflare Pages Dashboard, redeploy |
| 404 on API routes | Check `_routes` config in open-next.config.ts |
| Auth errors | Verify `BETTER_AUTH_SECRET` set correctly |
| Webhook 404 | Ensure `/api/webhooks/*` not excluded in routes |

## Support

- Cloudflare Pages Docs: https://developers.cloudflare.com/pages/
- OpenNext Docs: https://opennext.js.org/
- Wrangler CLI Ref: https://developers.cloudflare.com/workers/wrangler/
