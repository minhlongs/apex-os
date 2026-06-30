/**
 * Admin Guard Utility
 *
 * Verifies that the current user has admin role via Better Auth session.
 * Re-exports requireAdmin from the canonical location in actions.ts
 * so admin routes across the app have a single import path.
 */

export { requireAdmin } from '@/app/api/admin/actions';
