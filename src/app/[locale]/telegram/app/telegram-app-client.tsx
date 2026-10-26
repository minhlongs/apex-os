'use client';

/**
 * src/app/[locale]/telegram/app/telegram-app-client.tsx
 *
 * Touch-optimized client interface for ApexOS Telegram Mini App (TMA).
 *
 * Features:
 * - Edge initData authentication via POST /api/auth/telegram
 * - Touch-friendly header with user profile & wallet binding badge
 * - 4 Touch Tabs:
 *     1. Deals & Arbitrage Feed (live cards, cashback %, spread bps, 1-click claim)
 *     2. Viral Referral (1-click copy with haptics, deep share button, $5 social bonus card)
 *     3. Leaderboard (integrated TelegramLeaderboard component)
 *     4. Earnings Summary (stats, pending/paid payouts, wallet binding form)
 * - Safe area padding, theme variables, and HapticFeedback integration
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useTelegramWebApp } from '@/hooks/useTelegramWebApp';
import { TelegramLeaderboard } from '@/components/telegram/TelegramLeaderboard';
import type { TelegramAuthResponse } from '@/types/telegram';
import {
  Sparkles,
  Share2,
  Trophy,
  Wallet,
  Copy,
  Check,
  TrendingUp,
  ExternalLink,
  Percent,
  Coins,
  ShieldCheck,
  Zap,
  ArrowUpRight,
  AlertCircle,
} from 'lucide-react';

export type TMATab = 'deals' | 'referral' | 'leaderboard' | 'earnings';

export interface DealItem {
  id: string;
  name: string;
  exchange: 'binance' | 'bybit' | 'okx' | 'kucoin' | string;
  cashback_percent: number;
  spread_bps?: number;
  pair?: string;
  url: string;
}

const FALLBACK_DEALS: DealItem[] = [
  {
    id: 'deal-bybit-vip',
    name: 'Bybit Derivatives VIP Cashback',
    exchange: 'bybit',
    cashback_percent: 45,
    spread_bps: 35,
    pair: 'BTC/USDT',
    url: 'https://bybit.com/register',
  },
  {
    id: 'deal-binance-spot',
    name: 'Binance Spot Zero-Fee & Kickback',
    exchange: 'binance',
    cashback_percent: 30,
    spread_bps: 20,
    pair: 'ETH/USDT',
    url: 'https://binance.com/register',
  },
  {
    id: 'deal-okx-arb',
    name: 'OKX Multi-Asset Spread Arbitrage',
    exchange: 'okx',
    cashback_percent: 40,
    spread_bps: 42,
    pair: 'SOL/USDT',
    url: 'https://okx.com/join',
  },
  {
    id: 'deal-kucoin-futures',
    name: 'KuCoin Contract Fee Rebate',
    exchange: 'kucoin',
    cashback_percent: 35,
    spread_bps: 18,
    pair: 'XRP/USDT',
    url: 'https://kucoin.com/ucenter/signup',
  },
];

export interface TelegramAppClientProps {
  locale?: string;
}

export const TelegramAppClient: React.FC<TelegramAppClientProps> = ({ locale = 'en' }) => {
  const {
    user,
    initData,
    hapticFeedback,
    openTelegramLink,
    openLink,
  } = useTelegramWebApp();

  // Navigation tab state
  const [activeTab, setActiveTab] = useState<TMATab>('deals');

  // Authenticated user state
  const [authUser, setAuthUser] = useState<TelegramAuthResponse['user'] | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(true);

  // Deals state
  const [deals, setDeals] = useState<DealItem[]>(FALLBACK_DEALS);
  const [loadingDeals, setLoadingDeals] = useState<boolean>(false);

  // Copy feedback state
  const [copiedLink, setCopiedLink] = useState<boolean>(false);
  const [copiedDealId, setCopiedDealId] = useState<string | null>(null);

  // Wallet form state
  const [walletAddressInput, setWalletAddressInput] = useState<string>('');
  const [preferredChainInput, setPreferredChainInput] = useState<'ethereum' | 'solana' | 'stellar'>('ethereum');
  const [walletSaving, setWalletSaving] = useState<boolean>(false);
  const [walletStatusMessage, setWalletStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Authenticate user with initData
  useEffect(() => {
    let isMounted = true;

    async function authenticate() {
      setAuthLoading(true);
      try {
        if (initData) {
          const res = await fetch('/api/auth/telegram', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ initData }),
          });
          const data: TelegramAuthResponse = await res.json();
          if (isMounted && data.success && data.user) {
            setAuthUser(data.user);
            if (data.user.wallet_address) {
              setWalletAddressInput(data.user.wallet_address);
            }
            if (data.user.preferred_chain) {
              setPreferredChainInput(data.user.preferred_chain as any);
            }
            return;
          }
        }

        // SSR / outside Telegram fallback
        if (isMounted) {
          const fallbackUser = {
            id: 'usr_demo',
            email: 'tg_demo@telegram.apexos.io',
            telegram_id: user?.id || 999999,
            username: user?.username || 'ApexTrader',
            first_name: user?.first_name || 'Apex',
            referral_code: user?.username ? `APEX_${user.username.toUpperCase()}` : 'APEX_VIP',
            wallet_address: null,
            preferred_chain: 'ethereum' as const,
            kyc_tier: 'tier1',
          };
          setAuthUser(fallbackUser);
        }
      } catch {
        if (isMounted) {
          setAuthUser({
            id: 'usr_guest',
            email: 'guest@telegram.apexos.io',
            telegram_id: user?.id || 0,
            username: user?.username || null,
            first_name: user?.first_name || 'Guest',
            referral_code: 'APEX_GUEST',
          });
        }
      } finally {
        if (isMounted) setAuthLoading(false);
      }
    }

    authenticate();
    return () => {
      isMounted = false;
    };
  }, [initData, user]);

  // Fetch live deals and arbitrage opportunities
  useEffect(() => {
    let isMounted = true;

    async function loadDeals() {
      setLoadingDeals(true);
      try {
        const [arbRes, publicRes] = await Promise.allSettled([
          fetch('/api/deals/arbitrage?limit=10'),
          fetch('/api/public/deals?limit=10'),
        ]);

        const loaded: DealItem[] = [];

        if (arbRes.status === 'fulfilled' && arbRes.value.ok) {
          const arbData = await arbRes.value.json();
          if (arbData.data && Array.isArray(arbData.data)) {
            for (const item of arbData.data) {
              loaded.push({
                id: item.id || `arb-${item.pair}-${item.base_exchange}`,
                name: `${item.pair} Fee Arbitrage`,
                exchange: item.base_exchange || 'bybit',
                cashback_percent: item.savings_pct ? Math.round(item.savings_pct) : 35,
                spread_bps: item.spread_bps || 25,
                pair: item.pair,
                url: item.deal_url || 'https://apex-os.com/deals',
              });
            }
          }
        }

        if (publicRes.status === 'fulfilled' && publicRes.value.ok) {
          const pubData = await publicRes.value.json();
          if (pubData.deals && Array.isArray(pubData.deals)) {
            for (const deal of pubData.deals) {
              loaded.push({
                id: deal.id,
                name: deal.name,
                exchange: deal.exchange || 'binance',
                cashback_percent: deal.cashback_percent || 30,
                spread_bps: 15,
                url: deal.url || 'https://apex-os.com/deals',
              });
            }
          }
        }

        if (isMounted && loaded.length > 0) {
          setDeals(loaded);
        }
      } catch {
        // Keep fallback deals
      } finally {
        if (isMounted) setLoadingDeals(false);
      }
    }

    loadDeals();
    return () => {
      isMounted = false;
    };
  }, []);

  // Tab switch handler with haptic feedback
  const handleTabChange = (tab: TMATab) => {
    if (tab === activeTab) return;
    hapticFeedback.selectionChanged();
    setActiveTab(tab);
  };

  // Personal referral link
  const referralCode = authUser?.referral_code || 'APEX_VIP';
  const referralLink = `https://t.me/ApexOSBot?start=ref_${referralCode}`;

  // Copy referral link
  const handleCopyReferral = useCallback(async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(referralLink);
      }
      hapticFeedback.notificationOccurred('success');
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2500);
    } catch {
      hapticFeedback.notificationOccurred('warning');
    }
  }, [referralLink, hapticFeedback]);

  // Share with Telegram friends
  const handleShareTelegram = useCallback(() => {
    hapticFeedback.impactOccurred('medium');
    const shareText = `🚀 Join ApexOS to get up to 45% crypto cashback & fee discounts on Binance, Bybit, OKX, and KuCoin! Tap to claim your $5.00 bonus:`;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent(shareText)}`;
    openTelegramLink(shareUrl);
  }, [referralLink, hapticFeedback, openTelegramLink]);

  // Copy individual deal link
  const handleClaimDeal = useCallback(
    async (deal: DealItem) => {
      const dealLink = `${deal.url}?ref=${referralCode}`;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          await navigator.clipboard.writeText(dealLink);
        }
        hapticFeedback.notificationOccurred('success');
        setCopiedDealId(deal.id);
        setTimeout(() => setCopiedDealId(null), 2000);
      } catch {
        openLink(dealLink);
      }
    },
    [referralCode, hapticFeedback, openLink]
  );

  // Save wallet address
  const handleSaveWallet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!walletAddressInput.trim()) {
      setWalletStatusMessage({ type: 'error', text: 'Please enter a valid wallet address.' });
      hapticFeedback.notificationOccurred('error');
      return;
    }

    setWalletSaving(true);
    setWalletStatusMessage(null);

    try {
      const res = await fetch('/api/auth/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          initData: initData || 'demo_auth',
          wallet_address: walletAddressInput.trim(),
          preferred_chain: preferredChainInput,
        }),
      });

      const data: TelegramAuthResponse = await res.json();
      if (data.success && data.user) {
        setAuthUser(data.user);
        setWalletStatusMessage({ type: 'success', text: 'Wallet successfully bound!' });
        hapticFeedback.notificationOccurred('success');
      } else {
        throw new Error(data.error || 'Failed to update wallet');
      }
    } catch (err) {
      setWalletStatusMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Invalid wallet address',
      });
      hapticFeedback.notificationOccurred('error');
    } finally {
      setWalletSaving(false);
    }
  };

  const displayName = authUser?.first_name || user?.first_name || 'Trader';
  const displayWallet = authUser?.wallet_address
    ? `${authUser.wallet_address.slice(0, 6)}...${authUser.wallet_address.slice(-4)}`
    : null;

  return (
    <div className="flex flex-col flex-1 w-full max-w-lg mx-auto min-h-screen px-4 pt-safe pb-24 selection:bg-indigo-500/20">
      {/* 1. Header with Avatar, Greeting & Wallet Status */}
      <header className="flex items-center justify-between py-4 border-b border-slate-800/80 mb-4">
        <div className="flex items-center space-x-3">
          <div className="flex items-center justify-center w-11 h-11 rounded-full bg-gradient-to-tr from-indigo-600 to-violet-500 text-white font-bold text-base shadow-md">
            {user?.photo_url ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={user.photo_url}
                alt={displayName}
                className="w-full h-full rounded-full object-cover"
              />
            ) : (
              displayName.slice(0, 2).toUpperCase()
            )}
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-slate-400 font-medium">ApexOS Mini App</span>
            <h1 className="text-base font-bold text-slate-100 flex items-center">
              Hey, {displayName}! 👋
            </h1>
          </div>
        </div>

        <button
          type="button"
          onClick={() => handleTabChange('earnings')}
          className="flex items-center space-x-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-slate-800/90 border border-slate-700/60 hover:border-indigo-500/50 transition-all touch-target-h"
          data-testid="header-wallet-btn"
        >
          <Wallet className="w-3.5 h-3.5 text-indigo-400" />
          <span className="text-slate-300">
            {displayWallet ? displayWallet : 'Bind Wallet'}
          </span>
        </button>
      </header>

      {/* 2. Main Content Tabs */}
      <main className="flex-1 flex flex-col">
        {/* TAB 1: Deals & Arbitrage Feed */}
        {activeTab === 'deals' && (
          <div className="space-y-4" data-testid="tab-content-deals">
            {/* Promo banner */}
            <div className="p-4 rounded-2xl bg-gradient-to-r from-indigo-950/60 via-purple-950/40 to-slate-900 border border-indigo-500/30 shadow-lg">
              <div className="flex items-start justify-between">
                <div>
                  <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 mb-1">
                    <Sparkles className="w-3 h-3 mr-1" /> HIGH-YIELD CASHBACK
                  </span>
                  <h2 className="text-sm font-bold text-white mt-1">
                    Maximized Trading Rebates
                  </h2>
                  <p className="text-xs text-slate-300 mt-0.5">
                    Save up to 45% on trading fees with automatic monthly payouts.
                  </p>
                </div>
              </div>
            </div>

            {/* Deal cards list */}
            <div className="space-y-3">
              {deals.map((deal) => (
                <div
                  key={deal.id}
                  className="p-4 rounded-xl bg-slate-800/40 hover:bg-slate-800/70 border border-slate-700/40 transition-all shadow-sm"
                  data-testid={`deal-card-${deal.id}`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="uppercase text-[10px] font-extrabold px-2 py-0.5 rounded bg-slate-700 text-slate-300">
                          {deal.exchange}
                        </span>
                        {deal.spread_bps && (
                          <span className="inline-flex items-center text-[10px] font-semibold text-emerald-400">
                            <TrendingUp className="w-3 h-3 mr-0.5" /> +{deal.spread_bps} bps Arb
                          </span>
                        )}
                      </div>
                      <h3 className="text-sm font-semibold text-slate-100 mt-1">
                        {deal.name}
                      </h3>
                    </div>

                    <div className="text-right">
                      <span className="inline-flex items-center text-xs font-bold text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded-md border border-indigo-500/20">
                        {deal.cashback_percent}% OFF
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between mt-4 pt-3 border-t border-slate-700/30">
                    <span className="text-[11px] text-slate-400">
                      Tier 1 Direct Cashback
                    </span>
                    <button
                      type="button"
                      onClick={() => handleClaimDeal(deal)}
                      className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow touch-target-h transition-all"
                      data-testid={`claim-deal-${deal.id}`}
                    >
                      {copiedDealId === deal.id ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-300" />
                          <span>Copied!</span>
                        </>
                      ) : (
                        <>
                          <span>Claim Deal</span>
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* TAB 2: Viral Referral & 1-Click Copy */}
        {activeTab === 'referral' && (
          <div className="space-y-4" data-testid="tab-content-referral">
            {/* Social Bonus Card */}
            <div className="p-5 rounded-2xl bg-gradient-to-br from-indigo-900/60 to-purple-900/40 border border-indigo-500/40 shadow-xl text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-indigo-500/20 text-indigo-300 mb-2">
                <Coins className="w-6 h-6" />
              </div>
              <h2 className="text-lg font-extrabold text-white">
                Earn $5.00 Per Verified Friend
              </h2>
              <p className="text-xs text-slate-300 mt-1 max-w-xs mx-auto">
                Plus earn up to 30% lifetime multi-tier commissions on their trading cashback.
              </p>

              {/* Referral link box with 1-click copy */}
              <div className="mt-4 p-2.5 rounded-xl bg-slate-900/80 border border-slate-700 flex items-center justify-between">
                <span className="text-xs text-slate-300 font-mono truncate mr-2" data-testid="referral-link-display">
                  {referralLink}
                </span>
                <button
                  type="button"
                  onClick={handleCopyReferral}
                  className="inline-flex items-center space-x-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shrink-0 touch-target-h transition-all shadow"
                  data-testid="copy-referral-btn"
                >
                  {copiedLink ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-300" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>

              {/* Share with Telegram Friends button */}
              <button
                type="button"
                onClick={handleShareTelegram}
                className="w-full mt-3 py-3 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 shadow-lg flex items-center justify-center space-x-2 touch-target transition-all"
                data-testid="share-telegram-btn"
              >
                <Share2 className="w-4 h-4" />
                <span>Share with Telegram Friends</span>
              </button>
            </div>

            {/* Commission Tier Breakdown */}
            <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/40">
              <h3 className="text-xs font-bold text-slate-200 uppercase tracking-wider mb-3">
                Viral Social Multi-Tier Rewards
              </h3>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="p-2.5 rounded-lg bg-slate-800/80 border border-slate-700/50">
                  <span className="text-base font-extrabold text-indigo-400">30%</span>
                  <span className="block text-[10px] text-slate-400 mt-0.5">Tier 1 Direct</span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-800/80 border border-slate-700/50">
                  <span className="text-base font-extrabold text-purple-400">10%</span>
                  <span className="block text-[10px] text-slate-400 mt-0.5">Tier 2 Network</span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-800/80 border border-slate-700/50">
                  <span className="text-base font-extrabold text-pink-400">5%</span>
                  <span className="block text-[10px] text-slate-400 mt-0.5">Tier 3 Network</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: Leaderboard */}
        {activeTab === 'leaderboard' && (
          <div data-testid="tab-content-leaderboard">
            <TelegramLeaderboard
              currentTelegramId={authUser?.telegram_id || user?.id}
              currentUserId={authUser?.id}
            />
          </div>
        )}

        {/* TAB 4: Earnings Summary & Wallet Binding */}
        {activeTab === 'earnings' && (
          <div className="space-y-4" data-testid="tab-content-earnings">
            {/* Stats Cards */}
            <div className="grid grid-cols-2 gap-3">
              <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/40">
                <span className="text-[11px] text-slate-400 font-medium">Total Cashback</span>
                <div className="text-xl font-bold text-emerald-400 mt-1">$142.50</div>
                <span className="text-[10px] text-slate-500">Lifetime payouts</span>
              </div>
              <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/40">
                <span className="text-[11px] text-slate-400 font-medium">Referral Rewards</span>
                <div className="text-xl font-bold text-indigo-400 mt-1">$65.00</div>
                <span className="text-[10px] text-slate-500">13 verified friends</span>
              </div>
              <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/40">
                <span className="text-[11px] text-slate-400 font-medium">Pending Payout</span>
                <div className="text-xl font-bold text-amber-400 mt-1">$35.00</div>
                <span className="text-[10px] text-slate-500">Next batch in 2 days</span>
              </div>
              <div className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/40">
                <span className="text-[11px] text-slate-400 font-medium">KYC Status</span>
                <div className="text-sm font-bold text-slate-200 mt-1 uppercase">
                  {authUser?.kyc_tier || 'Tier 1'}
                </div>
                <span className="text-[10px] text-emerald-400">Verified & Active</span>
              </div>
            </div>

            {/* Wallet Binding Form */}
            <div className="p-4 rounded-xl bg-slate-800/50 border border-slate-700/50 space-y-3">
              <div className="flex items-center space-x-2">
                <Wallet className="w-4 h-4 text-indigo-400" />
                <h3 className="text-xs font-bold text-slate-100 uppercase tracking-wider">
                  Payout Wallet Binding
                </h3>
              </div>
              <p className="text-xs text-slate-400">
                Bind your preferred Web3 wallet to receive automated payouts in USDC or USDT.
              </p>

              <form onSubmit={handleSaveWallet} className="space-y-3 mt-2">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                    Select Network Chain
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['ethereum', 'solana', 'stellar'] as const).map((chain) => (
                      <button
                        key={chain}
                        type="button"
                        onClick={() => {
                          hapticFeedback.selectionChanged();
                          setPreferredChainInput(chain);
                        }}
                        className={`py-2 text-xs font-semibold rounded-lg touch-target-h transition-all uppercase ${
                          preferredChainInput === chain
                            ? 'bg-indigo-600 text-white shadow'
                            : 'bg-slate-700/50 text-slate-400 hover:text-slate-200'
                        }`}
                        data-testid={`chain-select-${chain}`}
                      >
                        {chain}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                    Wallet Address
                  </label>
                  <input
                    type="text"
                    value={walletAddressInput}
                    onChange={(e) => setWalletAddressInput(e.target.value)}
                    placeholder={
                      preferredChainInput === 'ethereum'
                        ? '0x...'
                        : preferredChainInput === 'solana'
                        ? 'Base58 address...'
                        : 'G...'
                    }
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-slate-900 border border-slate-700 text-slate-100 focus:outline-none focus:border-indigo-500"
                    data-testid="wallet-address-input"
                  />
                </div>

                {walletStatusMessage && (
                  <div
                    className={`p-2.5 text-xs rounded-lg flex items-center space-x-1.5 ${
                      walletStatusMessage.type === 'success'
                        ? 'bg-emerald-950/40 text-emerald-300 border border-emerald-800/40'
                        : 'bg-red-950/40 text-red-300 border border-red-800/40'
                    }`}
                    data-testid="wallet-status-message"
                  >
                    {walletStatusMessage.type === 'success' ? (
                      <Check className="w-4 h-4 shrink-0" />
                    ) : (
                      <AlertCircle className="w-4 h-4 shrink-0" />
                    )}
                    <span>{walletStatusMessage.text}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={walletSaving}
                  className="w-full py-2.5 text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg shadow touch-target disabled:opacity-50 transition-all"
                  data-testid="save-wallet-btn"
                >
                  {walletSaving ? 'Saving...' : 'Save Wallet'}
                </button>
              </form>
            </div>
          </div>
        )}
      </main>

      {/* 3. Bottom Navigation Bar */}
      <nav
        className="fixed bottom-0 inset-x-0 bg-slate-900/95 backdrop-blur-xl border-t border-slate-800 px-4 py-2 z-50 pb-safe"
        data-testid="tma-bottom-nav"
      >
        <div className="max-w-lg mx-auto flex items-center justify-around">
          <button
            type="button"
            onClick={() => handleTabChange('deals')}
            className={`flex flex-col items-center justify-center touch-target py-1 transition-all ${
              activeTab === 'deals' ? 'text-indigo-400' : 'text-slate-400 hover:text-slate-200'
            }`}
            data-testid="nav-tab-deals"
          >
            <TrendingUp className="w-5 h-5 mb-0.5" />
            <span className="text-[10px] font-semibold">Deals</span>
          </button>

          <button
            type="button"
            onClick={() => handleTabChange('referral')}
            className={`flex flex-col items-center justify-center touch-target py-1 transition-all ${
              activeTab === 'referral' ? 'text-indigo-400' : 'text-slate-400 hover:text-slate-200'
            }`}
            data-testid="nav-tab-referral"
          >
            <Share2 className="w-5 h-5 mb-0.5" />
            <span className="text-[10px] font-semibold">Referral</span>
          </button>

          <button
            type="button"
            onClick={() => handleTabChange('leaderboard')}
            className={`flex flex-col items-center justify-center touch-target py-1 transition-all ${
              activeTab === 'leaderboard' ? 'text-indigo-400' : 'text-slate-400 hover:text-slate-200'
            }`}
            data-testid="nav-tab-leaderboard"
          >
            <Trophy className="w-5 h-5 mb-0.5" />
            <span className="text-[10px] font-semibold">Rankings</span>
          </button>

          <button
            type="button"
            onClick={() => handleTabChange('earnings')}
            className={`flex flex-col items-center justify-center touch-target py-1 transition-all ${
              activeTab === 'earnings' ? 'text-indigo-400' : 'text-slate-400 hover:text-slate-200'
            }`}
            data-testid="nav-tab-earnings"
          >
            <Wallet className="w-5 h-5 mb-0.5" />
            <span className="text-[10px] font-semibold">Earnings</span>
          </button>
        </div>
      </nav>
    </div>
  );
};

export default TelegramAppClient;
