# Project: Multi-Chain Automated Payout Rails & Settlement Engine for ApexOS

## Architecture
Pluggable multi-chain automated payout rails extending ApexOS settlement capabilities from Stellar to Ethereum (ERC-20 USDC/USDT) and Solana (SPL USDC), built for Cloudflare Workers/Pages Edge Runtime without native Node C++ dependencies.

```
                    ┌────────────────────────┐
                    │ Admin & Scheduled Jobs │
                    │ /api/admin/payouts/*   │
                    └───────────┬────────────┘
                                │
                                ▼
                   ┌───────────────────────────┐
                   │  BatchSettlementService   │
                   │  - Threshold Filtering    │
                   │  - D1 Atomic Reservation  │
                   │  - Idempotency Keys       │
                   └───────┬───────────┬───────┘
                           │           │
            ┌──────────────┘           └──────────────┐
            ▼                                         ▼
┌─────────────────────────┐               ┌───────────────────────────┐
│  TreasuryHealthService  │               │       PayoutRouter        │
│  - Native Gas Floors    │               │  - User preferred_chain   │
│  - Stablecoin Reserves  │               │  - Address Verification   │
│  - Auto-Pause Gate      │               └─────────────┬─────────────┘
└─────────────────────────┘                             │
                                  ┌─────────────────────┼─────────────────────┐
                                  ▼                     ▼                     ▼
                        ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
                        │ StellarAdapter  │   │ EthereumAdapter │   │  SolanaAdapter  │
                        │ - Horizon RPC   │   │ - Edge JSON-RPC │   │ - Edge JSON-RPC │
                        │ - XLM / USDC    │   │ - Keccak-256    │   │ - Base58 Codec  │
                        │                 │   │ - EIP-55        │   │ - SPL Transfers │
                        │                 │   │ - EIP-1559 Fees │   │ - Compute Budget│
                        └─────────────────┘   └─────────────────┘   └─────────────────┘
                                  │                     │                     │
                                  └─────────────────────┼─────────────────────┘
                                                        │
                                                        ▼
                                      ┌───────────────────────────────────┐
                                      │ Cloudflare D1 Storage & Auditing │
                                      │ - Migration 023_multichain        │
                                      │ - payouts (extended)              │
                                      │ - payout_batches                  │
                                      │ - payout_audit_logs (immutable)   │
                                      └───────────────────────────────────┘
```

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Schema Migration 023 | Cloudflare D1 migration defining `payout_batches`, `payout_audit_logs`, immutability triggers, and extending `payouts` with multi-chain columns | M1 | ORIGINAL_REQUEST §R5 |
| 2 | Core Multi-Chain Types | TypeScript type definitions for chains, adapters, fee estimation, batch records, and audit events | M1 | ORIGINAL_REQUEST §R1, R2 |
| 3 | Immutable Audit Logger | `PayoutAuditService` providing atomic dual-write audit logs with SQLite trigger immutability | M1 | ORIGINAL_REQUEST §R4 |
| 4 | Edge JSON-RPC Client | Pure TypeScript `fetch`-based JSON-RPC client with timeout, exponential backoff, and retry for HTTP 429/5xx | M2 | ORIGINAL_REQUEST §R5 |
| 5 | Edge Crypto & Codecs | Zero-dependency pure TS Keccak-256, EIP-55 checksum validator/formatter, and strict 32-byte Base58 codec | M2 | ORIGINAL_REQUEST §R1, R5 |
| 6 | Pluggable Chain Adapter Interface | `PayoutChainAdapter` defining `estimateFee`, `sendPayout`, `verifyTransaction`, `getTreasuryBalance` | M2 | ORIGINAL_REQUEST §R1 |
| 7 | Stellar Payout Adapter | `StellarAdapter` wrapping Horizon operations for USDC and XLM gas fee estimation and verification | M2 | ORIGINAL_REQUEST §R1 |
| 8 | Ethereum EVM Adapter | `EthereumAdapter` supporting ERC-20 (USDC/USDT), calldata encoding (`0xa9059cbb`), EIP-1559 gas estimation, simulation, and receipt polling | M2 | ORIGINAL_REQUEST §R1 |
| 9 | Solana SPL Adapter | `SolanaAdapter` supporting SPL USDC transfer instructions, compute unit budgeting, blockhash freshness, and commitment confirmation | M2 | ORIGINAL_REQUEST §R1 |
| 10 | Payout Router | `PayoutRouter` resolving target adapter from user `preferred_chain` with strict chain-specific address validation | M2 | ORIGINAL_REQUEST §R1 |
| 11 | Treasury Balance & Gas Health Monitoring | `TreasuryHealthService` querying native gas & stablecoin balances, safety floors, and returning HEALTHY / LOW_RESERVE / CRITICAL | M3 | ORIGINAL_REQUEST §R3 |
| 12 | Automated Circuit Breaker / Pause Gate | Halts automated batch settlements when treasury gas or stablecoin balances fall below safety floor | M3 | ORIGINAL_REQUEST §R3 |
| 13 | Threshold Filtering & Affiliate Grouping | `BatchSettlementService` querying unpaid earnings meeting minimum threshold (default $50) grouped by affiliate | M4 | ORIGINAL_REQUEST §R2 |
| 14 | Atomic Double-Entry Ledger Reservation | Atomic two-phase reservation in D1 (`db.batch`): reserving earnings (`is_paid = 0 AND payout_id IS NULL`), creating `payout_batches` and `payouts` | M4 | ORIGINAL_REQUEST §R2 |
| 15 | Idempotency Safeguards | Deterministic idempotency keys per payout execution preventing duplicate on-chain transfers or multiple ledger debits | M4 | ORIGINAL_REQUEST §R2 |
| 16 | Ledger Reconciliation & Status Transition | Double-entry commit (`pending` → `processing` → `completed` | `failed`), atomically updating earnings to paid or rolling back on error | M4 | ORIGINAL_REQUEST §R2 |
| 17 | Admin Batch Payout Endpoint | `POST /api/admin/payouts/batch` for previewing and executing scheduled/manual batches with chain filtering and audit logging | M5 | ORIGINAL_REQUEST §R4 |
| 18 | Admin Retry & Manual Resolution Endpoint | `POST /api/admin/payouts/retry` for retrying failed payouts with fee re-estimation and resolving stuck transactions | M5 | ORIGINAL_REQUEST §R4 |
| 19 | Admin Treasury Inspection Endpoint | `GET /api/admin/payouts/treasury` inspecting multi-chain balances, health levels, and pending settlement queues | M5 | ORIGINAL_REQUEST §R4 |
| 20 | Comprehensive Test Suite & Regression Verification | 100% test pass rate across unit/integration/E2E tests, 0 TypeScript compile errors, and clean Next.js production build | M6 | ORIGINAL_REQUEST Acceptance Criteria |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Schema Migration & Multi-Chain Types | Migration `023_multichain_payouts.sql`, TypeScript interfaces, Audit Logger | none | DONE |
| M2 | Multi-Chain Adapters & Payout Router | Edge JSON-RPC client, Keccak-256, Base58, Stellar/Ethereum/Solana adapters, PayoutRouter | M1 | DONE |
| M3 | Gas Fee Estimation & Treasury Health Monitoring | `TreasuryHealthService`, balance health classifications, automated pause gate | M1, M2 | IN_PROGRESS |
| M4 | Automated Batch Settlement & Ledger Reconciliation | `BatchSettlementService`, D1 atomic reservation, double-entry safety, idempotency | M1, M2, M3 | PLANNED |
| M5 | Admin Payout Controls, Retries & Audit APIs | `/api/admin/payouts/batch`, `/api/admin/payouts/retry`, `/api/admin/payouts/treasury` | M1, M2, M3, M4 | PLANNED |
| M6 | Test Suite & Build Verification | Comprehensive 4-tier test suite, `tsc --noEmit`, clean production build | M1..M5 | PLANNED |

## Interface Contracts
### PayoutChainAdapter
```typescript
export interface PayoutChainAdapter {
  readonly chain: 'stellar' | 'ethereum' | 'solana';
  validateAddress(address: string): boolean;
  estimateFee(params: FeeEstimateParams): Promise<ChainFeeEstimate>;
  sendPayout(params: PayoutExecutionParams): Promise<PayoutExecutionResult>;
  verifyTransaction(transactionId: string): Promise<TransactionVerificationResult>;
  getTreasuryBalance(): Promise<TreasuryBalanceResult>;
}
```

### BatchSettlementService
```typescript
export interface BatchSettlementService {
  previewBatch(options?: BatchPreviewOptions): Promise<BatchPreviewResult>;
  executeBatch(options?: BatchExecutionOptions): Promise<BatchExecutionResult>;
  retryPayout(payoutId: string, options?: RetryOptions): Promise<PayoutExecutionResult>;
}
```

### TreasuryHealthService
```typescript
export interface TreasuryHealthService {
  checkHealth(chain?: SupportedPayoutChain): Promise<TreasuryHealthReport>;
  canSettle(amountUsd: number, chain: SupportedPayoutChain): Promise<{ allowed: boolean; reason?: string }>;
}
```

## Code Layout
- `src/database/migrations/023_multichain_payouts.sql`: D1 migration file
- `src/lib/payouts/types.ts`: Shared types, enums, interfaces
- `src/lib/payouts/audit-service.ts`: Audit logging helper with immutability
- `src/lib/payouts/rpc/json-rpc-client.ts`: Edge fetch-based JSON-RPC client
- `src/lib/payouts/crypto/keccak.ts`: Pure TS Keccak-256 & EIP-55 validator
- `src/lib/payouts/crypto/base58.ts`: Pure TS Base58 validator/codec
- `src/lib/payouts/adapters/adapter-interface.ts`: `PayoutChainAdapter` interface
- `src/lib/payouts/adapters/stellar-adapter.ts`: Stellar Horizon adapter
- `src/lib/payouts/adapters/ethereum-adapter.ts`: EVM ERC-20 adapter
- `src/lib/payouts/adapters/solana-adapter.ts`: Solana SPL adapter
- `src/lib/payouts/router.ts`: `PayoutRouter`
- `src/lib/payouts/treasury-health-service.ts`: Treasury balances & pause gate
- `src/lib/payouts/batch-settlement-service.ts`: Batch settlement engine
- `src/app/api/admin/payouts/batch/route.ts`: Admin batch endpoint
- `src/app/api/admin/payouts/retry/route.ts`: Admin retry endpoint
- `src/app/api/admin/payouts/treasury/route.ts`: Admin treasury endpoint
- `src/lib/payouts/__tests__/*`: Comprehensive test files
