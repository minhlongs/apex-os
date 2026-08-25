---
name: week1-closure-gate
description: Run full closure gate for ApexOS handoff — build, lint, tests, deploy verification, migration check.
status: completed
acceptance_criteria:
  - pnpm build exits 0 with 0 TS errors
  - pnpm lint exits 0 (or only pre-existing findings, no new errors)
  - pnpm test exits 0 (1468 passing baseline)
  - pnpm deploy:full exits 0
  - /api/version shortSha matches local HEAD commit
  - All pending D1 migrations applied via scripts/apply-migrations.sh
  - No console.log / console.warn / console.error in production code paths
  - Zero :any types in production TS code
  - Report written to plans/reports/260801-1829-week1-closure-gate-report.md
---
