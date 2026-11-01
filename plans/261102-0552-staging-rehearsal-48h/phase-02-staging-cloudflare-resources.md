# Phase 2: Provision Staging R2, Apply D1 Migrations 028–030 & Secret Setup

## Context
- Remote Cloudflare account `f691e83094f776311a1bfe3f8b126f1c` is missing R2 bucket `apex-os-uploads-staging`, D1 migrations `028–030` on `apex-os-staging-db`, and `TERMINAL_HMAC_SECRET` on `apex-os-staging`.

## Steps
1. Create R2 bucket `apex-os-uploads-staging` via `npx wrangler r2 bucket create apex-os-uploads-staging`.
2. Execute `028_paper_trading_journal.sql`, `029_paper_trading_outbox_and_runs.sql`, `030_paper_trading_triggers_and_outbox_sync.sql` against remote `apex-os-staging-db`.
3. Verify the 4 tables (`paper_trade_journal`, `paper_strategy_snapshots`, `paper_trading_runs`, `paper_trading_outbox`) and 2 append-only triggers exist in `sqlite_master`.
4. Set `TERMINAL_HMAC_SECRET` on `apex-os-staging` via `openssl rand -hex 32 | npx wrangler secret put TERMINAL_HMAC_SECRET --config wrangler.staging.jsonc`.

## Validation
- `npx wrangler r2 bucket list` includes `apex-os-uploads-staging`.
- Remote D1 query returns all 4 tables and 2 triggers.
- `npx wrangler secret list --config wrangler.staging.jsonc` includes `TERMINAL_HMAC_SECRET`.
