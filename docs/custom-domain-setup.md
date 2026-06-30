# Custom Domain Configuration for ApexOS
# Cloudflare Pages + OpenNext

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Add Custom Domain](#add-custom-domain)
3. [DNS Configuration](#dns-configuration)
4. [SSL/TLS Verification](#ssltls-verification)
5. [Domain Variations](#domain-variations)
6. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- Cloudflare Pages project is deployed and accessible
- You own the domain (registered with any registrar)
- Domain's nameservers point to Cloudflare (for easiest management)

---

## Add Custom Domain

### Method 1: Cloudflare Dashboard (Recommended)

1. Go to **Cloudflare Dashboard** → **Pages** → Your Project
2. Navigate to **Settings** → **Custom domains**
3. Click **Add custom domain**
4. Enter your domain (e.g., `apex-os.com` or `app.apex-os.com`)
5. Click **Continue**
6. Cloudflare will show DNS records to add

### Method 2: Wrangler CLI

```bash
# Add custom domain
wrangler pages project update apex-os --custom-domain apex-os.com

# For subdomain
wrangler pages project update apex-os --custom-domain app.apex-os.com
```

---

## DNS Configuration

### Option A: Using Cloudflare DNS (Nameservers on Cloudflare)

If your domain uses Cloudflare's nameservers:

1. In Cloudflare Dashboard → **DNS** → **Records**
2. Add a **CNAME** record:

| Type | Name | Target | Proxy status |
|------|------|--------|--------------|
| CNAME | @ (or www) | apex-os.pages.dev | Proxied (orange cloud) |

3. If adding root/apex domain (@), use **CNAME flattening** (automatic with Cloudflare)

### Option B: External Registrar (Not Cloudflare DNS)

Add these DNS records at your registrar:

#### For subdomain (e.g., app.apex-os.com):
```
Type: CNAME
Name: app
Target: apex-os.pages.dev
TTL: 3600 (1 hour)
```

#### For root/apex domain (apex-os.com):
Some registrars support **ALIAS** or **ANAME** records:
```
Type: ALIAS/ANAME
Name: @
Target: apex-os.pages.dev
```

If ALIAS/ANAME not supported, use **CNAME at www** and redirect:
1. CNAME: www → apex-os.pages.dev
2. URL redirect: apex-os.com → www.apex-os.com

---

## SSL/TLS Verification

### Automatic (Cloudflare Universal SSL)
- Cloudflare automatically provisions SSL certificates
- Takes 5-30 minutes after DNS propagation
- Certificate status visible in Dashboard → **Pages** → **Custom domains**

### Certificate Status

| Status | Meaning | Action |
|--------|---------|--------|
| Active | SSL certificate issued and valid | None |
| Pending | Certificate being provisioned | Wait 5-30 minutes |
| Needs configuration | DNS not pointing correctly | Verify DNS records |
| Error | Configuration problem | Check DNS, contact support |

---

## Domain Variations

### Multiple Domains

You can add multiple custom domains:

```bash
# Add both apex and www
wrangler pages project update apex-os --custom-domain apex-os.com
wrangler pages project update apex-os --custom-domain www.apex-os.com
```

In Cloudflare Dashboard, add each domain separately in **Custom domains** settings.

### Redirect www to apex (or vice versa)

Create a redirect in Cloudflare Dashboard:

1. Go to **Pages** → Project → **Redirects**
2. Add redirect rule:

| Source URL | Target URL | Status code |
|------------|------------|-------------|
| https://www.apex-os.com/* | https://apex-os.com/:splat | 301 |

---

## Environment Variables with Custom Domain

Update `NEXT_PUBLIC_APP_URL` in Cloudflare Pages environment variables:

1. Go to **Pages** → Project → **Settings** → **Environment variables**
2. Update `NEXT_PUBLIC_APP_URL`:
   ```
   https://apex-os.com
   ```
3. Also update `NEXT_PUBLIC_SITE_URL` if set separately
4. **Redeploy** the project for changes to take effect

### OAuth Callback URLs

Update OAuth providers with new callback URLs:

```
Auth:  https://apex-os.com/api/auth/callback/[provider]
```

---

## Verify Setup

### 1. Check DNS Propagation

```bash
# Check CNAME
dig CNAME apex-os.com +short
# Expected: apex-os.pages.dev

# Or using nslookup
nslookup apex-os.com
```

### 2. Test HTTPS

```bash
# Check SSL certificate
curl -I https://apex-os.com 2>/dev/null | head -1
# Expected: HTTP/2 200

# Check certificate details
echo | openssl s_client -connect apex-os.com:443 2>/dev/null | openssl x509 -noout -subject -dates
```

### 3. Test Application

```bash
# Health check
curl https://apex-os.com/api/health

# Expected response:
# {"status":"ok","timestamp":"...","environment":"production",...}
```

### 4. Browser Test

1. Open `https://apex-os.com`
2. Check that:
   - Site loads without certificate warnings
   - All assets load correctly (CSS, JS, images)
   - Navigation works on all pages
   - API calls succeed

---

## Troubleshooting

### "Domain not configured" error

**Cause:** DNS records not propagated or incorrect.

**Fix:**
1. Verify DNS records: `dig CNAME yourdomain.com`
2. Wait for propagation (up to 24 hours, typically minutes)
3. Ensure no conflicting records (only one CNAME per subdomain)

### SSL certificate "Pending" for long time

**Cause:** DNS not fully propagated or domain not reachable.

**Fix:**
1. Check DNS is correctly pointing to `.pages.dev`
2. Ensure no DNS loops or misconfigurations
3. Contact Cloudflare support if > 1 hour

### Mixed content warnings

**Cause:** Hardcoded `http://` URLs in application.

**Fix:**
1. Ensure `NEXT_PUBLIC_APP_URL` uses `https://`
2. Use relative URLs or `NEXT_PUBLIC_APP_URL` for API calls
3. Check for hardcoded external resources

### 404 on all routes except root

**Cause:** Incorrect `_routes` configuration.

**Fix:**
1. Ensure `.open-next/_routes` exists with proper routing
2. Rebuild and redeploy
3. Standard routes should include:
   ```
   /api/*    cloudflare_workers
   /_next/static/*  cache_override
   /*        cloudflare_workers
   ```

### Redirect loop

**Cause:** Double redirects (domain + Pages redirect).

**Fix:**
1. Check both Pages custom domain and any redirect rules
2. Remove duplicate redirects
3. Test with `curl -I` to see redirect chain

---

## Performance Optimization

### Enable Cache Everything

In Cloudflare Dashboard → **Pages** → **Rules**:

1. Add **Cache Level: Bypass** for API routes:
   ```
   URL: /api/*
   Cache: Bypass
   ```

2. Add **Cache Level: Standard** for static assets:
   ```
   URL: /_next/static/*
   Cache: Standard (respect origin)
   ```

### Browser Cache TTL

Set in same **Rules** section:

```
URL: /_next/static/*
Browser Cache TTL: 31536000 (1 year)
```

---

## Monitoring

### Set up Uptime Monitoring

1. Cloudflare → **Analytics & Logs** → **Monitors**
2. Create new monitor:
   - URL: `https://apex-os.com/api/health`
   - Check interval: 1 minute
   - Expected status: 200
   - Alert via email/webhook

### Enable Logpush (Optional)

Export logs to R2 for analysis:

```bash
wrangler pages project update apex-os \
  --logpush true \
  --logpush-destination apex-os-logs
```

---

## Rollback

If the custom domain causes issues:

1. Remove custom domain:
   ```bash
   wrangler pages project update apex-os --remove-custom-domain apex-os.com
   ```

2. Users can still access via `*.pages.dev` URL
3. Fix configuration
4. Re-add custom domain

---

## Support Resources

- [Cloudflare Pages Custom Domains](https://developers.cloudflare.com/pages/platform/custom-domains/)
- [CNAME Flattening](https://developers.cloudflare.com/dns/cname-flattening/)
- [OpenNext Routing](https://opennext.js.org/cloudflare/pages/routing)
