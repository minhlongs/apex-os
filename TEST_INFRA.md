# E2E Test Infra: Multi-Chain Automated Payout Rails & Settlement Engine

## Test Philosophy
- Opaque-box, requirement-driven derived directly from `ORIGINAL_REQUEST.md`.
- Methodology: Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial + Real-World Workloads.
- No Node C++ native dependencies; pure Jest / Vitest TypeScript runner.

## Feature Inventory
| # | Feature | Source | Tier 1 | Tier 2 | Tier 3 |
|---|---------|--------|:------:|:------:|:------:|
| 1 | Schema Migration 023 | ORIGINAL_REQUEST §R5 | 5 | 5 | ✓ |
| 2 | Multi-Chain Types & Audit Logger | ORIGINAL_REQUEST §R1, R4 | 5 | 5 | ✓ |
| 3 | Edge JSON-RPC & Crypto Codecs | ORIGINAL_REQUEST §R1, R5 | 5 | 5 | ✓ |
| 4 | Chain Adapters (Stellar, EVM, Solana) | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 5 | PayoutRouter & Address Validation | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 6 | TreasuryHealthService & Pause Gate | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| 7 | BatchSettlementService & Ledger Safety | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 8 | Admin Payout Controls (/batch, /retry, /treasury) | ORIGINAL_REQUEST §R4 | 5 | 5 | ✓ |

## Test Architecture
- Test runner: Jest (`npm test`)
- Mock strategy: In-memory Cloudflare D1 with SQLite trigger enforcement (`mockFraudDB` / D1 mock pattern)
- Blockchain RPC mock strategy: Mock fetch / JSON-RPC responses for Horizon, Ethereum EVM RPC, Solana JSON-RPC
- Directory layout: `src/lib/payouts/__tests__/` and `src/app/api/admin/payouts/__tests__/`

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Full Happy-Path Multi-Chain Batch Run | Earnings query -> threshold filter -> reserve -> route to 3 chains -> execute -> reconcile -> audit log | High |
| 2 | Treasury Depletion Circuit Breaker | Reserves fall below safety floor -> automated batch halts -> admin alert emitted -> no funds leaked | Medium |
| 3 | Network Error & Idempotent Admin Retry | RPC network failure during broadcast -> payout marked failed -> admin retry re-estimates gas -> success with same idempotency key | High |
| 4 | Concurrency & Double-Spend Prevention | Dual simultaneous batch requests compete for same pending earnings -> exactly-once settlement | High |
| 5 | Invalid Wallet & Fallback Rejection | Malformed addresses / wrong checksum / invalid base58 rejected before any on-chain call | Medium |

## Coverage Thresholds
- Tier 1: Feature Coverage (>=5 per feature)
- Tier 2: Boundary & Corner Cases (>=5 per feature)
- Tier 3: Cross-Feature Combinations (pairwise coverage)
- Tier 4: Real-World Application Scenarios (>=5 realistic scenarios)
