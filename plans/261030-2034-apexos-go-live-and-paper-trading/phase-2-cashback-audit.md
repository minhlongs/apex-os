# Phase 2: Cashback Core Audit & Payout Rails Hardening (Block B)

## Context
ApexOS V1 launch requires strict cashback safety:
- Payout execution must be restricted to Stellar USDC; non-Stellar chains (Ethereum, Solana) must fail closed at the router execution level.
- Crawler fallback must not silently masquerade as live rate cards.
- $500 KYC threshold must be checked before approving or settling payouts.
- `AUTO_SETTLE_PAYOUTS` must default to false.

## Tasks
1. In `src/lib/payouts/router.ts`:
   - Add a launch gate check in `sendPayout`: if chain is not `stellar`, fail closed with error `Payouts for chain '${chain}' are disabled in V1 launch. Only 'stellar' is enabled.`
2. In `src/lib/crawler/service.ts`:
   - When using fallback rate cards, mark them with `data_source: 'fallback_fixture'` and `is_synthetic: true`.
3. In `src/lib/payouts/batch-settlement-service.ts` or settlement checks:
   - Ensure KYC check is enforced for any payout >= 500 USD (reject or require review if KYC tier is 'none').
4. Verify environment variable defaults for `AUTO_SETTLE_PAYOUTS` across wrangler configs are "false".

## Verification
- Unit test verifying non-Stellar chains throw or return failed execution in `sendPayout`.
- Unit test verifying crawler fallback includes synthetic provenance.
