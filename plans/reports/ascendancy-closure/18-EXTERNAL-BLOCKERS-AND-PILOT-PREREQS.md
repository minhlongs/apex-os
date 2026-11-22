# 18 — External Dependencies, Commercial & Legal Blockers

No software remediation can substitute for external legal, partner, or infrastructure prerequisites. The following items remain `BLOCKED_EXTERNAL_DEPENDENCY` and are explicitly **NOT** simulated or bypassed:

1. **Production Signing & Custody Infrastructure:**
   - Turnkey production organization, HSM signing keys, and hardware policy rules.
   - Safe (Gnosis) multisig cold vaults on Arbitrum/Base and Stellar multisig cold account.
   - Live USDC treasury funding and gas/XLM reserves.
2. **Official Exchange Partner Onboarding:**
   - Executed commercial agreements and production API credentials for Bybit, OKX, and Bitget.
   - Genuine 30-day continuous live shadow reconciliation history (with R2 SHA-256 provenance and zero discrepancies) before KuCoin or Gate.io may ever be promoted.
3. **Legal, Compliance & Domain Setup:**
   - Corporate entity establishment and jurisdictional legal sign-off.
   - Production domain, DNS, and WebAuthn Relying Party ID (`RP_ID`).
   - Production sanctions feed automation.
4. **Remote Cloudflare & Release Approvals:**
   - Explicit Founder approval to merge PR #56 into `master`.
   - Controlled remote D1 backup and sequential migration execution (`031`–`036`).
   - Controlled staging soak and production `workflow_dispatch` deployment.
5. **B2B Commercial Pilot:**
   - Executed pilot partner agreement and Founder sign-off before enabling any customer-facing live settlement.
