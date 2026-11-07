/**
 * Telegram social referral leaderboard tier and podium rules.
 *
 * Kept outside the route module so Next.js route handlers expose only HTTP method
 * handlers to its route-type validator.
 */

/**
 * Computes referral tier badge based on verified referrals count and volume
 */
export function calculateTier(
  referrals: number,
  volumeUsd: number
): 'DIAMOND' | 'PLATINUM' | 'GOLD' | 'SILVER' | 'BRONZE' {
  if (referrals >= 50 || volumeUsd >= 5000) return 'DIAMOND';
  if (referrals >= 25 || volumeUsd >= 2000) return 'PLATINUM';
  if (referrals >= 10 || volumeUsd >= 500) return 'GOLD';
  if (referrals >= 3 || volumeUsd >= 100) return 'SILVER';
  return 'BRONZE';
}

/**
 * Computes podium badge based on sequential 1-indexed rank
 */
export function calculateBadge(
  rank: number
): 'gold' | 'silver' | 'bronze' | 'top_10' | 'contender' {
  if (rank === 1) return 'gold';
  if (rank === 2) return 'silver';
  if (rank === 3) return 'bronze';
  if (rank <= 10) return 'top_10';
  return 'contender';
}
