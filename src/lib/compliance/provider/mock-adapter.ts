/**
 * src/lib/compliance/provider/mock-adapter.ts
 *
 * ApexOS KYC & Regulatory Compliance Engine
 * Mock KYC Provider Adapter
 *
 * Deterministic test adapter supporting approved, rejected, and requires_action events
 * with Web Crypto HMAC verification for unit, integration, and E2E testing.
 */

import {
  KycProviderAdapter,
  KycSessionResult,
  StandardizedKycWebhookEvent,
  computeHmacSha256Hex,
  timingSafeEqual,
} from './provider-interface';

export class MockKycAdapter implements KycProviderAdapter {
  readonly providerName = 'mock';

  /**
   * Generates a deterministic mock KYC verification session
   */
  async createSession(userId: string, _email?: string): Promise<KycSessionResult> {
    const sessionToken = `mock_tok_${userId}_${Date.now()}`;
    const redirectUrl = `https://verify.mock-kyc.com/session?token=${encodeURIComponent(
      sessionToken
    )}&userId=${encodeURIComponent(userId)}`;

    return {
      sessionToken,
      redirectUrl,
      provider: 'mock',
    };
  }

  /**
   * Verifies HMAC signature for mock webhooks.
   * Checks x-kyc-signature, x-mock-signature, or x-payload-digest headers.
   */
  async verifySignature(
    payload: string,
    headers: Headers,
    secret: string
  ): Promise<boolean> {
    if (!secret || secret.trim() === '') {
      return false;
    }

    const signatureHeader =
      headers.get('x-kyc-signature') ||
      headers.get('x-mock-signature') ||
      headers.get('x-payload-digest') ||
      headers.get('x-signature');

    if (!signatureHeader || signatureHeader.trim() === '') {
      return false;
    }

    const cleanedSig = signatureHeader.trim().toLowerCase();

    // Deterministic bypass for explicit mock test harness tokens
    if (cleanedSig === 'mock_valid_signature' || cleanedSig === 'valid_mock_signature') {
      return true;
    }

    try {
      const expected = await computeHmacSha256Hex(payload, secret);
      let target = cleanedSig;
      if (target.startsWith('sha256=')) {
        target = target.slice(7);
      }
      if (target.startsWith('0x')) {
        target = target.slice(2);
      }
      return timingSafeEqual(expected.toLowerCase(), target);
    } catch {
      return false;
    }
  }

  /**
   * Parses test/mock webhook payloads into StandardizedKycWebhookEvent
   */
  async parseWebhook(
    payload: string,
    _headers: Headers
  ): Promise<StandardizedKycWebhookEvent> {
    const data =
      typeof payload === 'string'
        ? (JSON.parse(payload) as Record<string, any>)
        : (payload as Record<string, any>);

    const rawStatus = (
      data.status ||
      data.event ||
      (data.reviewResult?.reviewAnswer === 'GREEN' ? 'approved' : '') ||
      (data.reviewResult?.reviewAnswer === 'RED' ? 'rejected' : '') ||
      'requires_action'
    ).toLowerCase();

    let status: 'approved' | 'rejected' | 'requires_action' = 'requires_action';
    let tier: 'tier1_basic' | 'tier2_enhanced' = 'tier1_basic';

    if (rawStatus === 'approved' || rawStatus === 'completed' || rawStatus === 'green') {
      status = 'approved';
      tier = 'tier2_enhanced';
    } else if (rawStatus === 'rejected' || rawStatus === 'declined' || rawStatus === 'red') {
      status = 'rejected';
      tier = 'tier1_basic';
    } else {
      status = 'requires_action';
      tier = 'tier1_basic';
    }

    // Support explicit tier overrides in test payloads
    if (data.tier === 'tier2_enhanced' || data.tier === 'tier2') {
      tier = 'tier2_enhanced';
    } else if (data.tier === 'tier1_basic' || data.tier === 'tier1') {
      tier = 'tier1_basic';
    }

    const userId =
      data.userId ||
      data.externalUserId ||
      data.applicantId ||
      data.referenceId ||
      '';

    const verifiedAt = data.verifiedAt || data.createdAt || new Date().toISOString();

    return {
      userId,
      status,
      tier,
      provider: 'mock',
      verifiedAt,
      rawPayload: data,
    };
  }
}
