# Phase 04 — Public API, Webhooks, Integrations

## Status
complete

## Goal
Complete the public-facing deals API with city/region targeting, webhook enhancements for KuCoin, and integration contracts.

## Dependencies
- Phase 03 complete (city/region targeting wired into UI and schema)

## Acceptance Criteria
- [x] Public deals API (`/api/public/deals`) supports city/region filtering with jq-compatible `?city=` and `?region=` params
- [x] KuCoin webhook handler (`/api/webhooks/exchange`) processes nested payload and signature format per `docs/exchanges/kucoin.md`
- [x] `/api/public/deals` returns 60s-cached responses with correct city/region filters
- [x] No breaking changes to existing API contract (existing `?exchange=` filter still works)
- [x] Rate limiting enforced (500 req/hour per IP)

## Implementation Notes
- Extend `DealListQuery` type if new query params are added
- KV cache key pattern: `public:deals:{hash(queryParams)}`
- City slugs are lowercase, hyphenated (e.g. `ho-chi-minh-city`)
