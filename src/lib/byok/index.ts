// BYOK (Bring Your Own Key) — Per-User Encrypted API Credentials

export * from './types';

// Crypto functions
export {
  encryptApiKey,
  decryptApiKey,
  isByokConfigured,
} from './crypto';

// Key store operations - values (functions and classes)
export {
  setUserApiKey,
  getUserApiKey,
  deleteUserApiKey,
  listUserApiKeys,
  hasUserApiKey,
  ByokStoreError,
} from './user-api-key-store';

// Key store operations - types
export type { ByokProvider, ApiKeyMetadata } from './user-api-key-store';

// Resolution with fallback
export { resolveApiKey } from './resolve-api-key';
export type { ResolveApiKeyOptions } from './resolve-api-key';
