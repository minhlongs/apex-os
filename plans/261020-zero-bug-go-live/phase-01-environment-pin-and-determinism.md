# Phase 01 — Environment Pin & Local Determinism

## Overview
- **Priority**: P1
- **Status**: pending
- **Effort**: 3h
- **Blocks**: Phase 02, Phase 03

Every downstream gate is meaningless if the toolchain is non-deterministic. Today, the same repo yields two opposite outcomes depending on which Node is on `PATH`: green under Node 26.7.0, 443 spurious failures under Node 22 (`better-sqlite3` ABI 147 vs 127). Also, `package.json` declares no `engines`, no `packageManager`, and no `.nvmrc`.

## Key Insights
- `package.json` has no `engines` field (verified: `engines: undefined`) and no `packageManager` (verified: `packageManager: undefined`).
- No `.nvmrc` file exists in repo root.
- `better-sqlite3 ^12.11.1` is a native module; ABI mismatch is environmental, not a code defect. This is the root cause of the "443 failures".
- Any CI introduced later **inherits** whatever Node it defaults to unless pinned here first. This phase must land before `.github/` exists, or CI bakes in the wrong runtime.

## Requirements
### Functional
- F1. A fresh clone must reach the identical green test outcome with zero manual environment setup.
- F2. The canonical Node version must be declared in at least two independent enforcement points.
- F3. `npm test` must fail fast (clear message, non-zero exit) when run under an incompatible Node, rather than emitting 443 confusing native-module errors.
- F4. The pin must record *which* Node the current green baseline was proven on.

### Non-Functional
- NF1. No behavior change to application code in this phase.
- NF2. `pnpm`/`npm` lockfile discipline: lockfile must be regenerated under the pinned Node.

## Architecture
Three enforcement layers, each independent (defense in depth):
1. **Advisory** — `.nvmrc` (fnm/nvm/asdf honor it).
2. **Declarative** — `package.json` `engines.node` (npm/pnpm warn or error on mismatch).
3. **Enforcing** — a `pretest` guard script that reads `process.versions.node`, compares against the declared floor, and exits non-zero with an actionable message before Jest spawns.

Why a guard script when `engines` exists: `engines` is advisory-by-default in npm unless `engine-strict=true` is set (which would break unrelated global flows). The guard is deterministic and self-documenting. YAGNI: no nvm auto-install, no volta, no Docker — those add ops surface for no marginal safety here.

## Related Code Files
### Modify
- `/Users/macbook/apex-os/package.json` — add `engines`, `packageManager`, `pretest` script.
- `/Users/macbook/apex-os/CLAUDE.md` — document the Node 26 requirement and PATH export.

### Create
- `/Users/macbook/apex-os/.nvmrc` — single line: verified Node version.
- `/Users/macbook/apex-os/scripts/verify-node-version.cjs` — the `pretest` guard.

### Delete
- *(none)*

## Implementation Steps
1. Create `.nvmrc` at repo root containing the exact verified version **without** the leading `v` (fnm compatibility):
   ```
   26.7.0
   ```
2. Create `scripts/verify-node-version.cjs`. It must:
   - Read `.nvmrc` from repo root (`path.resolve(__dirname, '..', '.nvmrc')`).
   - Parse as semver-ish major.minor against `process.versions.node`.
   - Read the floor from `package.json` `engines.node` — single source of truth is `engines`, `.nvmrc` is the human/nvm hint. The guard validates against `engines.node`.
   - On mismatch: `console.error` a message naming the actual version, the required range, and the exact `export PATH=/opt/homebrew/opt/node@26/bin:$PATH` fix, then `process.exit(1)`.
   - On match: `process.exit(0)` with no output.
   - Use `require` semantics (CJS) since `scripts/` currently uses `tsx` and Node must run this with no build step. Zero dependencies — read the two JSON/text files with `fs`. No `:any`.
3. Edit `package.json` scripts. Add `pretest` and a standalone `verify:env`:
   ```json
   "pretest": "node scripts/verify-node-version.cjs",
   "verify:env": "node scripts/verify-node-version.cjs"
   ```
   Keep existing `test` unchanged so `npm test` now transitive-guards.
4. Edit `package.json` to add, before `scripts` (alphabetical placement near `name`):
   ```json
   "engines": {
     "node": ">=26.7.0 <27.0.0"
   }
   ```
   Rationale for the closed upper bound: the ABI contract is proven only for 26.x; a future major silently changing V8/ABI is exactly the failure this phase exists to prevent.
5. Add `packageManager`. Detect the actual one first — run `pnpm --version` and confirm there is a `pnpm-lock.yaml` in repo root. **If the lockfile is absent, do NOT invent one**; omit `packageManager` rather than declare a tool whose lockfile does not exist. (Verify with `ls pnpm-lock.yaml package-lock.json yarn.lock`.)
6. Update `CLAUDE.md` "Common Development Commands" with a pinned preamble block:
   ```bash
   export PATH=/opt/homebrew/opt/node@26/bin:$PATH   # required — Node 22 breaks better-sqlite3
   ```
   Add a one-line note in the Testing Strategy section: all test counts in docs are Node 26.7.0 baselines.
7. Validate (see Success Criteria).

## Todo List
- [ ] `.nvmrc` created with `26.7.0`
- [ ] `scripts/verify-node-version.cjs` created, exit 0 on Node 26
- [ ] Guard exits non-zero with actionable message on Node 22
- [ ] `package.json` has `engines.node`, `pretest`, `verify:env`
- [ ] `packageManager` added **only if** a lockfile exists
- [ ] `CLAUDE.md` documents the export + baseline
- [ ] Full suite still green under Node 26

## Success Criteria
**Definition of done**: the green baseline is reproducible from a clean shell with no environment knowledge, and an incompatible Node is rejected before Jest starts.

**Validation commands**:
```bash
export PATH=/opt/homebrew/opt/node@26/bin:$PATH
node --version
node scripts/verify-node-version.cjs && echo GUARD_OK            # expect exit 0
npm run verify:env && echo ENV_OK
npx tsc --noEmit && echo TS_OK
npx eslint . --ext .ts,.tsx --max-warnings 0 && echo LINT_OK
CI=true npx jest 2>&1 | tail -8                                  # expect 0 failed
# Negative test — must fail fast, NOT emit 443 native errors:
/usr/bin/env node scripts/verify-node-version.cjs 2>&1 | head -5; echo "exit=$?"
```
Note: `pretest` firing on every `npm test` is expected; it adds ~50ms.

## Risk Assessment
| Risk | Likelihood × Impact | Mitigation |
|------|--------------------|------------|
| Guard blocks a legitimate future Node 27 run | Medium × Low | Bump `engines` deliberately after proving the ABI; the guard message tells you exactly what to edit. |
| `packageManager` declared without lockfile → hard pnpm failure | Low × High | Step 5 explicitly forbids declaring it without a lockfile. Verify, don't assume. |
| `pretest` interferes with direct `npx jest` invocations in existing scripts | Low × Medium | `pretest` only triggers via `npm test`. Existing `npx jest` calls unaffected — verified against `package.json` scripts. |

## Security Considerations
- No secrets introduced.
- `.nvmrc` and `engines` are public, non-sensitive metadata.
- The guard script reads only two repo files; no network, no env exfiltration.

## Next Steps
- **Unblocks Phase 02**: type-check restoration can now be debugged against a known-stable runtime.
- **Unblocks Phase 03**: commit hygiene runs against pinned tooling.
- Hands off to `reports/researcher-dependency-risk-report.md` for ABI specifics (pending).
