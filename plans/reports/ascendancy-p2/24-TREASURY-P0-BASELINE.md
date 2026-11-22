# G16.0 — Treasury pre-fix forensic baseline

Date: 2026-11-19. Status: baseline established; remediation and verification pending.

## Repository and execution boundary

- Audited and local SHA: `262b070a0f07eeb3367415bb192ed2bf717f5867`.
- Branch: `feat/ascendancy-phase2-verified`.
- PR: https://github.com/minhlongs/apex-os/pull/56. Read-only `gh pr view` returned OPEN, Draft, and the same head SHA.
- `git status --short` was empty before this report. No pre-existing uncommitted changes were found.
- `.github/workflows/deploy.yml` declares only `workflow_dispatch`. Ordinary feature-branch pushes trigger CI, not this deployment workflow. No workflow dispatch was requested.
- `git push --dry-run origin feat/ascendancy-phase2-verified` returned `Everything up-to-date`; no commit was pushed.
- Production and staging configuration both retain `AUTO_SETTLE_PAYOUTS=false` and `V1_STELLAR_ONLY_PAYOUTS=true`.
- Node: 26.7.0, consistent with package.json requirement >=26 <27. Installed pnpm: 12.18.0. Repository CI uses npm; subsequent verification must follow its commands.
- Reproduction uses isolated SQLite fixtures and mocked signing/RPC transports. Remote D1, signing credentials and mainnet access are neither required nor authorized.

## Confirmed source defects

### T-01: incomplete and reusable cold proof

`broadcast-recovery-machine.ts:421-518` permits empty metadata unless optional strictness is enabled, and permits partial metadata even with that option. `resolveColdSafeBroadcast` at lines 2450-2532 checks transaction success then updates the payout without a durable operation claim. The production EVM receipt implementation (`adapters/arbitrum-base-usdc-adapter.ts:772-800`) does not decode Transfer logs. The Stellar lookup (`stellar-horizon-transport.ts:220-229`) supplies success without payment operations. Migration 028 has no unique network/transaction/operation claim. The dispatch route finalizes the ledger separately after resolution.

### T-02: last-mile authorization absent

`turnkey-signer.ts:1069-1132` checks amount caps before transport signing but does not check live pause/freeze there. The initial machine execution checks safety earlier at `broadcast-recovery-machine.ts:934`; that alone cannot protect asynchronous signing, recovery or rebroadcast. Full irreversible-effect mapping remains in progress. No race-safety claim is made yet.

### T-03: unresolved exposure ages out

`turnkey-signer.ts:672-694`, conditional UPDATE at 806-833 and conditional INSERT at 869-889 filter all counted states by `created_at >= datetime('now', '-24 hours')`. Pending transactions older than that disappear. Migration 028 has no verified confirmation timestamp. Admission is global across chains and signers; that aggregate scope must not be weakened. Existing CONFIRMED cold rows are also included in the hot sum; any distinction must conservatively handle historical ambiguity.

## Existing test baseline

Command executed before production changes:

```sh
npx jest src/lib/payouts/__tests__/ --no-coverage 2>&1 | tail -n 35
```

Observed Jest summary: 11 suites passed, 113 tests passed. This pipeline did not preserve Jest's independent exit status; the displayed successful summary is recorded, not a separately captured Jest exit code. These existing tests do not establish remediation. New regressions must fail against the original implementation for unsafe outcomes, then pass after correction.

## Execution notes and change manifest

- Added this baseline report only in the primary worktree at this stage.
- Created isolated detached worktree `/Users/macbook/apex-os-worktrees/g16-red-tests` at the audited SHA for test-only reproduction.
- Automatic worktree hook failed with `missing file_path`; manual `git worktree add --detach` succeeded. No hook code was modified.
- Test-only agent owns the initial G16 regression file; it was transferred into the primary worktree only after its isolated run was reviewed. The same command was rerun from the primary worktree against this unchanged SHA, with exact Jest exit status captured.
- Exact primary-worktree command: `npm test -- --runInBand --no-coverage --runTestsByPath src/__tests__/sandbox/g16-treasury-regressions.test.ts`; Node 26.7.0; result: **1 suite failed, 10 tests failed, 3 passed, 13 total; exit 1**. Three passing controls accept matching recipient/asset/amount metadata under the old contract and reject wrong asset/amount. The acceptance control does not establish finalized canonical proof. The ten assertion failures reproduce: missing and recipient-only proof transition cold rows to `CONFIRMED`; same transaction proof confirms a second payout; direct EVM and Stellar signing still call the signer under both emergency flags; six 25-hour-old `BROADCAST_PENDING` rows totaling $1,500 are counted as zero, policy admits another $10, and atomic signing-slot claim succeeds. The failures are unsafe product outcomes, not setup errors. Full output is preserved in [the baseline regression log](./g16-baseline-regressions.txt); `src/__tests__/sandbox/g16-treasury-regressions.test.ts` is the local regression artifact.
- This initial red suite is narrower than the full COLD/PAUSE/CAP matrix; uncovered cases remain mandatory and must not be marked verified without tests.
- Independent scouts are forensic discovery, not post-fix independent sign-off.
- Report inventory under `plans/reports/ascendancy-p2/` contains G1–G11 sign-off, G13-A baseline and G14 audit; no G15.3 failure log or G15.4 FAIL report was found. The user-provided G15 labels are preserved as task context, not treated as independently sourced evidence.
- Automated short-link allowlist warning is outside treasury scope and remains unverified; no unrelated fix has been included.

## Outstanding evidence

The final recovery call graph and effect tests, full COLD/PAUSE/CAP matrix, all post-fix checks and production multisig/reserve attestations remain outstanding. G15 provenance is not present in this worktree's report inventory. No treasury PASS, production attestation, deployment or real-money authorization is implied.
