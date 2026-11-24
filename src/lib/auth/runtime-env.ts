/**
 * Runtime Environment Classification Helper
 *
 * Returns `true` when executing inside a deployed staging or production Worker
 * (`APP_ENV=staging`, `APP_ENV=production`, or `NODE_ENV=production` outside Jest),
 * so security controls (persistent D1 rate limiting, strict CSRF Origin checks,
 * fail-closed secret verification) enforce production-grade fail-closed posture.
 */

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return '';
}

export function isProductionOrStagingRuntime(
  overrides?: { appEnv?: string; nodeEnv?: string }
): boolean {
  const globalRecord = globalThis as Record<string, unknown>;
  const appEnv = firstNonEmptyString(
    overrides?.appEnv,
    process.env.APP_ENV,
    process.env.APEX_ENVIRONMENT,
    globalRecord.APP_ENV,
    globalRecord.APEX_ENVIRONMENT
  ).toLowerCase();

  if (appEnv === 'production' || appEnv === 'staging') {
    return true;
  }
  if (appEnv === 'development' || appEnv === 'test' || appEnv === 'local') {
    return false;
  }

  const nodeEnv = firstNonEmptyString(overrides?.nodeEnv, process.env.NODE_ENV).toLowerCase();
  return nodeEnv === 'production';
}
