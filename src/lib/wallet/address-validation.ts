/**
 * Wallet Address Validation Constants & Helpers
 * Extracted from `src/app/api/profile/wallet/route.ts` so Next.js 16 App Router
 * strict route export validation (`POST | GET | DELETE` only) succeeds cleanly.
 */

export type SupportedChain = 'ethereum' | 'solana' | 'stellar';

export const SUPPORTED_CHAINS: readonly SupportedChain[] = [
  'ethereum',
  'solana',
  'stellar',
] as const;

export const CHAIN_ADDRESS_REGEX: Record<
  SupportedChain | 'arbitrum' | 'base',
  RegExp
> = {
  ethereum: /^0x[0-9a-fA-F]{40}$/,
  arbitrum: /^0x[0-9a-fA-F]{40}$/,
  base: /^0x[0-9a-fA-F]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  stellar: /^G[A-Z2-7]{55}$/,
};

export function validateWalletAddress(
  address: string,
  chain: SupportedChain
): boolean {
  const regex = CHAIN_ADDRESS_REGEX[chain];
  if (!regex) return false;
  return regex.test(address);
}
