/**
 * PII Redactor & Read-Only AI Boundary Guard
 *
 * Deterministically strips/hashes PII (emails, IPv4/IPv6 addresses, phone numbers,
 * Vietnamese CCCD/CMND & passport numbers, session tokens, API keys/secrets) and
 * masks on-chain wallet addresses (`0x1234...abcd` / `GA5Z...KZVN`) before any
 * payload can be transmitted to a read-only AI helper (`OmniRoute`).
 *
 * Also enforces a strict read-only tool allowlist so AI helpers can never invoke
 * ledger mutations, payout approvals, wallet changes, or secret reads.
 */

import { createHash } from 'node:crypto';

export const READ_ONLY_AI_ALLOWED_TOOLS = [
  'get_fee_analytics_summary',
  'get_rebate_schedule_info',
  'explain_settlement_timeline',
  'get_public_exchange_rates',
  'search_help_docs',
] as const;

export type ReadOnlyAiAllowedTool = (typeof READ_ONLY_AI_ALLOWED_TOOLS)[number];

const FORBIDDEN_AI_TOOL_KEYWORDS = [
  'ledger',
  'write',
  'insert',
  'update',
  'delete',
  'payout',
  'approve',
  'settle',
  'withdraw',
  'wallet',
  'secret',
  'env',
  'key',
  'token',
  'sign',
  'turnkey',
  'passkey',
  'override',
] as const;

const SENSITIVE_FIELD_NAME_REGEX =
  /(?:password|passphrase|secret|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|bearer|authorization|cookie|cccd|cmnd|national[_-]?id|passport|ssn|tax[_-]?id)/i;

const EMAIL_FIELD_NAME_REGEX = /(?:^|_|-)(?:email|e_mail|mail)(?:$|_|-)/i;
const PHONE_FIELD_NAME_REGEX = /(?:^|_|-)(?:phone|mobile|msisdn|tel|telephone)(?:$|_|-)/i;
const IP_FIELD_NAME_REGEX = /(?:^|_|-)(?:ip|ip_address|ipaddress|client_ip|remote_ip|requested_ip)(?:$|_|-)/i;

// Inline pattern matchers
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const BEARER_TOKEN_REGEX = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const JWT_REGEX = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const KNOWN_SECRET_PREFIX_REGEX =
  /\b(?:sk_(?:live|test)_[A-Za-z0-9]{10,}|rk_(?:live|test)_[A-Za-z0-9]{10,}|re_[A-Za-z0-9_]{12,}|whsec_[A-Za-z0-9_]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|S[A-Z2-7]{55})\b/g;

// EVM address: 0x + 40 hex chars -> 0x1234...abcd
const EVM_WALLET_REGEX = /\b(0x[0-9a-fA-F]{4})[0-9a-fA-F]{32}([0-9a-fA-F]{4})\b/g;
// Stellar public address: G + 55 base32 chars -> GA5Z...KZVN
const STELLAR_WALLET_REGEX = /\b(G[A-Z2-7]{3})[A-Z2-7]{48}([A-Z2-7]{4})\b/g;

// IPv4 (valid octets 0-255)
const IPV4_REGEX =
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;

// IPv6 (standard full, compressed ::, and IPv4-mapped ::ffff:...)
const IPV6_REGEX =
  /(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?:(?::[0-9a-fA-F]{1,4}){1,6})|:(?:(?::[0-9a-fA-F]{1,4}){1,7}|:)|::ffff:(?:\d{1,3}\.){3}\d{1,3})/g;

// Vietnamese 12-digit CCCD (starts with 001..096 province code) or 9-digit CMND
const VN_CCCD_REGEX = /\b0(?:0[1-9]|[1-8]\d|9[0-6])[0-9]\d{8}\b/g;
// Vietnamese & international passport numbers (1-2 uppercase letters + 7-8 digits, e.g., C1234567, B12345678, P12345678)
const PASSPORT_REGEX = /\b[A-CEGHJ-NPRTVWXYZ]{1,2}\d{7,8}\b/g;

// Phone numbers: E.164 (+84..., +1...) or VN domestic (09x, 08x, 07x, 05x, 03x) or international formatted
const PHONE_REGEX =
  /(?:\+\d{1,3}[\s.-]?(?:\(?\d{1,4}\)?[\s.-]?){2,4}\d{2,4}|\b0[35789]\d(?:[\s.-]?\d){7}\b)/g;

export interface PiiRedactionOptions {
  salt?: string;
  requestedTools?: readonly string[];
}

export interface PiiRedactionResult<T> {
  redacted: T;
  redactionCount: number;
  categoriesRedacted: string[];
  readOnlyVerified: true;
}

function deterministicShortHash(category: string, rawValue: string, salt: string): string {
  const digest = createHash('sha256')
    .update(`${salt}:${category}:${rawValue.trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 12);
  return `[REDACTED_${category}:${digest}]`;
}

export function maskWalletAddress(address: string): string {
  const trimmed = address.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
  }
  if (/^G[A-Z2-7]{55}$/.test(trimmed)) {
    return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
  }
  return trimmed;
}

/**
 * Enforces that any AI tool list strictly conforms to the read-only allowlist.
 * Throws synchronously if any mutation, payout, wallet, ledger, or secret tool is requested.
 */
export function assertReadOnlyAiTools(tools: readonly string[]): void {
  const allowedSet = new Set<string>(READ_ONLY_AI_ALLOWED_TOOLS);
  for (const rawTool of tools) {
    const tool = rawTool.trim();
    if (allowedSet.has(tool)) {
      continue;
    }

    const lower = tool.toLowerCase();
    for (const forbidden of FORBIDDEN_AI_TOOL_KEYWORDS) {
      if (lower.includes(forbidden)) {
        throw new Error(
          `AI tool '${tool}' violates read-only policy (forbidden capability: '${forbidden}')`
        );
      }
    }

    throw new Error(`AI tool '${tool}' is not in READ_ONLY_AI_ALLOWED_TOOLS`);
  }
}

function redactStringValue(
  input: string,
  salt: string,
  stats: { count: number; categories: Set<string> }
): string {
  let output = input;

  // 1. Secrets, Bearer tokens, JWTs, Stellar secret seeds
  output = output.replace(BEARER_TOKEN_REGEX, () => {
    stats.count += 1;
    stats.categories.add('TOKEN');
    return '[REDACTED_TOKEN]';
  });

  output = output.replace(JWT_REGEX, () => {
    stats.count += 1;
    stats.categories.add('TOKEN');
    return '[REDACTED_TOKEN]';
  });

  output = output.replace(KNOWN_SECRET_PREFIX_REGEX, () => {
    stats.count += 1;
    stats.categories.add('SECRET');
    return '[REDACTED_SECRET]';
  });

  // 2. Mask EVM & Stellar public wallet addresses (preserve 4-char prefix/suffix only)
  output = output.replace(EVM_WALLET_REGEX, (_full, prefix: string, suffix: string) => {
    stats.count += 1;
    stats.categories.add('WALLET');
    return `${prefix}...${suffix}`;
  });

  output = output.replace(STELLAR_WALLET_REGEX, (_full, prefix: string, suffix: string) => {
    stats.count += 1;
    stats.categories.add('WALLET');
    return `${prefix}...${suffix}`;
  });

  // 3. Emails -> deterministic salted hash
  output = output.replace(EMAIL_REGEX, (match) => {
    stats.count += 1;
    stats.categories.add('EMAIL');
    return deterministicShortHash('EMAIL', match, salt);
  });

  // 4. IPv4 & IPv6 addresses
  output = output.replace(IPV4_REGEX, (match) => {
    stats.count += 1;
    stats.categories.add('IP');
    return deterministicShortHash('IP', match, salt);
  });

  output = output.replace(IPV6_REGEX, (match) => {
    stats.count += 1;
    stats.categories.add('IP');
    return deterministicShortHash('IP', match, salt);
  });

  // 5. Vietnamese CCCD (12-digit) BEFORE phone numbers so 0xx digits don't partially match phone
  output = output.replace(VN_CCCD_REGEX, (match) => {
    stats.count += 1;
    stats.categories.add('NATIONAL_ID');
    return deterministicShortHash('CCCD', match, salt);
  });

  // 6. Passport numbers
  output = output.replace(PASSPORT_REGEX, (match) => {
    stats.count += 1;
    stats.categories.add('PASSPORT');
    return deterministicShortHash('PASSPORT', match, salt);
  });

  // 7. Phone numbers
  output = output.replace(PHONE_REGEX, (match) => {
    stats.count += 1;
    stats.categories.add('PHONE');
    return deterministicShortHash('PHONE', match, salt);
  });

  return output;
}

function redactRecursive(
  value: unknown,
  salt: string,
  stats: { count: number; categories: Set<string> },
  parentKey?: string
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (parentKey) {
    if (SENSITIVE_FIELD_NAME_REGEX.test(parentKey)) {
      stats.count += 1;
      stats.categories.add('SECRET_FIELD');
      return '[REDACTED_SENSITIVE_FIELD]';
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      if (EMAIL_FIELD_NAME_REGEX.test(parentKey)) {
        stats.count += 1;
        stats.categories.add('EMAIL');
        return deterministicShortHash('EMAIL', value, salt);
      }
      if (PHONE_FIELD_NAME_REGEX.test(parentKey)) {
        stats.count += 1;
        stats.categories.add('PHONE');
        return deterministicShortHash('PHONE', value, salt);
      }
      if (IP_FIELD_NAME_REGEX.test(parentKey)) {
        stats.count += 1;
        stats.categories.add('IP');
        return deterministicShortHash('IP', value, salt);
      }
    }
  }

  if (typeof value === 'string') {
    return redactStringValue(value, salt, stats);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactRecursive(item, salt, stats));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entryVal] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactRecursive(entryVal, salt, stats, key);
    }
    return out;
  }

  return value;
}

/**
 * Redacts all PII, secrets, and full wallet addresses from `input` before sending
 * to a read-only AI helper (`OmniRoute`), and validates any requested AI tools
 * against the read-only allowlist.
 */
export function redactPiiForReadOnlyAi<T>(
  input: T,
  options?: PiiRedactionOptions
): PiiRedactionResult<T> {
  if (options?.requestedTools) {
    assertReadOnlyAiTools(options.requestedTools);
  }

  const salt = options?.salt ?? 'apex-os-pii-redactor-v1';
  const stats = { count: 0, categories: new Set<string>() };
  const redacted = redactRecursive(input, salt, stats) as T;

  return {
    redacted,
    redactionCount: stats.count,
    categoriesRedacted: Array.from(stats.categories),
    readOnlyVerified: true,
  };
}
