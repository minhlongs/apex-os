# ApexOS Multi-Chain Automated Payout Rails & Settlement Engine

ApexOS features a high-throughput, edge-compatible multi-chain payout settlement engine supporting **Stellar (USDC)**, **Ethereum (ERC-20 USDC/USDT)**, and **Solana (SPL USDC)** with automated batch settlement, real-time gas fee estimation, treasury balance monitoring, failure retries, and immutable administrative audit logs.

---

## 1. System Architecture

```
                                  [ Unpaid Earnings in D1 ]
                                            │
                                            ▼
                           ┌───────────────────────────────────┐
                           │      BatchSettlementService       │
                           │  - Query earnings >= $50 threshold │
                           │  - Group by affiliate_id & chain  │
                           │  - Atomic db.batch reservation    │
                           │  - Generate SHA-256 idempotency   │
                           └─────────────────┬─────────────────┘
                                             │
                        ┌────────────────────┴────────────────────┐
                        ▼                                         ▼
            [ TreasuryHealthService ]                     [ PayoutRouter ]
            - Query hot wallet balances                   - Validate wallet addresses
            - Compare to safety floors                    - Route by user preferred_chain
            - Circuit breaker halt if CRITICAL            - Dispatch to Chain Adapter
                        │                                         │
                        └────────────────────┬────────────────────┘
                                             │
                     ┌───────────────────────┼───────────────────────┐
                     ▼                       ▼                       ▼
            [ StellarAdapter ]      [ EthereumAdapter ]     [ SolanaAdapter ]
             - Stellar Horizon       - EVM ERC-20 calldata   - SPL Token Transfer
             - USDC trustlines       - EIP-1559 gas calc     - Base58 public keys
             - Stroop fee units      - JSON-RPC edge client  - Compute unit budget
                     │                       │                       │
                     └───────────────────────┼───────────────────────┘
                                             │
                                             ▼
                                [ Transaction Broadcast ]
                                             │
                     ┌───────────────────────┴───────────────────────┐
                     │                                               │
            [ Status: Completed ]                           [ Status: Failed ]
            - Update payouts (status, tx_id)                - Record error_message
            - Mark earnings is_paid = 1                     - Release reservation
            - Write payout_audit_logs                       - Enable admin CAS retry
```

---

## 2. Multi-Chain Adapters

| Chain | Native Gas Asset | Supported Stablecoin | Transfer Mechanism | Edge Crypto Implementation |
|---|---|---|---|---|
| **Stellar** | XLM (Stroops) | USDC (Asset) | Stellar Horizon SDK / REST API | Pure JS / REST |
| **Ethereum** | ETH (Wei / Gwei) | ERC-20 USDC / USDT | `transfer(address,uint256)` via JSON-RPC | Pure TypeScript Keccak-256 & EIP-55 |
| **Solana** | SOL (Lamports) | SPL Token USDC | `TransferChecked` / `Transfer` via JSON-RPC | Pure TypeScript Base58 Codec |

### Edge Runtime Compatibility
All blockchain communication is executed using standards-compliant `fetch`-based JSON-RPC and REST requests, avoiding Node.js C++ addons or native bindings to guarantee native execution inside Cloudflare Workers / Pages edge environments.

---

## 3. Automated Batch Settlement & Double-Entry Safety

- **Minimum Payout Threshold**: Default $50.00 USD. Affiliates with total unpaid earnings below the threshold remain pending until the floor is reached.
- **Two-Phase Atomic Reservation**: Prior to broadcasting on-chain, earnings rows are reserved via `UPDATE earnings SET payout_id = ? WHERE affiliate_id = ? AND is_paid = 0 AND payout_id IS NULL`.
- **Deduplication & Idempotency**: Each payout generates a deterministic idempotency key (`idem_payout_<affiliateId>_<earningsDigest>`) enforced by a `UNIQUE INDEX` in Cloudflare D1.
- **Atomic Reconciliation**: When an on-chain transaction succeeds, `payouts.status` is set to `completed` and all associated `earnings` records are set to `is_paid = 1`. In the event of a broadcast failure, earnings reservations are released for safe retries without double-crediting.

---

## 4. Treasury Health Monitoring & Circuit Breaker

The `TreasuryHealthService` inspects treasury hot wallet reserves across all supported chains prior to executing settlement runs:

- **HEALTHY**: Balances exceed target operating reserves (e.g. >= 2.0 ETH, >= 50 SOL, >= 1,000 XLM + required stablecoin liquidity). Batches execute automatically.
- **LOW_RESERVE**: Balances are sufficient for the current batch but approaching minimum thresholds. Alerts are emitted to administrators.
- **CRITICAL**: Balances cannot cover the batch plus estimated gas fees. Automated batch processing is **halted immediately** by the circuit breaker to prevent transaction broadcast failures.

---

## 5. Administrative Endpoints

All admin endpoints require an active session with `role = 'admin'` verified through Better Auth and Cloudflare D1.

### 5.1. Batch Settlement (`/api/admin/payouts/batch`)
- `GET /api/admin/payouts/batch?chain=ethereum&min_threshold=50`: Preview pending settlement totals, affiliate counts, and estimated gas fees.
- `POST /api/admin/payouts/batch`: Trigger execution of the batch settlement. Writes audit records to `payout_audit_logs`.

### 5.2. Payout Retry (`/api/admin/payouts/retry`)
- `POST /api/admin/payouts/retry`: Retries a previously failed payout with refreshed real-time gas fee estimation and Compare-And-Swap (CAS) state locking.

### 5.3. Treasury Inspection (`/api/admin/payouts/treasury`)
- `GET /api/admin/payouts/treasury`: Returns hot wallet native gas balances, stablecoin balances, and overall health status levels across all chains.

---

## 6. Database Schema & Immutability

Migration `src/database/migrations/023_multichain_payouts.sql`:
- Creates `payout_batches` table tracking batch identifiers, metrics, and totals.
- Extends `payouts` with `chain`, `batch_id`, `idempotency_key`, `gas_fee_native`, and `gas_fee_usd`.
- Creates `payout_audit_logs` protected by SQLite `BEFORE UPDATE` and `BEFORE DELETE` triggers to ensure tamper-proof audit trails.
