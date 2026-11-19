/**
 * Runtime Environment Classification Helper
 *
 * Returns `true` when executing inside a deployed staging or production Worker
 * (`APP_ENV=staging`, `APP_ENV=production`, or `NODE_ENV=production` outside Jest),
 * so security controls (persistent D1 rate limiting, strict CSRF Origin checks,
 * fail-closed secret verification) enforce production-grade fail-closed posture.
 */

export function isProductionOrStagingRuntime(
  overrides?: { appEnv?: string; nodeEnv?: string }
): boolean {
  const globalRecord = globalThis as Record<string, unknown>;
  const rawAppEnv =
    overrides?.appEnv ??
    process.env.APP_ENV ??
    (typeof globalRecord.APP_ENV === 'string' ? globalRecord.APP_ENV : '');
  const appEnv = rawAppEnv.trim().toLowerCase();

  if (appEnv === 'production' || appEnv === 'staging') {
    return true;
  }
  if (appEnv === 'development' || appEnv === 'test' || appEnv === 'local') {
    return false;
  }

  const rawNodeEnv = overrides?.nodeEnv ?? process.env.NODE_ENV ?? '';
  const nodeEnv = rawNodeEnv.trim().toLowerCase();
  return nodeEnv === 'production';
}
