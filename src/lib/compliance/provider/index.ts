/**
 * src/lib/compliance/provider/index.ts
 *
 * ApexOS KYC & Regulatory Compliance Engine
 * KYC Provider Factory & Adapter Exports
 */

import { KycProviderAdapter } from './provider-interface';
import { SumsubAdapter } from './sumsub-adapter';
import { PersonaAdapter } from './persona-adapter';
import { MockKycAdapter } from './mock-adapter';

export * from './provider-interface';
export * from './sumsub-adapter';
export * from './persona-adapter';
export * from './mock-adapter';

/**
 * Resolves the active KYC provider adapter according to configuration or request parameters.
 * Defaults to MockKycAdapter if unconfigured or during testing.
 */
export function getKycProvider(providerName?: string): KycProviderAdapter {
  const envProvider =
    typeof process !== 'undefined' && process.env?.KYC_PROVIDER
      ? process.env.KYC_PROVIDER
      : '';

  const selected = (providerName || envProvider || 'mock').toLowerCase().trim();

  switch (selected) {
    case 'sumsub':
      return new SumsubAdapter();
    case 'persona':
      return new PersonaAdapter();
    case 'mock':
    default:
      return new MockKycAdapter();
  }
}
