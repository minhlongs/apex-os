# Phase 5: Verification, Replay Testing & Cutover (Block E)

## Context
Validate the full system end-to-end:
- Replay test runs 50 deterministic ticks and verifies 100% bit-identical P&L output.
- All gates G0-G7 in `scripts/go-live-gate.sh` pass.
- Generate descriptive economic research report without blocking technical deployment.

## Tasks
1. Implement replay regression test in `__tests__/paper/replay.test.ts`.
2. Run full test suite (`npm test`).
3. Run `npm run typecheck` and `npm run lint`.
4. Run `bash scripts/go-live-gate.sh`.
5. Prepare PR description with all verification evidence.

## Verification
- 100% green test suite.
- Clean gate script exit code 0.
