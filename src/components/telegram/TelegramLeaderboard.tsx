'use client';

/**
 * src/components/telegram/TelegramLeaderboard.tsx
 *
 * Touch-optimized Telegram Social Referral Leaderboard Component
 *
 * Features:
 * - Period selector tabs (All Time, This Month, This Week) with haptic feedback
 * - Top-3 Olympic-style Podium (🥇 1st Center Elevated, 🥈 2nd Left, 🥉 3rd Right)
 * - Ranks 4-100 scrollable list with tier badges (DIAMOND, PLATINUM, GOLD, SILVER, BRONZE)
 * - Sticky bottom user rank bar showing current standing and distance to next tier
 * - Mobile touch targets (>= 44px) and safe-area inset adaptability
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTelegramWebApp } from '@/hooks/useTelegramWebApp';
import type {
  LeaderboardEntry,
  LeaderboardPeriod,
  LeaderboardResponse,
} from '@/types/telegram';
import { Trophy, Medal, Award, Users, DollarSign, ChevronRight, RefreshCw, AlertCircle } from 'lucide-react';

export interface TelegramLeaderboardProps {
  currentTelegramId?: number | string;
  currentUserId?: string;
  initialPeriod?: LeaderboardPeriod;
  onSelectUser?: (entry: LeaderboardEntry) => void;
  className?: string;
}

// Tier badges definition
export type TierLevel = 'DIAMOND' | 'PLATINUM' | 'GOLD' | 'SILVER' | 'BRONZE';

export function computeTier(referrals: number, volumeUsd: number): TierLevel {
  if (referrals >= 50 || volumeUsd >= 5000) return 'DIAMOND';
  if (referrals >= 25 || volumeUsd >= 2000) return 'PLATINUM';
  if (referrals >= 10 || volumeUsd >= 500) return 'GOLD';
  if (referrals >= 3 || volumeUsd >= 100) return 'SILVER';
  return 'BRONZE';
}

export function getNextTierTarget(referrals: number): { nextTier: TierLevel | 'MAX'; needed: number } {
  if (referrals < 3) return { nextTier: 'SILVER', needed: 3 - referrals };
  if (referrals < 10) return { nextTier: 'GOLD', needed: 10 - referrals };
  if (referrals < 25) return { nextTier: 'PLATINUM', needed: 25 - referrals };
  if (referrals < 50) return { nextTier: 'DIAMOND', needed: 50 - referrals };
  return { nextTier: 'MAX', needed: 0 };
}

const TIER_COLORS: Record<TierLevel, { bg: string; text: string; border: string }> = {
  DIAMOND: { bg: 'bg-cyan-500/15', text: 'text-cyan-400', border: 'border-cyan-500/30' },
  PLATINUM: { bg: 'bg-purple-500/15', text: 'text-purple-400', border: 'border-purple-500/30' },
  GOLD: { bg: 'bg-amber-500/15', text: 'text-amber-400', border: 'border-amber-500/30' },
  SILVER: { bg: 'bg-slate-400/15', text: 'text-slate-300', border: 'border-slate-400/30' },
  BRONZE: { bg: 'bg-amber-700/15', text: 'text-amber-600', border: 'border-amber-700/30' },
};

export const TelegramLeaderboard: React.FC<TelegramLeaderboardProps> = ({
  currentTelegramId,
  currentUserId,
  initialPeriod = 'all_time',
  onSelectUser,
  className = '',
}) => {
  const { hapticFeedback } = useTelegramWebApp();
  const [period, setPeriod] = useState<LeaderboardPeriod>(initialPeriod);
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [userRank, setUserRank] = useState<LeaderboardResponse['user_rank']>(null);
  const [totalParticipants, setTotalParticipants] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch leaderboard data
  const fetchLeaderboard = useCallback(
    async (selectedPeriod: LeaderboardPeriod) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          period: selectedPeriod,
          limit: '100',
        });
        if (currentTelegramId) {
          params.append('telegram_id', String(currentTelegramId));
        }
        if (currentUserId) {
          params.append('user_id', currentUserId);
        }

        const res = await fetch(`/api/telegram/leaderboard?${params.toString()}`);
        if (!res.ok) {
          throw new Error(`Failed to load leaderboard (${res.status})`);
        }
        const data: LeaderboardResponse = await res.json();
        if (data.success) {
          setEntries(data.data || []);
          setUserRank(data.user_rank || null);
          setTotalParticipants(data.total_participants || (data.data ? data.data.length : 0));
        } else {
          throw new Error(data.error || 'Failed to fetch leaderboard data');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error fetching leaderboard');
      } finally {
        setLoading(false);
      }
    },
    [currentTelegramId, currentUserId]
  );

  useEffect(() => {
    fetchLeaderboard(period);
  }, [fetchLeaderboard, period]);

  // Tab switch with haptic feedback
  const handlePeriodChange = (newPeriod: LeaderboardPeriod) => {
    if (newPeriod === period) return;
    hapticFeedback.selectionChanged();
    setPeriod(newPeriod);
  };

  // Top 3 entries
  const top1 = entries[0] || null;
  const top2 = entries[1] || null;
  const top3 = entries[2] || null;

  // Remaining entries (ranks 4 to 100)
  const remainingEntries = useMemo(() => entries.slice(3), [entries]);

  // Next tier progress for current user
  const userNextTier = useMemo(() => {
    const refs = userRank?.verified_referees || 0;
    return getNextTierTarget(refs);
  }, [userRank]);

  return (
    <div className={`flex flex-col w-full pb-20 ${className}`}>
      {/* 1. Period Selector Tabs */}
      <div className="flex items-center justify-center p-1 mb-4 rounded-xl bg-slate-800/60 backdrop-blur-md border border-slate-700/50">
        <button
          type="button"
          onClick={() => handlePeriodChange('all_time')}
          className={`flex-1 py-2 text-xs font-semibold rounded-lg touch-target transition-all ${
            period === 'all_time'
              ? 'bg-indigo-600 text-white shadow-md'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          aria-label="All Time leaderboard"
          data-testid="tab-all-time"
        >
          All Time
        </button>
        <button
          type="button"
          onClick={() => handlePeriodChange('monthly')}
          className={`flex-1 py-2 text-xs font-semibold rounded-lg touch-target transition-all ${
            period === 'monthly'
              ? 'bg-indigo-600 text-white shadow-md'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          aria-label="Monthly leaderboard"
          data-testid="tab-monthly"
        >
          This Month
        </button>
        <button
          type="button"
          onClick={() => handlePeriodChange('weekly')}
          className={`flex-1 py-2 text-xs font-semibold rounded-lg touch-target transition-all ${
            period === 'weekly'
              ? 'bg-indigo-600 text-white shadow-md'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          aria-label="Weekly leaderboard"
          data-testid="tab-weekly"
        >
          This Week
        </button>
      </div>

      {/* 2. Loading State */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-12 space-y-3" data-testid="leaderboard-loading">
          <RefreshCw className="w-8 h-8 text-indigo-400 animate-spin" />
          <p className="text-sm text-slate-400">Loading top referrers...</p>
        </div>
      )}

      {/* 3. Error State */}
      {!loading && error && (
        <div
          className="flex flex-col items-center justify-center p-6 my-4 text-center rounded-xl bg-red-950/30 border border-red-800/40"
          data-testid="leaderboard-error"
        >
          <AlertCircle className="w-8 h-8 mb-2 text-red-400" />
          <p className="text-sm font-medium text-red-200">{error}</p>
          <button
            type="button"
            onClick={() => fetchLeaderboard(period)}
            className="px-4 py-2 mt-3 text-xs font-semibold text-white bg-red-600 rounded-lg touch-target hover:bg-red-500"
          >
            Retry
          </button>
        </div>
      )}

      {/* 4. Leaderboard Content */}
      {!loading && !error && (
        <>
          {entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center rounded-2xl bg-slate-800/30 border border-slate-700/40">
              <Users className="w-12 h-12 mb-3 text-slate-500" />
              <h3 className="text-base font-semibold text-slate-200">No referrers yet</h3>
              <p className="mt-1 text-xs text-slate-400">
                Be the first to invite friends and top the leaderboard!
              </p>
            </div>
          ) : (
            <>
              {/* Podium Section (Top 3) */}
              <div className="grid grid-cols-3 gap-2 items-end pt-4 pb-6 px-1" data-testid="podium-section">
                {/* 2nd Place (Silver - Left) */}
                <div className="flex flex-col items-center text-center">
                  {top2 ? (
                    <div
                      onClick={() => {
                        hapticFeedback.impactOccurred('light');
                        onSelectUser?.(top2);
                      }}
                      className="flex flex-col items-center w-full cursor-pointer group"
                      data-testid="podium-rank-2"
                    >
                      <div className="relative mb-2">
                        <div className="flex items-center justify-center w-14 h-14 rounded-full bg-gradient-to-tr from-slate-400 to-slate-200 text-slate-900 font-bold text-base shadow-lg border-2 border-slate-300">
                          {top2.photo_url ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img
                              src={top2.photo_url}
                              alt={top2.display_name}
                              className="w-full h-full rounded-full object-cover"
                            />
                          ) : (
                            top2.display_name.slice(0, 2).toUpperCase()
                          )}
                        </div>
                        <div className="absolute -bottom-2 inset-x-0 mx-auto w-6 h-6 rounded-full bg-slate-400 text-slate-950 font-bold text-xs flex items-center justify-center shadow">
                          2
                        </div>
                      </div>
                      <span className="w-full text-xs font-semibold text-slate-200 truncate mt-1">
                        {top2.display_name}
                      </span>
                      <span className="text-[11px] text-slate-400 font-medium">
                        {top2.verified_referees} refs
                      </span>
                      <div className="w-full mt-2 pt-3 pb-2 rounded-t-lg bg-slate-700/60 border-t border-x border-slate-500/40 text-[11px] font-bold text-slate-300">
                        ${top2.total_earnings_usd?.toFixed(0) || '0'}
                      </div>
                    </div>
                  ) : (
                    <div className="w-full h-24 border border-dashed border-slate-700 rounded-lg flex items-center justify-center text-slate-600 text-xs">
                      2nd
                    </div>
                  )}
                </div>

                {/* 1st Place (Gold - Center / Elevated) */}
                <div className="flex flex-col items-center text-center">
                  {top1 ? (
                    <div
                      onClick={() => {
                        hapticFeedback.impactOccurred('medium');
                        onSelectUser?.(top1);
                      }}
                      className="flex flex-col items-center w-full cursor-pointer group -translate-y-2"
                      data-testid="podium-rank-1"
                    >
                      <div className="relative mb-2">
                        <div className="absolute -top-4 inset-x-0 mx-auto w-6 h-6 text-amber-400 flex items-center justify-center animate-bounce">
                          👑
                        </div>
                        <div className="flex items-center justify-center w-16 h-16 rounded-full bg-gradient-to-tr from-amber-500 to-yellow-200 text-amber-950 font-extrabold text-lg shadow-xl border-2 border-yellow-400">
                          {top1.photo_url ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img
                              src={top1.photo_url}
                              alt={top1.display_name}
                              className="w-full h-full rounded-full object-cover"
                            />
                          ) : (
                            top1.display_name.slice(0, 2).toUpperCase()
                          )}
                        </div>
                        <div className="absolute -bottom-2 inset-x-0 mx-auto w-6 h-6 rounded-full bg-amber-400 text-amber-950 font-bold text-xs flex items-center justify-center shadow">
                          1
                        </div>
                      </div>
                      <span className="w-full text-xs font-bold text-amber-200 truncate mt-1">
                        {top1.display_name}
                      </span>
                      <span className="text-[11px] text-amber-300/80 font-medium">
                        {top1.verified_referees} refs
                      </span>
                      <div className="w-full mt-2 pt-4 pb-2 rounded-t-lg bg-amber-500/20 border-t border-x border-amber-400/50 text-xs font-extrabold text-amber-300">
                        ${top1.total_earnings_usd?.toFixed(0) || '0'}
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* 3rd Place (Bronze - Right) */}
                <div className="flex flex-col items-center text-center">
                  {top3 ? (
                    <div
                      onClick={() => {
                        hapticFeedback.impactOccurred('light');
                        onSelectUser?.(top3);
                      }}
                      className="flex flex-col items-center w-full cursor-pointer group"
                      data-testid="podium-rank-3"
                    >
                      <div className="relative mb-2">
                        <div className="flex items-center justify-center w-14 h-14 rounded-full bg-gradient-to-tr from-amber-700 to-amber-500 text-amber-950 font-bold text-base shadow-lg border-2 border-amber-600">
                          {top3.photo_url ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img
                              src={top3.photo_url}
                              alt={top3.display_name}
                              className="w-full h-full rounded-full object-cover"
                            />
                          ) : (
                            top3.display_name.slice(0, 2).toUpperCase()
                          )}
                        </div>
                        <div className="absolute -bottom-2 inset-x-0 mx-auto w-6 h-6 rounded-full bg-amber-600 text-white font-bold text-xs flex items-center justify-center shadow">
                          3
                        </div>
                      </div>
                      <span className="w-full text-xs font-semibold text-slate-200 truncate mt-1">
                        {top3.display_name}
                      </span>
                      <span className="text-[11px] text-slate-400 font-medium">
                        {top3.verified_referees} refs
                      </span>
                      <div className="w-full mt-2 pt-2 pb-2 rounded-t-lg bg-amber-900/30 border-t border-x border-amber-700/40 text-[11px] font-bold text-amber-400">
                        ${top3.total_earnings_usd?.toFixed(0) || '0'}
                      </div>
                    </div>
                  ) : (
                    <div className="w-full h-20 border border-dashed border-slate-700 rounded-lg flex items-center justify-center text-slate-600 text-xs">
                      3rd
                    </div>
                  )}
                </div>
              </div>

              {/* Ranks 4–100 List */}
              <div className="space-y-2 mt-2" data-testid="ranks-list">
                {remainingEntries.map((entry) => {
                  const tier = computeTier(entry.verified_referees, entry.total_volume_usd);
                  const tierStyle = TIER_COLORS[tier];

                  return (
                    <div
                      key={entry.rank}
                      onClick={() => {
                        hapticFeedback.impactOccurred('light');
                        onSelectUser?.(entry);
                      }}
                      className="flex items-center justify-between p-3 rounded-xl bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/30 transition-all cursor-pointer touch-target-h"
                      data-testid={`rank-row-${entry.rank}`}
                    >
                      <div className="flex items-center space-x-3 min-w-0">
                        <span className="w-6 text-xs font-bold text-slate-400 text-center">
                          #{entry.rank}
                        </span>

                        <div className="flex items-center justify-center w-8 h-8 rounded-full bg-slate-700 text-slate-300 font-semibold text-xs shrink-0">
                          {entry.photo_url ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img
                              src={entry.photo_url}
                              alt={entry.display_name}
                              className="w-full h-full rounded-full object-cover"
                            />
                          ) : (
                            entry.display_name.slice(0, 2).toUpperCase()
                          )}
                        </div>

                        <div className="flex flex-col min-w-0">
                          <span className="text-xs font-semibold text-slate-200 truncate">
                            {entry.display_name}
                          </span>
                          <span className="text-[10px] text-slate-400">
                            {entry.verified_referees} verified referrals
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center space-x-2 shrink-0">
                        <span
                          className={`px-2 py-0.5 text-[10px] font-bold rounded-md border ${tierStyle.bg} ${tierStyle.text} ${tierStyle.border}`}
                        >
                          {tier}
                        </span>
                        <div className="text-right">
                          <span className="text-xs font-bold text-emerald-400">
                            ${entry.total_earnings_usd?.toFixed(0) || '0'}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      {/* 5. Sticky Bottom User Rank Bar */}
      <div
        className="fixed bottom-0 inset-x-0 p-3 bg-slate-900/90 backdrop-blur-lg border-t border-slate-800 shadow-2xl z-40 pb-safe"
        data-testid="sticky-user-rank-bar"
      >
        <div className="max-w-md mx-auto flex items-center justify-between">
          {userRank ? (
            <div className="flex items-center space-x-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-indigo-600 text-white font-bold text-sm shadow">
                #{userRank.rank}
              </div>
              <div className="flex flex-col">
                <span className="text-xs font-bold text-slate-200">
                  Your Standing: Rank #{userRank.rank}
                </span>
                <span className="text-[11px] text-slate-400">
                  {userRank.verified_referees} referrals · ${userRank.total_earnings_usd.toFixed(0)} earned
                </span>
              </div>
            </div>
          ) : (
            <div className="flex items-center space-x-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-full bg-slate-800 text-slate-400 font-bold text-sm">
                —
              </div>
              <div className="flex flex-col">
                <span className="text-xs font-bold text-slate-200">You are unranked</span>
                <span className="text-[11px] text-slate-400">Invite friends to join the board!</span>
              </div>
            </div>
          )}

          {userNextTier.nextTier !== 'MAX' ? (
            <div className="text-right">
              <span className="text-[11px] font-semibold text-indigo-400">
                +{userNextTier.needed} refs to {userNextTier.nextTier}
              </span>
              <div className="w-24 h-1.5 bg-slate-700 rounded-full overflow-hidden mt-1">
                <div
                  className="h-full bg-indigo-500 rounded-full"
                  style={{
                    width: `${Math.min(
                      100,
                      ((userRank?.verified_referees || 0) /
                        ((userRank?.verified_referees || 0) + userNextTier.needed)) *
                        100
                    )}%`,
                  }}
                />
              </div>
            </div>
          ) : (
            <span className="px-2 py-1 text-[10px] font-bold rounded bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">
              TOP TIER
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default TelegramLeaderboard;
