import { NextResponse } from 'next/server';

export interface VersionResponse {
  sha: string;
  builtAt: string | null;
  environment: string;
}

/**
 * GET /api/version
 * Returns build metadata (commit SHA, build timestamp, environment).
 * Strictly whitelists only these three fields and never exposes D1 IDs, bindings, or secrets.
 */
export async function GET(): Promise<NextResponse<VersionResponse>> {
  const sha = process.env.NEXT_PUBLIC_COMMIT_SHA || 'unknown';
  const builtAt = process.env.NEXT_PUBLIC_BUILD_TIME || null;
  const environment =
    process.env.APP_ENV || process.env.NODE_ENV || 'development';

  return NextResponse.json(
    {
      sha,
      builtAt,
      environment,
    },
    { status: 200 }
  );
}
