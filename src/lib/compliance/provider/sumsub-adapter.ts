/**
 * src/lib/compliance/provider/sumsub-adapter.ts
 *
 * ApexOS KYC & Regulatory Compliance Engine
 * Sumsub KYC Provider Adapter
 *
 * Implements HMAC-SHA256 signature verification via x-payload-digest
 * and normalizes applicant review lifecycle events.
 */

import {
  KycProviderAdapter,
  KycSessionResult,
  StandardizedKycWebhookEvent,
  computeHmacSha256Hex,
  timingSafeEqual,
} from './provider-interface';

export class SumsubAdapter implements KycProviderAdapter {
  readonly providerName = 'sumsub';

  /**
   * Generates a Sumsub verification session token & hosted SDK URL
   */
  async createSession(userId: string, _email?: string): Promise<KycSessionResult> {
    const sessionToken = `sb_tok_${userId}_${Date.now().toString(36)}`;
    const redirectUrl = `https://cockpit.sumsub.com/idensic/l/#/flow?accessToken=${encodeURIComponent(
      sessionToken
    )}`;

    return {
      sessionToken,
      redirectUrl,
      provider: 'sumsub',
    };
  }

  /**
   * Verifies the HMAC-SHA256 digest sent in the x-payload-digest header
   */
  async verifySignature(
    payload: string,
    headers: Headers,
    secret: string
  ): Promise<boolean> {
    if (!secret || secret.trim() === '') {
      return false;
    }

    const digestHeader =
      headers.get('x-payload-digest') ||
      headers.get('X-Payload-Digest') ||
      headers.get('x-payload-digest-alg');

    if (!digestHeader || digestHeader.trim() === '') {
      return false;
    }

    let cleanedDigest = digestHeader.trim().toLowerCase();
    if (cleanedDigest.startsWith('sha256=')) {
      cleanedDigest = cleanedDigest.slice(7);
    }
    if (cleanedDigest.startsWith('0x')) {
      cleanedDigest = cleanedDigest.slice(2);
    }

    try {
      const expectedDigest = await computeHmacSha256Hex(payload, secret);
      return timingSafeEqual(expectedDigest.toLowerCase(), cleanedDigest);
    } catch {
      return false;
    }
  }

  /**
   * Parses Sumsub applicant review payloads into standardized KYC events
   */
  async parseWebhook(
    payload: string,
    _headers: Headers
  ): Promise<StandardizedKycWebhookEvent> {
    const data =
      typeof payload === 'string'
        ? (JSON.parse(payload) as Record<string, any>)
        : (payload as Record<string, any>);

    const reviewResult = data.reviewResult || {};
    const reviewAnswer = (reviewResult.reviewAnswer || data.reviewAnswer || '').toUpperCase();

    let status: 'approved' | 'rejected' | 'requires_action' = 'requires_action';
    let tier: 'tier1_basic' | 'tier2_enhanced' = 'tier1_basic';

    if (reviewAnswer === 'GREEN') {
      status = 'approved';
      tier = 'tier2_enhanced';
    } else if (reviewAnswer === 'RED') {
      status = 'rejected';
      tier = 'tier1_basic';
    } else {
      status = 'requires_action';
      tier = 'tier1_basic';
    }

    const userId =
      data.externalUserId ||
      data.userId ||
      data.applicantId ||
      '';

    const verifiedAt =
      data.createdAt ||
      data.reviewResult?.reviewDate ||
      new Date().toISOString();

    return {
      userId,
      status,
      tier,
      provider: 'sumsub',
      verifiedAt,
      rawPayload: data,
    };
  }
}
