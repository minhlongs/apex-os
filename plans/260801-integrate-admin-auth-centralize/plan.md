---
name: centralize-admin-auth
description: Extract duplicated requireAdmin() into a shared admin-auth utility and update all admin action files to use it.
status: completed
acceptance_criteria:
  - New src/lib/admin-auth.ts exports a single requireAdmin() with identical behavior
  - All consumer files import from the new module instead of local copies
  - No behavioral changes — same error returns, same session check logic
completion_notes:
  - Committed as c5d63ff on 2026-08-01
  - 7 admin modules migrated to shared utility
  - Backup files and tsconfig cache cleaned up
---
