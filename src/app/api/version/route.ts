import { NextResponse } from 'next/server';
import manifestJson from '../../../../public/manifest.json';
import { assertAppStorePolicyCompliance } from '@/lib/compliance/app-store-policy';

export interface VersionResponse {
  sha: string;
  builtAt: string | null;
  environment: string;
}

/**
 * GET /api/version
 * Returns build metadata (commit SHA, build timestamp, environment) after asserting
 * read-only PWA App Store 3.1.5(v) manifest compliance. Strictly whitelists only these
 * three fields and never exposes D1 IDs, bindings, or secrets.
 */
export async function GET(): Promise<NextResponse<VersionResponse>> {
  assertAppStorePolicyCompliance({
    platform: 'pwa',
    mode: 'read_only_fee_analytics',
    custodialWalletEnabled: false,
    inAppTokenTransfersEnabled: false,
    multiTierCommissionPromoted: false,
    manifest: {
      name: manifestJson.name,
      description: manifestJson.description,
      lang: manifestJson.lang,
    },
  });

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
