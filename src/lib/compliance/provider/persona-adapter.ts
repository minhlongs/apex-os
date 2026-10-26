/**
 * src/lib/compliance/provider/persona-adapter.ts
 *
 * ApexOS KYC & Regulatory Compliance Engine
 * Persona KYC Provider Adapter
 *
 * Implements HMAC-SHA256 signature verification via persona-signature header (t=...,v1=...)
 * with timestamp freshness checks and inquiry lifecycle normalization.
 */

import {
  KycProviderAdapter,
  KycSessionResult,
  StandardizedKycWebhookEvent,
  computeHmacSha256Hex,
  timingSafeEqual,
} from './provider-interface';

export class PersonaAdapter implements KycProviderAdapter {
  readonly providerName = 'persona';

  /**
   * Generates a Persona verification inquiry session token & redirect URL
   */
  async createSession(userId: string, _email?: string): Promise<KycSessionResult> {
    const sessionToken = `inq_${userId}_${Date.now().toString(36)}`;
    const redirectUrl = `https://withpersona.com/verify?inquiry-template-id=itmpl_apex&reference-id=${encodeURIComponent(
      userId
    )}&session-token=${encodeURIComponent(sessionToken)}`;

    return {
      sessionToken,
      redirectUrl,
      provider: 'persona',
    };
  }

  /**
   * Verifies the Persona signature header formatted as:
   * t=<timestamp>,v1=<signature>
   * using HMAC-SHA256 of `${t}.${payload}` with the webhook secret.
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
      headers.get('persona-signature') ||
      headers.get('Persona-Signature') ||
      headers.get('x-persona-signature');

    if (!signatureHeader || signatureHeader.trim() === '') {
      return false;
    }

    // Parse t=... and v1=...
    const parts = signatureHeader.split(',');
    let timestamp: string | null = null;
    const signatures: string[] = [];

    for (const part of parts) {
      const trimmed = part.trim();
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();

      if (key === 't') {
        timestamp = val;
      } else if (key === 'v1' && val) {
        signatures.push(val);
      }
    }

    if (!timestamp || signatures.length === 0) {
      return false;
    }

    // Timestamp freshness verification (tolerance window: 5 minutes / 300 seconds)
    const tsNumber = parseInt(timestamp, 10);
    if (isNaN(tsNumber) || tsNumber <= 0) {
      return false;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const eventSeconds = tsNumber > 1e11 ? Math.floor(tsNumber / 1000) : tsNumber;
    const ageSeconds = Math.abs(nowSeconds - eventSeconds);

    if (ageSeconds > 300) {
      return false;
    }

    try {
      const dataToSign = `${timestamp}.${payload}`;
      const expectedSignature = await computeHmacSha256Hex(dataToSign, secret);

      return signatures.some((sig) => {
        let cleanedSig = sig.trim().toLowerCase();
        if (cleanedSig.startsWith('0x')) {
          cleanedSig = cleanedSig.slice(2);
        }
        return timingSafeEqual(expectedSignature.toLowerCase(), cleanedSig);
      });
    } catch {
      return false;
    }
  }

  /**
   * Normalizes Persona inquiry payloads into standardized KYC events
   */
  async parseWebhook(
    payload: string,
    _headers: Headers
  ): Promise<StandardizedKycWebhookEvent> {
    const data =
      typeof payload === 'string'
        ? (JSON.parse(payload) as Record<string, any>)
        : (payload as Record<string, any>);

    const eventName = (
      data.data?.attributes?.name ||
      data.event ||
      data.eventName ||
      ''
    ).toLowerCase();

    let status: 'approved' | 'rejected' | 'requires_action' = 'requires_action';
    let tier: 'tier1_basic' | 'tier2_enhanced' = 'tier1_basic';

    if (
      eventName === 'inquiry.approved' ||
      eventName === 'inquiry.completed' ||
      eventName === 'approved'
    ) {
      status = 'approved';
      tier = 'tier2_enhanced';
    } else if (
      eventName === 'inquiry.declined' ||
      eventName === 'inquiry.failed' ||
      eventName === 'declined' ||
      eventName === 'rejected'
    ) {
      status = 'rejected';
      tier = 'tier1_basic';
    } else {
      status = 'requires_action';
      tier = 'tier1_basic';
    }

    const userId =
      data.data?.attributes?.payload?.data?.attributes?.['reference-id'] ||
      data.data?.attributes?.payload?.data?.attributes?.reference_id ||
      data.data?.attributes?.['reference-id'] ||
      data.data?.attributes?.reference_id ||
      data.referenceId ||
      data.userId ||
      '';

    const verifiedAt =
      data.data?.attributes?.payload?.data?.attributes?.['completed-at'] ||
      data.data?.attributes?.['completed-at'] ||
      data.data?.attributes?.created_at ||
      new Date().toISOString();

    return {
      userId,
      status,
      tier,
      provider: 'persona',
      verifiedAt,
      rawPayload: data,
    };
  }
}
