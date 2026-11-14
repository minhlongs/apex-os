import type { D1Database } from '@/lib/auth/adapters/d1-adapter';

export const STRICT_WEBHOOK_REPLAY_WINDOW_MS = 300_000;

export type WebhookCanonicalFormat = 'standard' | 'bybit' | 'okx' | 'bitget';

export type StrictWebhookErrorCode =
  | 'MISSING_SOURCE_OR_EVENT_ID'
  | 'MISSING_SECRET'
  | 'MISSING_SIGNATURE'
  | 'INVALID_SIGNATURE_FORMAT'
  | 'INVALID_SIGNATURE'
  | 'MISSING_TIMESTAMP'
  | 'INVALID_TIMESTAMP'
  | 'TIMESTAMP_EXPIRED'
  | 'TIMESTAMP_FUTURE_SKEW'
  | 'REPLAY_CONCURRENT_INFLIGHT'
  | 'REPLAY_DUPLICATE_EVENT_ID'
  | 'INVALID_SEQUENCE'
  | 'OUT_OF_ORDER_SEQUENCE';

export interface StrictWebhookGuardInput {
  db: D1Database;
  source: string;
  eventId: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  rawBody: string;
  secret: string;
  nowMs?: number;
  signatureEncoding?: 'auto' | 'hex' | 'base64';
  canonicalFormat?: WebhookCanonicalFormat;
  method?: string;
  requestPath?: string;
  entityKey?: string;
  sequence?: number;
}

export type StrictWebhookGuardResult =
  | {
      verified: true;
      statusCode: 202;
      action: 'ENQUEUED_FOR_RECONCILIATION_ONLY';
      autoPayoutTriggered: false;
      source: string;
      eventId: string;
      payloadSha256: string;
      timestampMs: number;
      sequence: number | null;
    }
  | {
      verified: false;
      statusCode: 400 | 401 | 409;
      action: 'REJECTED';
      autoPayoutTriggered: false;
      errorCode: StrictWebhookErrorCode;
      errorMessage: string;
    };

const inFlightEventLocks = new Set<string>();
const entitySequenceQueues = new Map<string, Promise<void>>();
const schemaInitPromises = new WeakMap<object, Promise<void>>();

const STRICT_HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;
const STRICT_BASE64_32B_REGEX = /^[A-Za-z0-9+/]{43}=$/;
const STRICT_ISO_8601_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('Web Crypto SubtleCrypto is required for strict webhook verification');
  }
  return subtle;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await getSubtle().digest('SHA-256', toArrayBuffer(bytes));
  const out = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < out.length; i += 1) {
    hex += out[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function decodeHex32Bytes(hex: string): Uint8Array | null {
  if (!STRICT_HEX_64_REGEX.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 64; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function decodeBase6432Bytes(b64: string): Uint8Array | null {
  if (!STRICT_BASE64_32B_REGEX.test(b64)) {
    return null;
  }
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    if (buf.byteLength !== 32) {
      return null;
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  try {
    const bin = atob(b64);
    if (bin.length !== 32) {
      return null;
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

function parseSignatureCandidates(
  rawSignature: string,
  encoding: 'auto' | 'hex' | 'base64'
): Uint8Array[] | null {
  const trimmed = rawSignature.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.includes('v1,')) {
    if (encoding === 'hex') {
      return null;
    }
    const tokens = trimmed.split(/\s+/);
    const candidates: Uint8Array[] = [];
    for (const token of tokens) {
      if (token.startsWith('v1,')) {
        const decoded = decodeBase6432Bytes(token.slice(3));
        if (!decoded) {
          return null;
        }
        candidates.push(decoded);
      }
    }
    return candidates.length > 0 ? candidates : null;
  }

  const strippedPrefix = trimmed.replace(/^(?:sha256=|v1=)/i, '');

  if (encoding === 'hex') {
    const decoded = decodeHex32Bytes(strippedPrefix);
    return decoded ? [decoded] : null;
  }

  if (encoding === 'base64') {
    const decoded = decodeBase6432Bytes(strippedPrefix);
    return decoded ? [decoded] : null;
  }

  const hexDecoded = decodeHex32Bytes(strippedPrefix);
  if (hexDecoded) {
    return [hexDecoded];
  }
  const b64Decoded = decodeBase6432Bytes(strippedPrefix);
  if (b64Decoded) {
    return [b64Decoded];
  }
  return null;
}

export function buildCanonicalWebhookSigningPayload(params: {
  canonicalFormat: WebhookCanonicalFormat;
  timestamp: string;
  eventId: string;
  rawBody: string;
  method?: string;
  requestPath?: string;
}): string {
  const format = params.canonicalFormat;
  if (format === 'standard') {
    return `${params.timestamp}.${params.eventId}.${params.rawBody}`;
  }
  const method = (params.method ?? 'POST').toUpperCase();
  const path = params.requestPath ?? '/api/webhooks/exchange';
  return `${params.timestamp}${method}${path}${params.rawBody}`;
}

export async function computeStrictWebhookSignature(params: {
  secret: string;
  timestamp: string;
  eventId: string;
  rawBody: string;
  encoding?: 'hex' | 'base64' | 'svix';
  canonicalFormat?: WebhookCanonicalFormat;
  method?: string;
  requestPath?: string;
}): Promise<string> {
  const canonical = buildCanonicalWebhookSigningPayload({
    canonicalFormat: params.canonicalFormat ?? 'standard',
    timestamp: params.timestamp,
    eventId: params.eventId,
    rawBody: params.rawBody,
    method: params.method,
    requestPath: params.requestPath,
  });

  const encoder = new TextEncoder();
  const key = await getSubtle().importKey(
    'raw',
    toArrayBuffer(encoder.encode(params.secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBuffer = await getSubtle().sign(
    'HMAC',
    key,
    toArrayBuffer(encoder.encode(canonical))
  );
  const sigBytes = new Uint8Array(sigBuffer);
  const mode = params.encoding ?? 'hex';

  if (mode === 'hex') {
    let hex = '';
    for (let i = 0; i < sigBytes.length; i += 1) {
      hex += sigBytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  const b64 =
    typeof Buffer !== 'undefined'
      ? Buffer.from(sigBytes).toString('base64')
      : btoa(String.fromCharCode(...Array.from(sigBytes)));

  return mode === 'svix' ? `v1,${b64}` : b64;
}

function parseStrictTimestampMs(rawTimestamp: string): number | null {
  const trimmed = rawTimestamp.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }
    return numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  }

  if (STRICT_ISO_8601_REGEX.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
  }

  return null;
}

export async function ensureStrictWebhookSchema(db: D1Database): Promise<void> {
  const existingInit = schemaInitPromises.get(db);
  if (existingInit) {
    await existingInit;
    return;
  }

  const initTask = (async () => {
    const infoResult = await db
      .prepare("PRAGMA table_info('webhook_nonces')")
      .bind()
      .all<{ name: string }>();

    const columns = (infoResult.results ?? []).map((col) => col.name);

    if (columns.length === 0) {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS webhook_nonces (
            source TEXT NOT NULL,
            event_id TEXT NOT NULL,
            signature_hash TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            webhook_timestamp INTEGER NOT NULL,
            entity_key TEXT,
            sequence_num INTEGER,
            received_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (source, event_id),
            UNIQUE (source, signature_hash)
          )`
        )
        .bind()
        .run();
    } else if (!columns.includes('source') || !columns.includes('event_id')) {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS webhook_nonces_g4 (
            source TEXT NOT NULL,
            event_id TEXT NOT NULL,
            signature_hash TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            webhook_timestamp INTEGER NOT NULL,
            entity_key TEXT,
            sequence_num INTEGER,
            received_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (source, event_id),
            UNIQUE (source, signature_hash)
          )`
        )
        .bind()
        .run();

      await db
        .prepare(
          `INSERT OR IGNORE INTO webhook_nonces_g4 (
            source, event_id, signature_hash, payload_hash, webhook_timestamp, received_at
          )
          SELECT exchange, signature_hash, signature_hash, payload_hash, webhook_timestamp, COALESCE(received_at, datetime('now'))
          FROM webhook_nonces`
        )
        .bind()
        .run();

      await db.prepare('DROP TABLE webhook_nonces').bind().run();
      await db.prepare('ALTER TABLE webhook_nonces_g4 RENAME TO webhook_nonces').bind().run();
    }

    await db
      .prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_nonces_source_sig
         ON webhook_nonces(source, signature_hash)`
      )
      .bind()
      .run();

    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS webhook_sequence_watermarks (
          source TEXT NOT NULL,
          entity_key TEXT NOT NULL,
          last_sequence INTEGER NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (source, entity_key)
        )`
      )
      .bind()
      .run();
  })();

  schemaInitPromises.set(db, initTask);
  try {
    await initTask;
  } catch (err) {
    schemaInitPromises.delete(db);
    throw err;
  }
}

function rejectWebhook(
  statusCode: 400 | 401 | 409,
  errorCode: StrictWebhookErrorCode,
  errorMessage: string
): StrictWebhookGuardResult {
  return {
    verified: false,
    statusCode,
    action: 'REJECTED',
    autoPayoutTriggered: false,
    errorCode,
    errorMessage,
  };
}

async function runSerializedForEntity<T>(entityLockKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = entitySequenceQueues.get(entityLockKey) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const currentGate = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const chained = previous.then(() => currentGate);
  entitySequenceQueues.set(entityLockKey, chained);

  await previous;
  try {
    return await fn();
  } finally {
    releaseCurrent();
    if (entitySequenceQueues.get(entityLockKey) === chained) {
      entitySequenceQueues.delete(entityLockKey);
    }
  }
}

export async function verifyAndGuardWebhook(
  input: StrictWebhookGuardInput
): Promise<StrictWebhookGuardResult> {
  const source = (input.source ?? '').trim().toLowerCase();
  const eventId = (input.eventId ?? '').trim();
  if (!source || !eventId) {
    return rejectWebhook(
      400,
      'MISSING_SOURCE_OR_EVENT_ID',
      'Webhook source and event_id are required'
    );
  }

  if (!input.secret || input.secret.trim().length === 0) {
    return rejectWebhook(401, 'MISSING_SECRET', 'Webhook signing secret is not configured');
  }

  if (input.timestamp === null || input.timestamp === undefined || input.timestamp.trim() === '') {
    return rejectWebhook(400, 'MISSING_TIMESTAMP', 'Webhook timestamp header is missing');
  }

  const rawTimestamp = input.timestamp.trim();
  const timestampMs = parseStrictTimestampMs(rawTimestamp);
  if (timestampMs === null) {
    return rejectWebhook(400, 'INVALID_TIMESTAMP', 'Webhook timestamp is malformed or NaN');
  }

  const nowMs = input.nowMs ?? Date.now();
  const pastAgeMs = nowMs - timestampMs;
  if (pastAgeMs > STRICT_WEBHOOK_REPLAY_WINDOW_MS) {
    return rejectWebhook(
      401,
      'TIMESTAMP_EXPIRED',
      `Webhook timestamp expired (${Math.round(pastAgeMs / 1000)}s > 300s window)`
    );
  }

  const futureSkewMs = timestampMs - nowMs;
  if (futureSkewMs > STRICT_WEBHOOK_REPLAY_WINDOW_MS) {
    return rejectWebhook(
      401,
      'TIMESTAMP_FUTURE_SKEW',
      `Webhook timestamp exceeds allowed future clock skew (${Math.round(futureSkewMs / 1000)}s > 300s window)`
    );
  }

  if (input.signature === null || input.signature === undefined || input.signature.trim() === '') {
    return rejectWebhook(401, 'MISSING_SIGNATURE', 'Webhook HMAC signature header is missing');
  }

  const signatureCandidates = parseSignatureCandidates(
    input.signature,
    input.signatureEncoding ?? 'auto'
  );
  if (!signatureCandidates) {
    return rejectWebhook(
      401,
      'INVALID_SIGNATURE_FORMAT',
      'Webhook signature is not a valid 32-byte hex or base64 HMAC-SHA256 digest'
    );
  }

  if (input.sequence !== undefined) {
    if (
      !Number.isSafeInteger(input.sequence) ||
      input.sequence < 0 ||
      !input.entityKey ||
      !input.entityKey.trim()
    ) {
      return rejectWebhook(
        400,
        'INVALID_SEQUENCE',
        'Sequence watermark requires a non-negative integer sequence and non-empty entityKey'
      );
    }
  }

  const canonicalPayload = buildCanonicalWebhookSigningPayload({
    canonicalFormat: input.canonicalFormat ?? 'standard',
    timestamp: rawTimestamp,
    eventId,
    rawBody: input.rawBody,
    method: input.method,
    requestPath: input.requestPath,
  });

  const encoder = new TextEncoder();
  const hmacKey = await getSubtle().importKey(
    'raw',
    toArrayBuffer(encoder.encode(input.secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const canonicalBuffer = toArrayBuffer(encoder.encode(canonicalPayload));
  let signatureValid = false;
  for (const candidate of signatureCandidates) {
    const valid = await getSubtle().verify(
      'HMAC',
      hmacKey,
      toArrayBuffer(candidate),
      canonicalBuffer
    );
    if (valid) {
      signatureValid = true;
      break;
    }
  }

  if (!signatureValid) {
    return rejectWebhook(401, 'INVALID_SIGNATURE', 'Webhook HMAC-SHA256 verification failed');
  }

  const signatureLockFragment = input.signature.trim();
  const inflightEventKey = `${source}::event::${eventId}`;
  const inflightSigKey = `${source}::sig::${signatureLockFragment}`;
  if (inFlightEventLocks.has(inflightEventKey) || inFlightEventLocks.has(inflightSigKey)) {
    return rejectWebhook(
      409,
      'REPLAY_CONCURRENT_INFLIGHT',
      `Concurrent duplicate webhook arrival rejected for (${source}, ${eventId})`
    );
  }

  inFlightEventLocks.add(inflightEventKey);
  inFlightEventLocks.add(inflightSigKey);
  try {
    await ensureStrictWebhookSchema(input.db);

    const [signatureHash, payloadSha256] = await Promise.all([
      sha256Hex(signatureLockFragment),
      sha256Hex(input.rawBody),
    ]);

    const entityKey = input.entityKey ? input.entityKey.trim() : null;
    const sequenceNum = input.sequence ?? null;

    const nonceInsert = await input.db
      .prepare(
        `INSERT OR IGNORE INTO webhook_nonces (
          source, event_id, signature_hash, payload_hash, webhook_timestamp, entity_key, sequence_num
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(source, eventId, signatureHash, payloadSha256, timestampMs, entityKey, sequenceNum)
      .run();

    if (nonceInsert.meta.changes !== 1) {
      return rejectWebhook(
        409,
        'REPLAY_DUPLICATE_EVENT_ID',
        `Duplicate webhook event_id or signature rejected for (${source}, ${eventId})`
      );
    }

    if (sequenceNum !== null && entityKey !== null) {
      const entityLockKey = `${source}::${entityKey}`;
      const watermarkAccepted = await runSerializedForEntity(entityLockKey, async () => {
        const watermarkRes = await input.db
          .prepare(
            `INSERT INTO webhook_sequence_watermarks (source, entity_key, last_sequence, updated_at)
             VALUES (?, ?, ?, datetime('now'))
             ON CONFLICT(source, entity_key) DO UPDATE SET
               last_sequence = excluded.last_sequence,
               updated_at = excluded.updated_at
             WHERE excluded.last_sequence > webhook_sequence_watermarks.last_sequence`
          )
          .bind(source, entityKey, sequenceNum)
          .run();
        return watermarkRes.meta.changes === 1;
      });

      if (!watermarkAccepted) {
        return rejectWebhook(
          409,
          'OUT_OF_ORDER_SEQUENCE',
          `Out-of-order stale webhook sequence (${sequenceNum}) rejected for (${source}, ${entityKey})`
        );
      }
    }

    return {
      verified: true,
      statusCode: 202,
      action: 'ENQUEUED_FOR_RECONCILIATION_ONLY',
      autoPayoutTriggered: false,
      source,
      eventId,
      payloadSha256,
      timestampMs,
      sequence: sequenceNum,
    };
  } finally {
    inFlightEventLocks.delete(inflightEventKey);
    inFlightEventLocks.delete(inflightSigKey);
  }
}
