# Phase 04: UX Polish — Error Boundaries

## Context
Next.js 16 requires error.tsx/loading.tsx/not-found.tsx for proper error handling. Currently missing across all route segments.

## Files to Create
- `src/app/[locale]/error.tsx` — global error boundary
- `src/app/[locale]/not-found.tsx` — 404 page
- `src/app/[locale]/admin/error.tsx` — admin-specific error
- `src/app/[locale]/affiliate/error.tsx` — affiliate-specific error
- `src/app/[locale]/loading.tsx` — global loading skeleton

## Files to Modify
- `src/app/[locale]/layout.tsx` — ensure error boundaries wrap content
- `src/app/error.tsx` — root error boundary (if exists)

## Steps
1. Create global error.tsx with i18n support (vi/en)
2. Create not-found.tsx with navigation back to home
3. Create loading.tsx with skeleton UI matching app theme
4. Create segment-level error.tsx for admin and affiliate routes
5. Verify all route segments have proper error handling
6. Run build: `pnpm build` — ensure no errors

## Acceptance
- Every route segment has error.tsx or inherits from parent
- not-found.tsx renders for invalid routes
- loading.tsx shows during async navigation
- Build passes with no errors
- Visual QA: error pages match app design system
