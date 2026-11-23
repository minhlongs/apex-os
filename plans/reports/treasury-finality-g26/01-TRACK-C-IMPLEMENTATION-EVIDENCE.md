# G26 Track C — Treasury Finality & Secret Boundary Implementation Evidence

- **Baseline SHA:** `eb2e1e55015458a3b6d14358cb2f8e42f29cbaf7`
- **Branch:** `fix/apex-treasury-finality-secret-boundary`
- **Worktree:** `/Users/macbook/apex-os-worktrees/track-c-treasury`
- **Runtime:** Node.js `v26.7.0` (`better-sqlite3` ABI 147)

## Changed Files

1. `src/database/migrations/038_cold_finality_parity.sql` (new, additive, idempotent; prior migrations `001–037` untouched)
2. `src/lib/payouts/stellar-service.ts` (removed `secretKey`, `senderKeypair`, `Keypair.fromSecret`, and `STELLAR_SECRET_KEY` env fallback; fail-closed constructor)
3. `__tests__/payouts/g26-track-c-treasury-finality.test.ts` (new G26 Track C adversarial, rehearsal, secret-boundary, and 50-case concurrent recovery suite)
4. `__tests__/payouts/stellar-service.test.ts` (updated constructor/factory tests for removed `secretKey`)
5. `__tests__/payouts/g24-security-closure.test.ts` (updated Strategy A isolation test for fail-closed constructor)
6. `__tests__/payouts/g23-adversarial-treasury-chaos.test.ts` (updated Group B legacy test for removed `secretKey`)
7. `__tests__/payouts/stellar-readonly-health.test.ts` (updated Gate G8 test to assert fail-closed constructor on `S...` seed)

## Threat Model Summary (G26.C1 & G26.C2)

- **Prior gap in migration `037`:** `trg_settlement_enforce_hot_finality_promotion` and `trg_settlement_enforce_insert_finality` enforced full finality invariants on `HOT` (`state = 'CONFIRMED'`, non-empty `tx_hash`, NULL `safe_multisig_tx_hash`, fresh bounded `confirmation_observed_at`), but on `COLD` only checked non-empty `safe_multisig_tx_hash`. It did not require `state = 'CONFIRMED'`, non-empty `tx_hash`, distinct `safe_multisig_tx_hash != tx_hash`, non-empty `lock_batch_id`, or fresh `confirmation_observed_at`; nor did it block `NULL`-lane `CONFIRMED` bypasses, `HOT <-> COLD` `signing_lane` switching, or cross-payout `tx_hash`/`safe_multisig_tx_hash` reuse.
- **Mitigation in migration `038`:**
  - Partial unique indexes `idx_settlement_broadcasts_unique_tx_hash` and `idx_settlement_broadcasts_unique_safe_tx_hash` (case-insensitive, non-empty only — safe for NULLs on pending rows).
  - Replaced `trg_settlement_enforce_hot_finality_promotion`, `trg_settlement_preserve_confirmed_finality`, and `trg_settlement_enforce_insert_finality` with full `HOT`/`COLD` parity, `NULL`-lane `CONFIRMED` blocking, `signing_lane` immutability, and strict `safe_multisig_tx_hash != tx_hash` distinctness on `COLD`.
  - Legitimate pending `QUEUED_COLD_SAFE` rows without `tx_hash` or `confirmation_lane` remain unblocked.

## Stellar Secret & Signing Audit (`Keypair.fromSecret` / `STELLAR_SECRET_KEY`)

| Location | Usage | Status |
|---|---|---|
| `src/lib/payouts/stellar-service.ts` | Removed `secretKey`, `senderKeypair`, `Keypair.fromSecret`, `process.env.STELLAR_SECRET_KEY`. Constructor throws `LegacyPayoutPathDisabledError` if untyped `secretKey` is injected, and validates `senderPublicKey` via `StrKey.isValidEd25519PublicKey`. | Closed |
| `src/lib/payouts/stellar-service.ts` (`sanitizeStellarDiagnosticError`) | Regex redaction of accidental `S...` / `STELLAR_SECRET_KEY=` strings | Intentional defense-in-depth |
| `src/lib/auth/passkey-step-up.ts` | Secret-redaction regex list | Intentional defense-in-depth |
| `src/app/api/admin/settings/stellar/health/route.ts` | Comment only; reads `TURNKEY_STELLAR_HOT_WALLET_ADDRESS` only | Clean |
| `src/types/notifications.d.ts` | Legacy optional env type declaration (unused at runtime) | Non-executable type |
| `src/lib/payouts/crypto/ed25519-signer.ts` | Pure Ed25519 utility (not wired to Stellar raw secret env) | Out of Stellar hot-path |
| `__tests__/**`, `src/__tests__/**` | Canary/test fixtures verifying redaction and rejection | Test-only |

## Migration 038 Rehearsal Results

- Fresh schema `028 + 033–038`: PASS.
- Upgrade `028 + 033–037 -> 038` with pre-existing historical `BROADCAST_PENDING`, `CONFIRMED HOT`, `CONFIRMED COLD`, and legacy `NULL`-lane rows: PASS (all 4 historical rows preserved).
- Idempotency (re-executing `038_cold_finality_parity.sql` twice): PASS.
- SQLite backup & restore (`db.backup` -> readonly reload + trigger/row verification): PASS.
- All 14 adversarial negative cases + 50 concurrent recovery cases (30% deterministic RPC failure, 0 double settlements, exact liability conservation): PASS.

## Local Verification Commands & Exact Totals

| Command | Result |
|---|---|
| `npm run typecheck` | PASS (0 errors) |
| `npm run lint` | PASS (0 errors, 0 warnings) |
| `bash scripts/assert-staging-isolation.sh` | PASS (`STAGING_ISOLATED`) |
| `npm test` | PASS — **201 passed / 201 total suites; 4003 passed, 1 skipped, 0 failed / 4004 total tests** |
| `npm run build` | PASS (Next.js 16.4.6 production build clean) |
| `npm run build:worker` | PASS (OpenNext Cloudflare Worker bundle saved to `.open-next/worker.js`) |

## Remaining Live Blockers (Out of Offline Track C Scope)

- Remote D1 migration `038_cold_finality_parity.sql` has **not** been applied to staging or production D1 (per offline worktree constraint).
- Changes are left uncommitted in `/Users/macbook/apex-os-worktrees/track-c-treasury` for orchestrator review and commit.
