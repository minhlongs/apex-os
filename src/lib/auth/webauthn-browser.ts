/**
 * Zero-Dependency Native Browser WebAuthn Client Helper (`ES256` / FIDO2)
 *
 * Bridges `@simplewebauthn/server` v14 JSON wire formats
 * (`PublicKeyCredentialCreationOptionsJSON` -> `RegistrationResponseJSON` and
 * `PublicKeyCredentialRequestOptionsJSON` -> `AuthenticationResponseJSON`) directly
 * to native browser `navigator.credentials.create` and `navigator.credentials.get`
 * without pulling `@simplewebauthn/browser` into the client bundle.
 */

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

export interface AdminPasskeyEnrollmentResult {
  credentialId: string;
  code: string;
}

export interface AdminStepUpTokenResult {
  stepUpToken: string;
  expiresAt: string;
}

interface RegisterOptionsApiResponse {
  success: boolean;
  challengeId?: string;
  options?: PublicKeyCredentialCreationOptionsJSON;
  expiresAt?: string;
  code?: string;
  error?: string;
}

interface RegisterVerifyApiResponse {
  success: boolean;
  credentialId?: string;
  code?: string;
  error?: string;
}

interface StepUpOptionsApiResponse {
  success: boolean;
  challengeId?: string;
  options?: PublicKeyCredentialRequestOptionsJSON;
  expiresAt?: string;
  code?: string;
  error?: string;
}

interface StepUpVerifyApiResponse {
  success: boolean;
  stepUpToken?: string;
  expiresAt?: string;
  code?: string;
  error?: string;
}

type AuthenticatorAttachmentValue = NonNullable<
  RegistrationResponseJSON['authenticatorAttachment']
>;

type RegistrationTransports = NonNullable<
  RegistrationResponseJSON['response']['transports']
>;

const DEFAULT_PUBKEY_CRED_PARAMS: PublicKeyCredentialParameters[] = [
  { type: 'public-key', alg: -7 }, // ES256 (P-256)
  { type: 'public-key', alg: -257 }, // RS256 fallback
];

/**
 * Checks whether the current runtime exposes the browser WebAuthn Credentials API.
 */
export function isBrowserWebAuthnSupported(): boolean {
  return (
    typeof globalThis.navigator !== 'undefined' &&
    typeof globalThis.navigator.credentials !== 'undefined' &&
    typeof globalThis.navigator.credentials.create === 'function' &&
    typeof globalThis.navigator.credentials.get === 'function'
  );
}

/**
 * Decodes an RFC 4648 §5 Base64URL string into a `Uint8Array<ArrayBuffer>`
 * suitable for WebAuthn `BufferSource` fields.
 */
export function base64UrlToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  if (typeof base64Url !== 'string') {
    throw new TypeError('base64Url input must be a string');
  }

  const trimmed = base64Url.trim();
  if (trimmed.length === 0) {
    return new Uint8Array(new ArrayBuffer(0));
  }

  const standardBase64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (standardBase64.length % 4)) % 4;
  const padded = standardBase64 + '='.repeat(paddingLength);

  const binary = globalThis.atob(padded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encodes an `ArrayBuffer` or `ArrayBufferView` into an unpadded RFC 4648 §5 Base64URL string.
 */
export function arrayBufferToBase64Url(
  input: ArrayBuffer | ArrayBufferView
): string {
  const bytes =
    input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);

  if (bytes.byteLength === 0) {
    return '';
  }

  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    chunks.push(String.fromCharCode(...slice));
  }

  return globalThis
    .btoa(chunks.join(''))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function normalizeAuthenticatorAttachment(
  raw: unknown
): AuthenticatorAttachmentValue | undefined {
  if (raw === 'platform' || raw === 'cross-platform') {
    return raw;
  }
  return undefined;
}

/**
 * Converts `@simplewebauthn/server` `PublicKeyCredentialCreationOptionsJSON` into native
 * browser `PublicKeyCredentialCreationOptions`, preserving `ES256` (`alg: -7`),
 * `excludeCredentials`, `authenticatorSelection`, `attestation`, and extensions.
 */
export function toPublicKeyCreationOptions(
  options: PublicKeyCredentialCreationOptionsJSON
): PublicKeyCredentialCreationOptions {
  const pubKeyCredParams: PublicKeyCredentialParameters[] =
    options.pubKeyCredParams && options.pubKeyCredParams.length > 0
      ? options.pubKeyCredParams.map((param) => ({
          type: 'public-key',
          alg: param.alg,
        }))
      : DEFAULT_PUBKEY_CRED_PARAMS;

  const excludeCredentials: PublicKeyCredentialDescriptor[] | undefined =
    options.excludeCredentials?.map((cred) => ({
      id: base64UrlToUint8Array(cred.id),
      type: 'public-key',
      ...(cred.transports && cred.transports.length > 0
        ? { transports: cred.transports as AuthenticatorTransport[] }
        : {}),
    }));

  return {
    rp: {
      name: options.rp.name,
      ...(options.rp.id ? { id: options.rp.id } : {}),
    },
    user: {
      id: base64UrlToUint8Array(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName,
    },
    challenge: base64UrlToUint8Array(options.challenge),
    pubKeyCredParams,
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(excludeCredentials ? { excludeCredentials } : {}),
    ...(options.authenticatorSelection
      ? { authenticatorSelection: options.authenticatorSelection }
      : {}),
    ...(options.attestation ? { attestation: options.attestation } : {}),
    ...(options.extensions
      ? {
          extensions:
            options.extensions as unknown as AuthenticationExtensionsClientInputs,
        }
      : {}),
  };
}

/**
 * Converts `@simplewebauthn/server` `PublicKeyCredentialRequestOptionsJSON` into native
 * browser `PublicKeyCredentialRequestOptions`, preserving `allowCredentials`,
 * `userVerification`, `rpId`, and extensions.
 */
export function toPublicKeyRequestOptions(
  options: PublicKeyCredentialRequestOptionsJSON
): PublicKeyCredentialRequestOptions {
  const allowCredentials: PublicKeyCredentialDescriptor[] | undefined =
    options.allowCredentials?.map((cred) => ({
      id: base64UrlToUint8Array(cred.id),
      type: 'public-key',
      ...(cred.transports && cred.transports.length > 0
        ? { transports: cred.transports as AuthenticatorTransport[] }
        : {}),
    }));

  return {
    challenge: base64UrlToUint8Array(options.challenge),
    ...(options.rpId ? { rpId: options.rpId } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(allowCredentials ? { allowCredentials } : {}),
    ...(options.userVerification
      ? { userVerification: options.userVerification }
      : {}),
    ...(options.extensions
      ? {
          extensions:
            options.extensions as unknown as AuthenticationExtensionsClientInputs,
        }
      : {}),
  };
}

/**
 * Invokes `navigator.credentials.create` and serializes the resulting attestation
 * into `@simplewebauthn/server` v14 `RegistrationResponseJSON`.
 */
export async function createBrowserPasskeyCredential(
  options: PublicKeyCredentialCreationOptionsJSON
): Promise<RegistrationResponseJSON> {
  if (!isBrowserWebAuthnSupported()) {
    throw new Error(
      'WebAuthn Passkeys are not supported in this browser or non-HTTPS context.'
    );
  }

  const publicKey = toPublicKeyCreationOptions(options);
  const created = await globalThis.navigator.credentials.create({ publicKey });

  if (!created || created.type !== 'public-key') {
    throw new Error('Passkey enrollment cancelled or no credential returned.');
  }

  const pubKeyCred = created as PublicKeyCredential;
  const attResponse = pubKeyCred.response as AuthenticatorAttestationResponse & {
    getTransports?: () => string[];
    getAuthenticatorData?: () => ArrayBuffer;
    getPublicKey?: () => ArrayBuffer | null;
    getPublicKeyAlgorithm?: () => number;
  };

  const rawIdB64 = arrayBufferToBase64Url(pubKeyCred.rawId);
  const credentialId = pubKeyCred.id || rawIdB64;

  const transports =
    typeof attResponse.getTransports === 'function'
      ? (attResponse.getTransports() as RegistrationTransports)
      : undefined;

  const authenticatorData =
    typeof attResponse.getAuthenticatorData === 'function'
      ? arrayBufferToBase64Url(attResponse.getAuthenticatorData())
      : undefined;

  const publicKeyBytes =
    typeof attResponse.getPublicKey === 'function'
      ? attResponse.getPublicKey()
      : null;

  const publicKeyB64 = publicKeyBytes
    ? arrayBufferToBase64Url(publicKeyBytes)
    : undefined;

  const publicKeyAlgorithm =
    typeof attResponse.getPublicKeyAlgorithm === 'function'
      ? attResponse.getPublicKeyAlgorithm()
      : undefined;

  const authenticatorAttachment = normalizeAuthenticatorAttachment(
    (pubKeyCred as PublicKeyCredential & { authenticatorAttachment?: unknown })
      .authenticatorAttachment
  );

  const clientExtensionResults =
    typeof pubKeyCred.getClientExtensionResults === 'function'
      ? (pubKeyCred.getClientExtensionResults() as RegistrationResponseJSON['clientExtensionResults'])
      : {};

  return {
    id: credentialId,
    rawId: rawIdB64,
    type: 'public-key',
    ...(authenticatorAttachment ? { authenticatorAttachment } : {}),
    clientExtensionResults,
    response: {
      clientDataJSON: arrayBufferToBase64Url(attResponse.clientDataJSON),
      attestationObject: arrayBufferToBase64Url(attResponse.attestationObject),
      ...(authenticatorData ? { authenticatorData } : {}),
      ...(transports ? { transports } : {}),
      ...(publicKeyAlgorithm !== undefined ? { publicKeyAlgorithm } : {}),
      ...(publicKeyB64 ? { publicKey: publicKeyB64 } : {}),
    },
  };
}

/**
 * Invokes `navigator.credentials.get` and serializes the resulting assertion
 * into `@simplewebauthn/server` v14 `AuthenticationResponseJSON`.
 */
export async function getBrowserPasskeyAssertion(
  options: PublicKeyCredentialRequestOptionsJSON
): Promise<AuthenticationResponseJSON> {
  if (!isBrowserWebAuthnSupported()) {
    throw new Error(
      'WebAuthn Passkeys are not supported in this browser or non-HTTPS context.'
    );
  }

  const publicKey = toPublicKeyRequestOptions(options);
  const asserted = await globalThis.navigator.credentials.get({ publicKey });

  if (!asserted || asserted.type !== 'public-key') {
    throw new Error('Passkey verification cancelled or no assertion returned.');
  }

  const pubKeyCred = asserted as PublicKeyCredential;
  const assertionResp = pubKeyCred.response as AuthenticatorAssertionResponse;

  const rawIdB64 = arrayBufferToBase64Url(pubKeyCred.rawId);
  const credentialId = pubKeyCred.id || rawIdB64;

  const userHandle =
    assertionResp.userHandle && assertionResp.userHandle.byteLength > 0
      ? arrayBufferToBase64Url(assertionResp.userHandle)
      : undefined;

  const authenticatorAttachment = normalizeAuthenticatorAttachment(
    (pubKeyCred as PublicKeyCredential & { authenticatorAttachment?: unknown })
      .authenticatorAttachment
  );

  const clientExtensionResults =
    typeof pubKeyCred.getClientExtensionResults === 'function'
      ? (pubKeyCred.getClientExtensionResults() as AuthenticationResponseJSON['clientExtensionResults'])
      : {};

  return {
    id: credentialId,
    rawId: rawIdB64,
    type: 'public-key',
    ...(authenticatorAttachment ? { authenticatorAttachment } : {}),
    clientExtensionResults,
    response: {
      authenticatorData: arrayBufferToBase64Url(
        assertionResp.authenticatorData
      ),
      clientDataJSON: arrayBufferToBase64Url(assertionResp.clientDataJSON),
      signature: arrayBufferToBase64Url(assertionResp.signature),
      ...(userHandle ? { userHandle } : {}),
    },
  };
}

/**
 * High-level ceremony helper: requests a 5-minute single-use registration challenge,
 * runs browser `navigator.credentials.create` (`ES256`), and verifies enrollment.
 */
export async function enrollAdminPasskey(
  deviceName?: string
): Promise<AdminPasskeyEnrollmentResult> {
  const optionsRes = await fetch('/api/admin/passkey', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'register_options' }),
  });

  const optionsJson = (await optionsRes.json()) as RegisterOptionsApiResponse;
  if (
    !optionsRes.ok ||
    !optionsJson.success ||
    !optionsJson.challengeId ||
    !optionsJson.options
  ) {
    throw new Error(
      optionsJson.error || 'Failed to initiate Passkey enrollment challenge.'
    );
  }

  const registrationResponse = await createBrowserPasskeyCredential(
    optionsJson.options
  );

  const trimmedDeviceName = deviceName?.trim();
  const verifyRes = await fetch('/api/admin/passkey', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'register_verify',
      challengeId: optionsJson.challengeId,
      ...(trimmedDeviceName ? { deviceName: trimmedDeviceName } : {}),
      response: registrationResponse,
    }),
  });

  const verifyJson = (await verifyRes.json()) as RegisterVerifyApiResponse;
  if (!verifyRes.ok || !verifyJson.success || !verifyJson.credentialId) {
    throw new Error(
      verifyJson.error || 'Passkey attestation verification failed.'
    );
  }

  return {
    credentialId: verifyJson.credentialId,
    code: verifyJson.code ?? 'CREDENTIAL_REGISTERED',
  };
}

/**
 * High-level ceremony helper: requests a 5-minute single-use `admin_step_up` challenge,
 * runs browser `navigator.credentials.get`, and returns `{ stepUpToken, expiresAt }`.
 */
export async function obtainAdminStepUpToken(): Promise<AdminStepUpTokenResult> {
  const optionsRes = await fetch('/api/admin/passkey', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'step_up_options' }),
  });

  const optionsJson = (await optionsRes.json()) as StepUpOptionsApiResponse;
  if (
    !optionsRes.ok ||
    !optionsJson.success ||
    !optionsJson.challengeId ||
    !optionsJson.options
  ) {
    throw new Error(
      optionsJson.error || 'Failed to initiate Passkey step-up challenge.'
    );
  }

  const assertionResponse = await getBrowserPasskeyAssertion(
    optionsJson.options
  );

  const verifyRes = await fetch('/api/admin/passkey', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'step_up_verify',
      challengeId: optionsJson.challengeId,
      response: assertionResponse,
    }),
  });

  const verifyJson = (await verifyRes.json()) as StepUpVerifyApiResponse;
  if (
    !verifyRes.ok ||
    !verifyJson.success ||
    !verifyJson.stepUpToken ||
    !verifyJson.expiresAt
  ) {
    throw new Error(
      verifyJson.error || 'Passkey step-up assertion verification failed.'
    );
  }

  return {
    stepUpToken: verifyJson.stepUpToken,
    expiresAt: verifyJson.expiresAt,
  };
}
