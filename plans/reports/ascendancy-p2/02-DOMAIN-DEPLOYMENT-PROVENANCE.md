# Gate G2 — Domain, Brand & Deployment Provenance Reconciliation

## Executive Outcome

Read-only DNS, HTTP, TLS, and Cloudflare Worker/Pages inventory checks proved **four-way domain drift** across repository documentation, configuration, and prompt assumptions:
1. **`https://apexos.app` is an unowned third-party application** hosted on Render (`APEX by APEX Cloud`, Python `3.12.16`, GoDaddy DNS).
2. **`https://apex-os.pages.dev` is an unowned third-party static SPA** (`APEX AI SYSTEMS` Supabase CRM) on Cloudflare's global `pages.dev` namespace that returns a false-positive `HTTP 200 text/html` on `/api/health`. This account's legacy Pages project is `apex-os-317.pages.dev` (currently `HTTP 404`).
3. **`apex-os-staging.long-tran624.workers.dev` and `apex-os-production.long-tran624.workers.dev` do not exist (`NXDOMAIN`)**, and no Worker named `apex-os-production` exists on this Cloudflare account (`code: 10007`).
4. **`apex-os.com` (Dynadot parking, connection timeout) and `apexos.io` (SiteGround `301` to third-party `my.apexos.io`) are also unowned/unrouted.**

The **only authentic, live Cloudflare OpenNext Worker deployments** serving commit `f4285c5d351a8a8d3b2db60b0572ba25d8c8f23d` on account `f691e83094f776311a1bfe3f8b126f1c` are:
- **Staging Worker (`apex-os-staging`):** `https://apex-os-staging.agencyos-openclaw.workers.dev`
- **Production Worker (`apex-os`):** `https://apex-os.agencyos-openclaw.workers.dev`

All Phase 2 application origin helpers, WebAuthn `RP_ID`/`ORIGIN` resolution, short-link base URL builders, legal contact disclosures, and top-level docs (`README.md`, `CLAUDE.md`) must eliminate unverified third-party domain claims (`apexos.app`, `apex-os.pages.dev`, `apexos.io`, `apex-os.com`) and resolve origin strictly from explicit environment configuration (`NEXT_PUBLIC_APP_URL` / `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN`) or verified request/Worker hostnames until an operator-owned custom Cloudflare Zone is provisioned and DNS-cut over.

---

## 1. Live Provenance Verification Matrix (Read-Only Checks on 2026-11-18)

| Hostname / Endpoint | DNS & Hosting Evidence | HTTP / `/api/health` / `/api/version` Evidence | Ownership & Provenance Verdict |
|---|---|---|---|
| `https://apexos.app` | GoDaddy NS (`ns11.domaincontrol.com`, `ns12.domaincontrol.com`), `A = 216.24.57.1` (Render); `www` CNAME `apex-remote-nuj0.onrender.com` | `HEAD /` → `501` (`x-render-origin-server: apex-remote/1.0.0 Python/3.12.16`); `GET /` → `302 /portal/os` (`<title>Sign in · APEX</title>`, "APEX by APEX Cloud"); `/api/health` → `404` | **UNOWNED THIRD PARTY** — Do not link, email, or bind WebAuthn to this domain |
| `https://apex-os.pages.dev` | Claimed by another account on global `pages.dev` | Serves a `451,781`-byte static HTML SPA ("POWERED BY APEX AI SYSTEMS — Paste your Supabase credentials"); `/api/health` & `/api/version` return `200 text/html` SPA fallback | **UNOWNED THIRD PARTY (FALSE-POSITIVE HEALTH TRAP)** — Must never be used as API fallback or health target |
| `https://apex-os-317.pages.dev` | Owned by account `f691e83094f776311a1bfe3f8b126f1c` (`wrangler pages project list`: project `apex-os`, last deployed 3 months ago from `ea829b1`) | `/`, `/en`, `/api/health` → `HTTP/2 404` (`0` bytes) | **LEGACY DEPRECATED PAGES PROJECT** — Superseded by OpenNext Workers |
| `https://apex-os-staging.long-tran624.workers.dev` | `NXDOMAIN` (`SOA clyde.ns.cloudflare.com`) | `curl: (6) Could not resolve host` | **NON-EXISTENT SUBDOMAIN** — Wrong `workers.dev` account slug |
| `https://apex-os-production.long-tran624.workers.dev` | `NXDOMAIN` (`SOA clyde.ns.cloudflare.com`) | `curl: (6) Could not resolve host` | **NON-EXISTENT SUBDOMAIN & WORKER NAME** |
| `https://apex-os-production.agencyos-openclaw.workers.dev` | Resolves under `agencyos-openclaw.workers.dev`, but `wrangler deployments list --name apex-os-production` returns `[code: 10007] This Worker does not exist` | `HTTP/2 404` (`error code: 1042`) | **NON-EXISTENT WORKER SCRIPT** — Production script in `wrangler.jsonc` is named `apex-os` |
| `https://apex-os-staging.agencyos-openclaw.workers.dev` | Active Worker `apex-os-staging` (`version 59ff90e1-6a04-4b32-b629-fc8fff0b055f`, deployed `2026-11-15T00:33:12Z`) | `/` → `307 /en` (`ApexOS — Institutional Quant Fee Recovery & Attribution Hub`); `/api/health` → `200` `{"status":"ok","checks":{"database":"connected","kv":"connected"}}`; `/api/version` → `sha: f4285c5d...`, `environment: "staging"` | **CANONICAL LIVE STAGING WORKER** |
| `https://apex-os.agencyos-openclaw.workers.dev` | Active Worker `apex-os` (`version badda24e-d652-464d-8db9-e0c3da2f143d`, deployed `2026-11-15T00:33:09Z`) | `/` → `307 /en`; `/api/health` → `200` (`database: connected`, `kv: connected`); `/api/version` → `sha: f4285c5d...`, `environment: "production"` | **CANONICAL LIVE PRODUCTION WORKER (PRE-CUSTOM-DOMAIN)** |
| `https://apex-os.com` | Dynadot parking NS (`ns1.dyna-ns.net`, `185.53.179.128`) | `curl` connection timeout (`exit 28`) | **UNROUTED / PARKED** — `.github/workflows/deploy.yml:136` currently points here and will fail until updated or cut over |
| `https://apexos.io` | SiteGround NS (`ns1.siteground.net`, `34.174.56.185`) | `301` → `https://my.apexos.io/` | **UNOWNED THIRD PARTY** |

---

## 2. Security & Operational Implications Resolved in Phase 2

### 2.1 WebAuthn `RP_ID` & `ORIGIN` Safety (`workers.dev` Public Suffix List Constraint)
- `workers.dev` is listed on the Public Suffix List (PSL). Browsers reject `rpID: "workers.dev"` or `rpID: "agencyos-openclaw.workers.dev"` and require the **exact Worker hostname** (`apex-os-staging.agencyos-openclaw.workers.dev` or `apex-os.agencyos-openclaw.workers.dev`) when accessed via `*.workers.dev`, or `localhost` during local development.
- Furthermore, WebAuthn credentials registered against `apex-os.agencyos-openclaw.workers.dev` are cryptographically bound to that `rpID` and **cannot be replayed or migrated** once a custom production domain is attached — admins will need to re-enroll a passkey on the final custom domain.
- **Phase 2 remediation implemented:**
  1. Centralize canonical origin and WebAuthn Relying Party resolution in `src/lib/config/app-origin.ts` + `src/lib/auth/passkey-step-up.ts` so `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` are validated against an explicit allowlist of configured/request origins (`localhost`, `127.0.0.1`, `apex-os-staging.agencyos-openclaw.workers.dev`, `apex-os.agencyos-openclaw.workers.dev`, plus explicit `NEXT_PUBLIC_APP_URL` / `WEBAUTHN_ORIGIN` when set by operator), never defaulting to unowned domains (`apexos.app`, `apex-os.pages.dev`, `apex-os.com`, `apexos.io`).
  2. Populate explicit `NEXT_PUBLIC_APP_URL`, `WEBAUTHN_RP_ID`, and `WEBAUTHN_ORIGIN` in `wrangler.staging.jsonc` (`apex-os-staging.agencyos-openclaw.workers.dev`) and `wrangler.jsonc` (`apex-os.agencyos-openclaw.workers.dev`) so scheduled cron requests (`worker-cron-request.js`) and WebAuthn ceremonies work out of the box on the verified Workers without touching DNS.
  3. Remove `@apexos.app` fallback admin email strings from `src/app/api/admin/passkey/route.ts`, `src/app/api/admin/crawler/run/route.ts`, `src/app/api/admin/crawler/status/route.ts`, and `src/lib/payouts/admin-auth.ts`.

### 2.2 Short-Link `/r/[code]`, Portal Share URLs & Legal Pages
- `/r/[code]` (`src/app/r/[code]/route.ts`) sets a **host-only** `apex_ref` cookie (`HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS) without a cross-domain `Domain=` attribute, so it works safely on `localhost`, `apex-os-staging.agencyos-openclaw.workers.dev`, `apex-os.agencyos-openclaw.workers.dev`, and any future custom domain.
- Trader Portal referral link copy/share UI derives its display base URL from `resolvePublicAppOrigin()` (`NEXT_PUBLIC_APP_URL` or browser `window.location.origin`), never hardcoding `apexos.app` or `apex-os.com`.
- Legal pages (`/[locale]/legal/terms`, `/[locale]/legal/privacy`, `/[locale]/legal/risk-disclosure`) clearly identify **ApexOS (Non-Custodial Exchange Fee Rebate & Affiliate Attribution Platform)** as completely unaffiliated with any third-party enterprise automation or CRM product operating on `apexos.app`, `apexos.io`, or `apex-os.pages.dev`.

### 2.3 Deployment Verification & Documentation Alignment
- Update `.github/workflows/deploy.yml` production verification default (`${{ vars.PRODUCTION_URL || 'https://apex-os.agencyos-openclaw.workers.dev' }}`) and `scripts/verify-deployment.sh` (verify JSON `status === "ok"` on `/api/health` so static SPA `200 text/html` responses can never false-pass).
- Reconcile `README.md` and `CLAUDE.md` deployment targets from legacy Cloudflare Pages / `apexos.app` / `apex-os.pages.dev` to OpenNext Cloudflare Workers (`apex-os` and `apex-os-staging` on `agencyos-openclaw.workers.dev`).

---

## Unresolved Questions (Operator Custom Domain Decision Post-Merge)

1. **Future Custom Domain Selection:** Before public marketing launch or permanent admin passkey enrollment, which operator-owned Cloudflare Zone on account `f691e83094f776311a1bfe3f8b126f1c` should be bound as the canonical custom domain for Worker `apex-os` and Resend DKIM/SPF? (No external DNS or Worker custom domain routes were mutated during this run per strict non-destructive deployment boundaries.)
