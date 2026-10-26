# ApexOS KYC & Regulatory Compliance Engine

ApexOS features an automated regulatory compliance engine designed for cryptocurrency cashback and affiliate payouts. It enforces tiered 30-day rolling payout limits, on-chain AML sanctions screening, non-custodial identity verification provider integrations (Sumsub/Persona contract), automated hold/release queues, and administrative review controls with tamper-proof audit trails.

---

## 1. Compliance Tiers & Payout Limits

| Tier | Name | 30-Day Rolling Cap | Requirements | Status Behavior |
|---|---|---|---|---|
| **Tier 0** | `tier0_unverified` | **$500.00 USD** | Account created, unverified identity | Payouts above $500 are held as `kyc_required` |
| **Tier 1** | `tier1_basic` | **$2,500.00 USD** | Verified email + basic identity proof | Holds triggered if cumulative volume > $2,500 |
| **Tier 2** | `tier2_enhanced` | **$50,000.00 USD+** | Full KYC (government ID, proof of address) | High-volume automated batch settlement |

### Anti-Smurfing Enforcement
Cumulative payout volume is calculated over a rolling 30-day window (`datetime('now', '-30 days')`). An unverified affiliate attempting multiple payouts totaling more than $500 is automatically blocked from on-chain dispatch with reason code `KYC_TIER_LIMIT_EXCEEDED`.

---

## 2. On-Chain AML & Sanctions Screening

The `SanctionsScreeningService` screens destination wallet addresses across all supported chains before any transaction is broadcast:

- **Supported Blockchains**: Ethereum, Solana, Stellar.
- **Pre-Flight Interception**: Synchronously invoked inside `PayoutRouter.sendPayout` and `BatchSettlementService.executeBatch`.
- **Normalization**:
  - Ethereum: EIP-55 checksum and lowercase normalization.
  - Solana: Base58 public key validation.
  - Stellar: Base32 public key starting with 'G'.
- **Sanctions Match Action**: If an address matches an OFAC SDN entry or blacklisted entity, payout status is set to `compliance_blocked` (`SANCTIONS_MATCH`), transaction broadcast is aborted immediately, and a high-severity entry is recorded in `compliance_audit_logs`.

---

## 3. Identity Verification Provider Integration

- **`POST /api/kyc/initiate`**: Generates a verification session token and redirect URL for the authenticated user.
- **`POST /api/webhooks/kyc`**: Edge-compatible webhook endpoint verifying HMAC-SHA256 signatures (`KYC_WEBHOOK_SECRET`).
  - Idempotently processes events: `approved`, `rejected`, `requires_action`.
  - When a user is marked `approved`, `profiles.kyc_status` becomes `approved`, `profiles.kyc_tier` is upgraded to `tier2_enhanced`, and the `AutoReleaseService` unholds all previously held `kyc_required` payouts for the affiliate.

---

## 4. Administrative Compliance Dashboard

Compliance officers manage compliance holds and sanctions lists at `/admin/compliance`:

- **`/api/admin/compliance/payouts`**: Filter held payouts by status (`kyc_required`, `compliance_blocked`), search by affiliate or transaction ID.
- **`/api/admin/compliance/review`**: Execute actions on held payouts (`approve`, `reject`, `reverify`, `flag_address`).
- **`/api/admin/compliance/sanctions`**: Add or remove addresses from the local sanctions database.
- **Role Enforcement**: Requires active Better Auth session with `role = 'admin'` (HTTP 403 otherwise).

---

## 5. Database Schema & Immutability

Migration `src/database/migrations/024_kyc_compliance_schema.sql`:
- Extends `profiles` with `kyc_status`, `kyc_tier`, and `kyc_verified_at`.
- Creates `sanctioned_addresses` pre-seeded with known OFAC SDN addresses (including Tornado Cash routers).
- Creates `compliance_audit_logs` protected by SQLite `BEFORE UPDATE` and `BEFORE DELETE` triggers to ensure tamper-proof audit trails.
- Extends `payouts` with `compliance_status` and `compliance_reason`.
