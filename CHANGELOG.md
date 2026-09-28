# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-09-28

### Added
- **KYC & Regulatory Compliance Engine**: Tiered 30-day rolling payout limits ($500 unverified ceiling, $2,500 basic, $50,000+ enhanced) protecting cryptocurrency settlement rails against illicit flows and financial non-compliance.
- **On-Chain Sanctions & AML Address Screening**: Pre-flight screening of recipient wallet addresses on Ethereum, Solana, and Stellar via `SanctionsScreeningService`, blocking OFAC SDN sanctioned addresses and mixer deposits with `compliance_blocked` status and high-severity audit logging.
- **Identity Verification Webhook & Automated Release**: Provider-agnostic KYC session generation (`/api/kyc/initiate`) and edge HMAC-SHA256 webhook handler (`/api/webhooks/kyc`) that upgrades user profiles to `tier2_enhanced` upon approval and automatically unholds previously blocked `kyc_required` payouts via `AutoReleaseService`.
- **Administrative Compliance Review Dashboard**: Responsive management dashboard (`/admin/compliance`) and secure API endpoints (`/api/admin/compliance/*`) for reviewing held payouts, managing local sanctions watchlists, and logging immutable audit events into `compliance_audit_logs`.
- **D1 Schema Migration 024**: Migration `024_kyc_compliance_schema.sql` adding `sanctioned_addresses` (pre-seeded with OFAC SDN list), `compliance_audit_logs` with SQLite engine immutability triggers, and payout compliance tracking fields.

## [1.2.0] - 2026-09-28

### Added
- **Multi-Chain Automated Payout Rails & Settlement Engine**: Pluggable `PayoutChainAdapter` architecture extending settlement beyond Stellar to Ethereum (EVM ERC-20 USDC/USDT) and Solana (SPL USDC) with pure TypeScript Keccak-256 and Base58 codecs for edge runtime compatibility.
- **Automated Batch Settlement & Ledger Safety**: `BatchSettlementService` with $50 minimum threshold aggregation, Cloudflare D1 atomic two-phase reservation (`db.batch`), deterministic SHA-256 idempotency key generation, and strict double-entry ledger reconciliation.
- **Treasury Health Monitoring & Circuit Breaker**: `TreasuryHealthService` inspecting native gas and stablecoin reserves across Ethereum, Solana, and Stellar, grading health status (`HEALTHY`, `LOW_RESERVE`, `CRITICAL`), and pausing automated batch processing when hot wallet reserves fall below safety floors.
- **Admin Payout Controls & Immutability**: Endpoints for batch preview and triggering (`/api/admin/payouts/batch`), failed payout retry with gas re-estimation and CAS guards (`/api/admin/payouts/retry`), and treasury inspection (`/api/admin/payouts/treasury`), backed by tamper-proof `payout_audit_logs` protected by SQLite engine triggers.
- **D1 Schema Migration 023**: Migration `023_multichain_payouts.sql` introducing `payout_batches`, `payout_audit_logs`, multi-chain columns on `payouts`, and immutability triggers.

## [1.1.0] - 2026-09-27

### Added
- **OKX & KuCoin Multi-Exchange Webhooks**: Unified router (`/api/webhooks/exchange`) and dedicated endpoints (`/okx`, `/kucoin`), HMAC-SHA256 signature verification (including KuCoin Base64 encoding), 5-minute timestamp validation windows, and 30-day click attribution matching.
- **Advanced Analytics Dashboard & D1 Views**: 5 materialized views in migration `018_analytics_views.sql` (`analytics_daily_deals`, `analytics_daily_affiliates`, `analytics_exchange_breakdown`, `analytics_top_pairs`, `analytics_funnel_daily`), administrative analytics dashboard (`/[locale]/admin/analytics`), CSV export, and KV caching layer.
- **Lifecycle Transactional Email Engine**: 5 React Email templates (`WelcomeEmail`, `ConversionEarnedEmail`, `PayoutSentEmail`, `WeeklySummaryEmail`, `DealExpiringEmail`), queue architecture in D1 (`email_queue`, `email_events`), priority scheduling, retry processor (up to 3 retries), and hourly cron trigger (`/api/cron/process-email-queue`).
- **ApexOS Mobile Store & TestFlight Readiness**: React Native 0.86 and Expo SDK 52 mobile application, Hermes bytecode optimization producing a 5.4MB dual-platform bundle (<50MB ceiling), complete EAS Build profiles (`development`, `preview`, `production`), App Store / Google Play metadata, global `ErrorBoundary`, safe area handling, and deep link routing (`apex-os://billing/result`, `apex-os://wallet-connected`).
- **Fraud Anomaly Detection Engine & Admin Review**: Multi-tier defense on click tracking, dual-window rate limiting (100 clicks/hr, 1,000 clicks/day per IP), velocity burst anomaly detection (<2s delta), click-to-conversion ratio skew detection (>10:1), IP blocklisting (HTTP 403), auto-blocking repeat offenders (150 clicks/hr), full admin fraud management dashboard (`/admin/fraud`), and immutable SQLite trigger audit logs (`fraud_reviews`).
- **NOWPayments Crypto Billing & Wallet Binding**: Authenticated checkout API (`/api/payments`) supporting tier upgrades (BASIC, PREMIUM, ENTERPRISE, MASTER), HMAC-SHA512 IPN webhook verification (`/api/webhooks/ipn`), idempotent tier activation ledger (`tier_activations`), and multi-chain wallet profile binding (`/api/profile/wallet` supporting Ethereum, Solana, Stellar) with native push notification registration (`/api/notifications/register`).

### Performance
- **KV Caching Deserialization Fixes**: Eliminated redundant `JSON.parse` operations on pre-parsed KV cache objects across analytics and affiliate routes.
- **Database Composite Indexes**: Added high-efficiency composite indexes on `deals(is_active, created_at DESC)`, `payments(user_id, created_at DESC)`, `deal_clicks(ip_address, created_at)`, and `conversions(status, converted_at)`.
- **Query Optimizations**: Refactored click velocity burst queries from `OR` clauses to indexed single-column lookups and `UNION ALL`, reducing query latency on high-volume click streams.

### Security
- **Cryptographic Replay Protection**: Nonce and trade ID replay protection using Cloudflare KV with standard `get`/`put` key-value operations and 24-hour expiration windows.
- **Strict HMAC Signatures**: Validated HMAC-SHA256 (Binance, Bybit, OKX, KuCoin) and HMAC-SHA512 (NOWPayments IPN) with canonical payload sorting and timing-safe equality comparisons.
- **Dual-Window IP Rate Limiting & Auto-Block**: RFC 6585-compliant 429 rate limit responses with `Retry-After` headers and auto-blocking for repeated offenders exceeding 150 clicks/hour.

## [1.0.1] - 2026-06-25

### Added
- **Analytics Integration** - Full analytics integration across the platform
- **OKX/KuCoin Webhook Support** - Webhook support for OKX and KuCoin exchanges
- **131 Test Fixes** - Comprehensive test suite improvements and fixes
- **Lint Cleanup** - Code quality improvements through linting cleanup

### Changed
- **Phase 0-1 Completion** - Marked Phase 0-1 as complete with all core features implemented

## [1.0.0] - 2026-06-22

### Added
- **Production Ready Release** - ApexOS is now production ready
- **OpenNext Routes Configuration** - Configured OpenNext routes for optimal performance
- **Staging Seed Data** - Added seed data for staging environment
- **Multisig Treasury Implementation** - Complete multisig wallet implementation
- **Gas Oracle Integration** - Gas price oracle for transaction fee estimation
- **Batch Builder** - Transaction batch builder for efficiency
- **VietAPI Optimization Scripts** - Optimization scripts for VietAPI integration

### Changed
- **Project Status** - Official production ready status with full deployment capability

---

## Version Format

- **Major versions (x.0.0)**: Breaking changes, new architectures, production readiness milestones
- **Minor versions (0.x.0)**: New features, significant improvements, phase completions
- **Patch versions (0.0.x)**: Bug fixes, documentation updates, test improvements

## Release Categories

- **Production Releases**: Marked with `chore(release)` commits, represent official releases
- **Feature Releases**: Marked with `feat:` commits, add new functionality
- **Maintenance Releases**: Marked with `chore:` commits, infrastructure and tooling updates
- **Documentation Releases**: Marked with `docs:` commits, documentation improvements
- **Bug Fix Releases**: Marked with `fix:` commits, bug fixes and stability improvements
