# Phase 01: Fix Alert Engine + Mock DB

## Context
~75 test failures stem from two root causes: inverted trend logic in business-alert-engine and incomplete mock DB returning undefined for UPDATE/DELETE paths.

## Files to Modify
- `src/lib/alerts/business-alert-engine.ts` — fix calculateTrend inversion, unwrap payload.details
- `src/lib/alerts/config.ts` — verify threshold comparisons
- `__tests__/lib/alerts/alert-storage.test.ts` — fix mock DB to return {results, meta} for all paths
- `__tests__/lib/alerts/business-alert-engine.test.ts` — update expectations if needed

## Steps
1. Fix calculateTrend: swap "up"/"down" return values
2. Fix metric path: unwrap payload.details before reading clicks/conversions
3. Fix threshold comparisons: verify operators match business intent
4. Fix mock DB: ensure .all() after .run() returns {results: [], meta: {}}
5. Fix updateAlert/deleteAlert: properly update in-memory store, return true
6. Run tests: `pnpm test -- __tests__/lib/alerts/`

## Acceptance
- alert-storage suite: 0 failures
- business-alert-engine suite: 0 failures
- Total tests: >1350 passing
