# Deploy Architecture

> **Mô tả / Description:** How this Worker is configured and deployed, and the
> invariants that keep a deploy from silently writing to the wrong database.
> Cách Worker này được cấu hình và triển khai, cùng các bất biến cần giữ.

## Single deploy config

`wrangler.jsonc` is the **only** deploy config. It replaced `wrangler.toml`,
which disagreed with it on `compatibility_date` (17 months apart) and on
`compatibility_flags`, and lacked the `assets` block that OpenNext requires.
Two live configs meant the deployed bindings depended on which file wrangler
happened to prefer — so the older one was deleted rather than synced.

`scripts/assert-deploy-config.cjs` enforces the single-config rule and refuses
to pass if a second config reappears. Run it before any deploy.

## Bindings

| Binding | Type | Database / resource |
|---|---|---|
| `DB` | D1 | `apex-os-db` (production) |
| `apex_os_staging_db` | D1 | `apex-os-staging-db` (staging) |
| `KV` | KV namespace | edge cache and rate-limit counters |
| `STORAGE` | R2 | `apex-os-uploads` |
| `ASSETS` | assets | `.open-next/assets` |

Both D1 databases are bound in the same config. That is intentional: staging
code reads the staging binding by name. It also means a deploy aimed at the
wrong environment is **not** a config error — it succeeds and writes to
production data. The config guard therefore asserts the two bindings resolve to
different `database_id` values, and production code must reference the `DB`
binding only.

## Runtime settings

- `main`: `worker-wrapper.js`
- `compatibility_date`: `2026-03-17`
- `compatibility_flags`: `nodejs_compat`, `global_fetch_strictly_public`

## Cron schedules

Schedule strings live in `worker-cron-schedules.js` and are consumed by both
the `crons` array above and the dispatcher in `worker-wrapper.js`. Cloudflare
echoes the configured string back in the `cf-cron-schedule` header, so the two
must never be written independently — if they disagree, the job silently never
runs.

| Job | Schedule |
|---|---|
| Alert engine evaluation | `*/5 * * * *` |
| D1 metrics collection | `*/30 * * * *` |
| Weekly payouts | `0 0 * * SUN` |

`__tests__/worker-cron-schedules.test.ts` fails if the config and the
dispatcher drift apart.

> **On the day-of-week form:** Cloudflare follows Quartz scheduler rules, where
> days of week run 1=Sunday through 7=Saturday and `0` is not a valid value.
> The old `wrangler.toml` used `0 0 * * 0` (invalid), and the old
> `wrangler.jsonc` used `0 0 * * 7` — which is **Saturday**, not Sunday. Both
> looked plausible and neither ran when intended: the invalid form was never
> sent, and the dispatcher's own literal `'0 0 * * 0'` matched neither. The
> three-letter `SUN` is used because it cannot be misread as an off-by-one week.

## Deploy graph

```
npm run build                    # next build  → .next/
opennextjs-cloudflare build      #             → .open-next/
opennextjs-cloudflare deploy     #             → Cloudflare Worker
```

`@opennextjs/cloudflare` resolves `opennextjs-cloudflare`; `wrangler` is
available through it but is not currently declared in `package.json`.

## Before every deploy

```bash
export PATH=/opt/homebrew/opt/node@26/bin:$PATH
node scripts/assert-deploy-config.cjs   # single config, distinct D1 ids
npm run typecheck                       # tsc --noEmit
npm run lint                            # eslint --max-warnings 0
CI=true npm test                        # refuse to run off Node 26
```

## Rollback

Cloudflare retains prior Worker versions, so `wrangler rollback` is the fastest
path back. Deployment IDs are **not** recorded anywhere automatically — capture
`wrangler deployments list --name apex-os` after each deploy so a rollback is a
one-command operation rather than archaeology.
