/**
 * R2 Cryptographic Evidence Vault (5-Year Immutable SHA-256 Audit Anchor)
 *
 * Hashes raw partner REST JSON, CSV statement, or wallet credit statement bytes
 * via WebCrypto `SHA-256`, writes raw bytes to an `R2BucketLike` object store
 * with `+1826 days` (5-year) retention metadata, and anchors the digest in D1
 * `r2_evidence_objects`.
 */

import type { D1Database } from '@/lib/auth/adapters/d1-adapter';

export const ALLOWED_EVIDENCE_EXCHANGES = [
  'bybit',
  'okx',
  'bitget',
  'kucoin',
  'gateio',
] as const;

export type SupportedPartnerExchange = (typeof ALLOWED_EVIDENCE_EXCHANGES)[number];

export const ALLOWED_EVIDENCE_SOURCE_KINDS = [
  'rest_poll',
  'csv_statement',
  'wallet_statement',
] as const;

export type EvidenceSourceKind = (typeof ALLOWED_EVIDENCE_SOURCE_KINDS)[number];

/** 5-year statutory retention horizon (`1826` days in milliseconds). */
export const EVIDENCE_RETENTION_DAYS = 1826 as const;
const EVIDENCE_RETENTION_MS = EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export interface R2HttpMetadataLike {
  contentType?: string;
}

export interface R2PutOptionsLike {
  httpMetadata?: R2HttpMetadataLike;
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBodyLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly size?: number;
  readonly httpMetadata?: R2HttpMetadataLike;
  readonly customMetadata?: Record<string, string>;
}

export interface R2BucketLike {
  put(
    key: string,
    value: Uint8Array | ArrayBuffer | string,
    options?: R2PutOptionsLike
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
}

export interface EvidenceRecord {
  id: string;
  exchange: SupportedPartnerExchange;
  sourceKind: EvidenceSourceKind;
  r2ObjectKey: string;
  payloadSha256: string;
  byteLength: number;
  statementPeriodStart: string;
  statementPeriodEnd: string;
  retentionUntil: string;
  createdAt: string;
}

export interface StoreEvidenceInput {
  id?: string;
  exchange: SupportedPartnerExchange;
  sourceKind: EvidenceSourceKind;
  rawBytes: Uint8Array | ArrayBuffer | string;
  contentType?: string;
  r2ObjectKey?: string;
  statementPeriodStart: string;
  statementPeriodEnd: string;
  createdAt?: string;
}

export interface EvidenceIntegrityResult {
  valid: boolean;
  evidenceId: string;
  r2ObjectKey: string | null;
  expectedSha256: string | null;
  actualSha256: string | null;
  expectedByteLength: number | null;
  actualByteLength: number | null;
  reason?:
    | 'EVIDENCE_NOT_FOUND'
    | 'R2_OBJECT_MISSING'
    | 'BYTE_LENGTH_MISMATCH'
    | 'SHA256_MISMATCH';
  record?: EvidenceRecord;
}

export class EvidenceVaultValidationError extends Error {
  public readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceVaultValidationError';
  }
}

export class EvidenceIntegrityError extends Error {
  public readonly statusCode = 422;
  public readonly verification: EvidenceIntegrityResult;
  constructor(message: string, verification: EvidenceIntegrityResult) {
    super(message);
    this.name = 'EvidenceIntegrityError';
    this.verification = verification;
  }
}

interface StoredMemoryObject {
  bytes: Uint8Array;
  httpMetadata?: R2HttpMetadataLike;
  customMetadata?: Record<string, string>;
}

/**
 * Deterministic in-memory R2 bucket implementation for sandbox verification.
 */
export class InMemoryR2Bucket implements R2BucketLike {
  private readonly objects = new Map<string, StoredMemoryObject>();

  async put(
    key: string,
    value: Uint8Array | ArrayBuffer | string,
    options?: R2PutOptionsLike
  ): Promise<void> {
    const normalized = normalizeToUint8Array(value);
    const copy = new Uint8Array(normalized.byteLength);
    copy.set(normalized);
    this.objects.set(key, {
      bytes: copy,
      httpMetadata: options?.httpMetadata ? { ...options.httpMetadata } : undefined,
      customMetadata: options?.customMetadata ? { ...options.customMetadata } : undefined,
    });
  }

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const entry = this.objects.get(key);
    if (!entry) {
      return null;
    }
    const snapshot = new Uint8Array(entry.bytes.byteLength);
    snapshot.set(entry.bytes);
    return {
      size: snapshot.byteLength,
      httpMetadata: entry.httpMetadata ? { ...entry.httpMetadata } : undefined,
      customMetadata: entry.customMetadata ? { ...entry.customMetadata } : undefined,
      async arrayBuffer(): Promise<ArrayBuffer> {
        return snapshot.buffer.slice(
          snapshot.byteOffset,
          snapshot.byteOffset + snapshot.byteLength
        );
      },
    };
  }

  /** Helper for sandbox tamper-detection tests to corrupt stored bytes directly. */
  tamperStoredBytes(key: string, mutatedBytes: Uint8Array | string): void {
    const existing = this.objects.get(key);
    const normalized = normalizeToUint8Array(mutatedBytes);
    const copy = new Uint8Array(normalized.byteLength);
    copy.set(normalized);
    this.objects.set(key, {
      bytes: copy,
      httpMetadata: existing?.httpMetadata,
      customMetadata: existing?.customMetadata,
    });
  }

  /** Helper for sandbox tests to simulate missing object deletion. */
  deleteStoredObject(key: string): boolean {
    return this.objects.delete(key);
  }

  size(): number {
    return this.objects.size;
  }
}

export function normalizeToUint8Array(
  input: Uint8Array | ArrayBuffer | string
): Uint8Array<ArrayBuffer> {
  if (typeof input === 'string') {
    const encoded = new TextEncoder().encode(input);
    const copy = new Uint8Array(encoded.byteLength);
    copy.set(encoded);
    return copy;
  }
  if (input instanceof Uint8Array || ArrayBuffer.isView(input)) {
    const view = input as ArrayBufferView;
    const src = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const copy = new Uint8Array(src.byteLength);
    copy.set(src);
    return copy;
  }
  if (
    input instanceof ArrayBuffer ||
    Object.prototype.toString.call(input) === '[object ArrayBuffer]'
  ) {
    const buf = input as ArrayBuffer;
    const src = new Uint8Array(buf);
    const copy = new Uint8Array(src.byteLength);
    copy.set(src);
    return copy;
  }
  throw new EvidenceVaultValidationError('Unsupported evidence payload byte buffer');
}

/**
 * Compute canonical lowercase 64-char SHA-256 hex digest using WebCrypto `crypto.subtle`.
 */
export async function computeSha256Hex(
  input: Uint8Array | ArrayBuffer | string
): Promise<string> {
  const bytes = normalizeToUint8Array(input);
  if (!globalThis.crypto?.subtle) {
    throw new Error('WebCrypto subtle digest API is unavailable in runtime');
  }
  const digestBuffer = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const digestBytes = new Uint8Array(digestBuffer);
  let hex = '';
  for (let i = 0; i < digestBytes.length; i++) {
    hex += digestBytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function isSupportedPartnerExchange(
  value: string
): value is SupportedPartnerExchange {
  return (ALLOWED_EVIDENCE_EXCHANGES as readonly string[]).includes(value);
}

export function isEvidenceSourceKind(value: string): value is EvidenceSourceKind {
  return (ALLOWED_EVIDENCE_SOURCE_KINDS as readonly string[]).includes(value);
}

function computeRetentionUntilIso(createdAtIso: string): string {
  const createdMs = Date.parse(createdAtIso);
  if (Number.isNaN(createdMs)) {
    throw new EvidenceVaultValidationError(`Invalid ISO timestamp: "${createdAtIso}"`);
  }
  return new Date(createdMs + EVIDENCE_RETENTION_MS).toISOString();
}

interface RawEvidenceRow {
  id: string;
  exchange: SupportedPartnerExchange;
  source_kind: EvidenceSourceKind;
  r2_object_key: string;
  payload_sha256: string;
  byte_length: number;
  statement_period_start: string;
  statement_period_end: string;
  retention_until: string;
  created_at: string;
}

function mapEvidenceRow(row: RawEvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    exchange: row.exchange,
    sourceKind: row.source_kind,
    r2ObjectKey: row.r2_object_key,
    payloadSha256: row.payload_sha256,
    byteLength: Number(row.byte_length),
    statementPeriodStart: row.statement_period_start,
    statementPeriodEnd: row.statement_period_end,
    retentionUntil: row.retention_until,
    createdAt: row.created_at,
  };
}

/**
 * Store raw partner statement or wallet credit statement bytes into R2 and
 * anchor its SHA-256 digest + 5-year (`+1826 days`) retention metadata in D1.
 */
export async function storeEvidenceObject(
  db: D1Database,
  r2: R2BucketLike,
  input: StoreEvidenceInput
): Promise<EvidenceRecord> {
  if (!isSupportedPartnerExchange(input.exchange)) {
    throw new EvidenceVaultValidationError(
      `Unsupported partner exchange: "${String(input.exchange)}"`
    );
  }
  if (!isEvidenceSourceKind(input.sourceKind)) {
    throw new EvidenceVaultValidationError(
      `Unsupported evidence sourceKind: "${String(input.sourceKind)}"`
    );
  }
  if (
    typeof input.statementPeriodStart !== 'string' ||
    Number.isNaN(Date.parse(input.statementPeriodStart))
  ) {
    throw new EvidenceVaultValidationError(
      `Invalid statementPeriodStart: "${String(input.statementPeriodStart)}"`
    );
  }
  if (
    typeof input.statementPeriodEnd !== 'string' ||
    Number.isNaN(Date.parse(input.statementPeriodEnd))
  ) {
    throw new EvidenceVaultValidationError(
      `Invalid statementPeriodEnd: "${String(input.statementPeriodEnd)}"`
    );
  }
  if (Date.parse(input.statementPeriodEnd) < Date.parse(input.statementPeriodStart)) {
    throw new EvidenceVaultValidationError(
      'statementPeriodEnd must be greater than or equal to statementPeriodStart'
    );
  }

  const rawBytes = normalizeToUint8Array(input.rawBytes);
  if (rawBytes.byteLength === 0) {
    throw new EvidenceVaultValidationError('Evidence rawBytes cannot be empty');
  }

  const evidenceId = input.id?.trim() || `ev_${globalThis.crypto.randomUUID()}`;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const retentionUntil = computeRetentionUntilIso(createdAt);
  const payloadSha256 = await computeSha256Hex(rawBytes);
  const datePrefix = createdAt.slice(0, 10);
  const r2ObjectKey =
    input.r2ObjectKey?.trim() ||
    `evidence/${input.exchange}/${input.sourceKind}/${datePrefix}/${evidenceId}-${payloadSha256.slice(0, 16)}.bin`;

  const contentType =
    input.contentType ??
    (input.sourceKind === 'csv_statement' ? 'text/csv' : 'application/json');

  await r2.put(r2ObjectKey, rawBytes, {
    httpMetadata: { contentType },
    customMetadata: {
      evidenceId,
      exchange: input.exchange,
      sourceKind: input.sourceKind,
      payloadSha256,
      retentionUntil,
      statementPeriodStart: input.statementPeriodStart,
      statementPeriodEnd: input.statementPeriodEnd,
    },
  });

  await db
    .prepare(
      `INSERT INTO r2_evidence_objects (
        id, exchange, source_kind, r2_object_key, payload_sha256,
        byte_length, statement_period_start, statement_period_end,
        retention_until, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      evidenceId,
      input.exchange,
      input.sourceKind,
      r2ObjectKey,
      payloadSha256,
      rawBytes.byteLength,
      input.statementPeriodStart,
      input.statementPeriodEnd,
      retentionUntil,
      createdAt
    )
    .run();

  return {
    id: evidenceId,
    exchange: input.exchange,
    sourceKind: input.sourceKind,
    r2ObjectKey,
    payloadSha256,
    byteLength: rawBytes.byteLength,
    statementPeriodStart: input.statementPeriodStart,
    statementPeriodEnd: input.statementPeriodEnd,
    retentionUntil,
    createdAt,
  };
}

/**
 * Retrieve an anchored evidence metadata row by primary key.
 */
export async function getEvidenceObjectById(
  db: D1Database,
  evidenceId: string
): Promise<EvidenceRecord | null> {
  if (!evidenceId || typeof evidenceId !== 'string') {
    return null;
  }
  const row = await db
    .prepare(
      `SELECT id, exchange, source_kind, r2_object_key, payload_sha256,
              byte_length, statement_period_start, statement_period_end,
              retention_until, created_at
       FROM r2_evidence_objects
       WHERE id = ?`
    )
    .bind(evidenceId)
    .first<RawEvidenceRow>();

  return row ? mapEvidenceRow(row) : null;
}

/**
 * Re-read raw bytes from R2, recompute SHA-256, and verify exact match against
 * `r2_evidence_objects.payload_sha256` and `byte_length`.
 */
export async function verifyEvidenceIntegrity(
  db: D1Database,
  r2: R2BucketLike,
  evidenceId: string
): Promise<EvidenceIntegrityResult> {
  const record = await getEvidenceObjectById(db, evidenceId);
  if (!record) {
    return {
      valid: false,
      evidenceId,
      r2ObjectKey: null,
      expectedSha256: null,
      actualSha256: null,
      expectedByteLength: null,
      actualByteLength: null,
      reason: 'EVIDENCE_NOT_FOUND',
    };
  }

  const r2Obj = await r2.get(record.r2ObjectKey);
  if (!r2Obj) {
    return {
      valid: false,
      evidenceId,
      r2ObjectKey: record.r2ObjectKey,
      expectedSha256: record.payloadSha256,
      actualSha256: null,
      expectedByteLength: record.byteLength,
      actualByteLength: null,
      reason: 'R2_OBJECT_MISSING',
      record,
    };
  }

  const rawBuffer = await r2Obj.arrayBuffer();
  const bytes = new Uint8Array(rawBuffer);
  const actualSha256 = await computeSha256Hex(bytes);

  if (bytes.byteLength !== record.byteLength) {
    return {
      valid: false,
      evidenceId,
      r2ObjectKey: record.r2ObjectKey,
      expectedSha256: record.payloadSha256,
      actualSha256,
      expectedByteLength: record.byteLength,
      actualByteLength: bytes.byteLength,
      reason: 'BYTE_LENGTH_MISMATCH',
      record,
    };
  }

  if (actualSha256 !== record.payloadSha256) {
    return {
      valid: false,
      evidenceId,
      r2ObjectKey: record.r2ObjectKey,
      expectedSha256: record.payloadSha256,
      actualSha256,
      expectedByteLength: record.byteLength,
      actualByteLength: bytes.byteLength,
      reason: 'SHA256_MISMATCH',
      record,
    };
  }

  return {
    valid: true,
    evidenceId,
    r2ObjectKey: record.r2ObjectKey,
    expectedSha256: record.payloadSha256,
    actualSha256,
    expectedByteLength: record.byteLength,
    actualByteLength: bytes.byteLength,
    record,
  };
}

/**
 * Assert cryptographic R2 evidence integrity or throw `EvidenceIntegrityError`.
 */
export async function assertEvidenceIntegrity(
  db: D1Database,
  r2: R2BucketLike,
  evidenceId: string
): Promise<EvidenceRecord> {
  const result = await verifyEvidenceIntegrity(db, r2, evidenceId);
  if (!result.valid || !result.record) {
    throw new EvidenceIntegrityError(
      `R2 evidence integrity check failed for "${evidenceId}": ${result.reason ?? 'UNKNOWN'}`,
      result
    );
  }
  return result.record;
}
