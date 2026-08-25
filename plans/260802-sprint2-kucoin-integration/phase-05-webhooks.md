# Phase 05 — Team Performance Report

## Status
complete

## Goal
Implement team performance reporting endpoints and views — affiliate downline stats, conversion funnels, and cache-backed metrics.

## Dependencies
- Phase 04 complete

## Acceptance Criteria
- [x] Team stats endpoint returns per-affiliate: total conversions, commission earned, active deals clicked
- [x] Response cached (KV, 5 min TTL) consistent with existing metrics-cache pattern
- [x] Types updated in `src/types/metrics.ts` if needed
- [x] No new env vars required

## Implementation Notes
- Reuse `metrics-cache.ts` KV wrapper
- Query: `conversions` + `earnings` + `referral_tree` for downline resolution
- Response shape mirrors existing business metrics API
