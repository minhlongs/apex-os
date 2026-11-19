# Gate G2 — Domain, Brand & Deployment Provenance Reconciliation

- **Date:** 2026-11-18
- **Worktree:** `/Users/macbook/apex-os-worktrees/phase2-ascendancy`
- **Branch:** `feat/ascendancy-phase2-verified`
- **Cloudflare Account ID:** `f691e83094f776311a1bfe3f8b126f1c`
- **Status:** RECONCILED (Canonical Origin Policy Locked; Unowned Third-Party Domains Quarantined)

---

## 1. Live DNS, HTTP & Cloudflare Ownership Audit (`2026-11-18`)

Every domain and Worker hostname referenced across the repository, CI workflows, mobile configuration, and prior documentation was tested directly via DNS (`dig`), HTTP (`curl`), and authenticated `wrangler` inspection on Cloudflare account `f691e83094f776311a1bfe3f8b126f1c`:

| Hostname / Target | DNS / Infrastructure Reality | Live HTTP Behavior | Owned by This Project? | Disposition |
| --- | --- | --- | --- | --- |
| `https://apex-os.agencyos-openclaw.workers.dev` | Cloudflare Worker `apex-os` (`wrangler.jsonc:6`), active version `badda24e-d652-465d-8db9-e0c3da2f143d` | `GET /` -> `307 /en` (Next.js 16 OpenNext); `GET /api/health` -> `200 JSON` (`database: connected`, `kv: connected`); `GET /api/version` -> `environment: "production"` | **YES (Verified)** | **Canonical Production Origin** (until an owned custom Cloudflare Zone is provisioned) |
| `https://apex-os-staging.agencyos-openclaw.workers.dev` | Cloudflare Worker `apex-os-staging` (`wrangler.staging.jsonc:7`), active version `59ff90e1-6a04-4b32-b629-fc8fff0b055f` | `GET /` -> `307 /en`; `GET /api/health` -> `200 JSON` (`database: connected`, `kv: connected`); `GET /api/version` -> `environment: "staging"` | **YES (Verified)** | **Canonical Staging Origin** |
| `apexos.app` / `www.apexos.app` | GoDaddy NS (`ns11.domaincontrol.com`), Render ingress (`216.24.57.1` / `apex-remote-nuj0.onrender.com`) | `GET /` -> `302 https://apexos.app/portal/os` (`x-render-origin-server: apex-remote/1.0.0 Python/3.12.16`, *"Sign in · APEX by APEX Cloud"*); `/api/health` -> `404` | **NO — Unrelated Third Party** | **QUARANTINED / PURGED** from runtime fallbacks, docs, and admin placeholder emails |
| `apex-os.pages.dev` | Global `pages.dev` project owned by another Cloudflare account (this account's legacy Pages project is `apex-os-317.pages.dev`, returning `404`) | Serves a 451 KB static SPA (*"POWERED BY APEX AI SYSTEMS — First-time setup. Paste your Supabase credentials..."*); `/api/health` returns `200 text/html` SPA fallback | **NO — Unrelated Third Party** | **QUARANTINED / PURGED** from monitoring links, mobile `expo.config.ts`, and ops scripts |
| `apex-os.com` / `www.apex-os.com` | Dynadot parking (`ns1.dyna-ns.net`, `185.53.179.128`) | `HTTPS` connection times out (`curl exit 28`); `HTTP` empty reply (`curl exit 52`) | **NO — Unowned / Parked** | **QUARANTINED / PURGED** from `.github/workflows/deploy.yml`, SEO metadata, auth client, and mobile API client |
| `apexos.io` / `my.apexos.io` | SiteGround (`ns1.siteground.net`, `34.174.56.185`, nginx) | `301 -> https://my.apexos.io/` | **NO — Unrelated Third Party** | **QUARANTINED / PURGED** from Telegram Mini App links and notification defaults |
| `apex-os-staging.long-tran624.workers.dev` & `apex-os-production.long-tran624.workers.dev` | `NXDOMAIN` (`SOA clyde.ns.cloudflare.com`); Worker `apex-os-production` returns Cloudflare API error `10007` | Does not resolve | **NO — Stale Subdomain / Script Name** | Documented as invalid; never referenced in config or scripts |

---

## 2. Canonical Origin & WebAuthn `RP_ID` Policy

1. **Single Canonical Origin Helper (`src/config/canonical-origin.ts`):**
   - Public origin resolution is centralized in `src/config/canonical-origin.ts`:
     - Explicit `NEXT_PUBLIC_APP_URL` (when set to a verified host) takes precedence so future cutover to an owned Cloudflare Custom Domain requires only updating `wrangler.jsonc` vars + DNS.
     - Quarantined third-party / unowned hosts (`apexos.app`, `www.apexos.app`, `apex-os.pages.dev`, `apex-os.com`, `www.apex-os.com`, `apexos.io`, `my.apexos.io`) are explicitly rejected by `isQuarantinedThirdPartyHost()` and fall back safely to the verified Worker origin.
     - Environment defaults:
       - `APP_ENV === 'production'` -> `https://apex-os.agencyos-openclaw.workers.dev`
       - `APP_ENV === 'staging'` -> `https://apex-os-staging.agencyos-openclaw.workers.dev`
       - Local development / test -> `http://localhost:3000`

2. **WebAuthn Relying Party (`WEBAUTHN_RP_ID` & `WEBAUTHN_ORIGIN`) Alignment:**
   - Because `workers.dev` is listed on the Public Suffix List (PSL), browsers forbid registering passkeys against bare `workers.dev` or mismatched `localhost`.
   - `wrangler.jsonc` binds:
     - `NEXT_PUBLIC_APP_URL = "https://apex-os.agencyos-openclaw.workers.dev"`
     - `WEBAUTHN_RP_ID = "apex-os.agencyos-openclaw.workers.dev"`
     - `WEBAUTHN_ORIGIN = "https://apex-os.agencyos-openclaw.workers.dev"`
   - `wrangler.staging.jsonc` binds:
     - `NEXT_PUBLIC_APP_URL = "https://apex-os-staging.agencyos-openclaw.workers.dev"`
     - `WEBAUTHN_RP_ID = "apex-os-staging.agencyos-openclaw.workers.dev"`
     - `WEBAUTHN_ORIGIN = "https://apex-os-staging.agencyos-openclaw.workers.dev"`
   - Cutover note: Per W3C WebAuthn Level 2, credentials bound to `apex-os.agencyos-openclaw.workers.dev` do not transfer across eTLD+1 boundaries; when an owned custom Cloudflare Zone is attached later, operators enroll fresh passkeys on the custom domain `RP_ID`.

3. **Short-Link Redirector (`/r/[code]`):**
   - Verified origin-agnostic (`src/app/r/[code]/route.ts` sets host-only `apex_ref` cookie and `302` redirects strictly to allowlisted partner exchange domains). UI short-link copy URLs derive dynamically from `resolveCanonicalAppOrigin()` / `window.location.origin` rather than any hardcoded domain.

4. **CI & Health Probe Hardening:**
   - `.github/workflows/deploy.yml` production verification is updated from unreachable `https://apex-os.com` to `${{ vars.PRODUCTION_URL || 'https://apex-os.agencyos-openclaw.workers.dev' }}`.
   - Health probes validate HTTP `200` **and** JSON `status === "ok"` so a static HTML SPA fallback can never produce a false-positive pass.

---

## 3. Remediated Runtime, Mobile & Documentation Surfaces

- `src/config/canonical-origin.ts` — Canonical origin resolver + quarantined host guard.
- `wrangler.jsonc` & `wrangler.staging.jsonc` — Explicit `NEXT_PUBLIC_APP_URL`, `WEBAUTHN_RP_ID`, and `WEBAUTHN_ORIGIN` vars per Worker environment.
- `.github/workflows/deploy.yml` — Production deployment verification pointed to verified Worker origin with override support via `vars.PRODUCTION_URL`.
- `src/app/[locale]/layout.tsx`, `src/app/robots.ts`, `public/robots.txt`, `src/app/sitemap.ts`, `src/lib/seo/json-ld.ts`, `src/contexts/auth-context.tsx` — Routed through `CANONICAL_PRODUCTION_ORIGIN` / `resolveCanonicalAppOrigin()`.
- `src/app/api/admin/passkey/route.ts`, `src/lib/monitoring/alert-engine.ts`, `src/lib/monitoring/d1-monitor.ts`, `src/lib/notifications/notification-channels.ts`, `src/lib/telegram/bot-service.ts` — Quarantined `apexos.app`, `apex-os.pages.dev`, `apex-os.com`, and `apexos.io` fallbacks replaced with canonical origin resolution.
- `apex-os-mobile/expo.config.ts`, `apex-os-mobile/src/api/client.ts`, `apex-os-mobile/src/utils/deep-links.ts` — Purged third-party `apex-os.pages.dev` and unowned `apex-os.com` fallbacks in favor of `https://apex-os.agencyos-openclaw.workers.dev`.
- `README.md`, `CLAUDE.md`, `.env.production.example`, `.env.staging.example` — Reconciled to OpenNext Cloudflare Workers deployment reality and verified Worker origins.

---

## 4. Unresolved External Operator Decision (Non-Blocking for Phase 2 Code)

- Before public App Store submission (`apex-os-mobile/metadata/store-metadata.json`) or external Resend DKIM email dispatch, the operator should bind an owned Cloudflare Zone on account `f691e83094f776311a1bfe3f8b126f1c` via Worker Custom Domains and update `NEXT_PUBLIC_APP_URL`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, and `RESEND_FROM_EMAIL` in one atomic cutover.
