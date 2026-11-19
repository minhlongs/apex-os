'use client'

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { DollarSign, Users, TrendingUp, ShoppingCart, Copy, Check, ChevronRight, User, Percent, Building2, Lock } from 'lucide-react';

interface AffiliateProfile {
  id: string;
  email: string;
  full_name: string | null;
  role: string;
  referral_code: string;
  is_affiliate: boolean;
}

interface AffiliateStats {
  lifetime_earnings: number;
  pending_earnings: number;
  lifetime_payouts: number;
  total_conversions: number;
  total_clicks: number;
  conversion_rate: number;
  direct_referrals: number;
  indirect_referrals: number;
  total_referrals: number;
  total_revenue: number;
}

interface ReferralChild {
  affiliate_id: string;
  email: string;
  full_name: string | null;
  level: number;
  display_level: number;
  total_earnings: number;
  total_conversions: number;
  conversion_rate: number;
  children: ReferralChild[];
}

interface ReferralTreeData {
  root: {
    affiliate_id: string;
    email: string;
    full_name: string | null;
    level: number;
    children: ReferralChild[];
    total_earnings: number;
    total_conversions: number;
    conversion_rate: number;
  } | null;
  total_nodes: number;
}

interface PayoutRecord {
  id: string;
  amount: number;
  net_amount: number;
  status: string;
  scheduled_at: string | null;
  paid_at: string | null;
  transaction_id: string | null;
}

interface AffiliateDashboardData {
  profile: AffiliateProfile;
  stats: AffiliateStats;
  share_link: string;
  referral_tree: ReferralTreeData;
  recent_payouts: PayoutRecord[];
}

interface StatsCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ReactNode;
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
}

function StatsCard({ title, value, subtitle, icon, trend, trendValue }: StatsCardProps) {
  return (
    <div className="bg-stitch-surface rounded-2xl border border-stitch-border p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-stitch-muted">{title}</p>
          <p className="mt-2 text-3xl font-bold font-mono text-stitch-primary">{value}</p>
          {subtitle && <p className="mt-1 text-sm text-stitch-muted">{subtitle}</p>}
          {trend && trendValue && (
            <p className={`mt-2 text-sm ${trend === 'up' ? 'text-stitch-emerald' : trend === 'down' ? 'text-stitch-crimson' : 'text-stitch-muted'}`}>
              {trend === 'up' ? '↑' : trend === 'down' ? '↓' : '•'} {trendValue}
            </p>
          )}
        </div>
        <div className="p-3 bg-stitch-well rounded-xl">
          {icon}
        </div>
      </div>
    </div>
  )
}

function CommissionTiers() {
  const t = useTranslations('affiliates.tiers');

  const tiers = [
    {
      name: t('traderRebate.name'),
      desc: t('traderRebate.description'),
      rate: t('traderRebate.rate'),
      icon: <Percent className="w-6 h-6 text-stitch-emerald" />,
      color: 'from-emerald-400 to-emerald-600',
    },
    {
      name: t('tier1.name'),
      desc: t('tier1.description'),
      rate: t('tier1.rate'),
      icon: <Users className="w-6 h-6 text-stitch-cyan" />,
      color: 'from-cyan-400 to-indigo-500',
    },
    {
      name: t('tier2.name'),
      desc: t('tier2.description'),
      rate: t('tier2.rate'),
      icon: <Building2 className="w-6 h-6 text-stitch-indigo" />,
      color: 'from-indigo-400 to-violet-500',
    },
    {
      name: t('tier3.name'),
      desc: t('tier3.description'),
      rate: t('tier3.rate'),
      icon: <Lock className="w-6 h-6 text-stitch-muted" />,
      color: 'from-slate-400 to-slate-500',
    },
  ];

  return (
    <div className="bg-stitch-surface rounded-2xl border border-stitch-border p-6">
      <h3 className="text-lg font-semibold text-stitch-primary mb-2">{t('title')}</h3>
      <p className="text-sm text-stitch-muted mb-4">{t('subtitle')}</p>
      <div className="space-y-3">
        {tiers.map((tier, idx) => (
          <div key={idx} className="flex items-center gap-4 p-4 rounded-xl bg-stitch-canvas border border-stitch-border">
            <div className="p-2.5 bg-stitch-well rounded-xl shrink-0">{tier.icon}</div>
            <div className="flex-1 min-w-0">
              <h4 className="font-semibold text-stitch-primary">{tier.name}</h4>
              <p className="text-sm text-stitch-muted">{tier.desc}</p>
            </div>
            <div className={`text-xl font-bold font-mono bg-gradient-to-r ${tier.color} bg-clip-text text-transparent shrink-0`}>
              {tier.rate}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ReferralTreeNodeProps {
  node: ReferralChild;
  onExpand: (id: string) => void;
  expandedNodes: Set<string>;
  depth: number;
}

function ReferralTreeNode({ node, onExpand, expandedNodes, depth = 0 }: ReferralTreeNodeProps) {
  const t = useTranslations('affiliates.referralTree');
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedNodes.has(node.affiliate_id);

  const levelColors = [
    'bg-stitch-indigo/10 border-stitch-indigo/30',
    'bg-stitch-cyan/10 border-stitch-cyan/30',
    'bg-stitch-violet/10 border-stitch-violet/30',
  ];

  return (
    <div className="select-none">
      <div
        className={`flex items-center gap-3 p-3 rounded-lg border ${levelColors[depth % 3]} mb-2 cursor-pointer hover:bg-stitch-well/50 transition-colors`}
        style={{ marginLeft: `${depth * 24}px` }}
        onClick={() => hasChildren && onExpand(node.affiliate_id)}
      >
        {hasChildren ? (
          <ChevronRight className={`w-4 h-4 text-stitch-muted transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
        ) : (
          <User className="w-4 h-4 text-stitch-muted" />
        )}
        <div className="flex-1 min-w-0">
          <p className="font-medium text-stitch-primary truncate">
            {node.full_name || node.email.split('@')[0]}
          </p>
          <p className="text-xs text-stitch-muted truncate">{node.email}</p>
        </div>
        <div className="text-right">
          <p className="font-semibold font-mono text-stitch-primary">${node.total_earnings.toFixed(2)}</p>
          <p className="text-xs text-stitch-muted">{node.total_conversions} {t('conversions', { count: node.total_conversions })}</p>
        </div>
      </div>
      {hasChildren && isExpanded && (
        <div>
          {node.children.map(child => (
            <ReferralTreeNode
              key={child.affiliate_id}
              node={child}
              onExpand={onExpand}
              expandedNodes={expandedNodes}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ReferralTreeProps {
  treeData: ReferralTreeData;
}

function ReferralTree({ treeData }: ReferralTreeProps) {
  const t = useTranslations('affiliates.referralTree');
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set([treeData.root?.affiliate_id || '']));

  const toggleExpand = (id: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (expandedNodes.size > 0) {
      setExpandedNodes(new Set());
    } else {
      const allNodeIds = new Set<string>();
      const collectIds = (node: typeof treeData.root) => {
        if (!node) return;
        allNodeIds.add(node.affiliate_id);
        node.children.forEach(collectIds);
      };
      collectIds(treeData.root);
      setExpandedNodes(allNodeIds);
    }
  };

  if (!treeData.root) {
    return (
      <div className="bg-stitch-surface rounded-2xl border border-stitch-border p-12 text-center">
        <Users className="w-16 h-16 text-stitch-muted mx-auto mb-4" />
        <h3 className="text-lg font-medium text-stitch-primary mb-2">{t('empty')}</h3>
        <p className="text-stitch-muted">{t('subtitle')}</p>
      </div>
    );
  }

  return (
    <div className="bg-stitch-surface rounded-2xl border border-stitch-border p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-semibold text-stitch-primary">{t('title')}</h3>
          <p className="text-sm text-stitch-muted">{t('subtitle')}</p>
        </div>
        <button
          onClick={toggleAll}
          className="px-3 py-2 text-sm font-medium text-stitch-primary bg-stitch-well rounded-lg hover:bg-stitch-well/80 transition-colors"
        >
          {expandedNodes.size > 0 ? t('collapseAll') : t('expandAll')}
        </button>
      </div>

      {/* Root Node */}
      <div className="bg-stitch-canvas rounded-xl p-4 mb-4 border border-stitch-indigo/30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-stitch-indigo flex items-center justify-center text-white font-semibold">
            {treeData.root.full_name?.charAt(0) || treeData.root.email.charAt(0).toUpperCase()}
          </div>
          <div>
            <p className="font-semibold text-stitch-primary">{treeData.root.full_name || 'You'}</p>
            <p className="text-sm text-stitch-muted">{t('level', { level: 0 })} — {t('direct')}</p>
          </div>
          <div className="ml-auto text-right">
            <p className="font-bold font-mono text-stitch-primary">${treeData.root.total_earnings.toFixed(2)}</p>
            <p className="text-xs text-stitch-muted">{treeData.root.total_conversions} {t('conversions', { count: treeData.root.total_conversions })}</p>
          </div>
        </div>
      </div>

      {/* Children */}
      <div className="space-y-1 max-h-96 overflow-y-auto">
        {treeData.root.children.map((child: ReferralChild) => (
          <ReferralTreeNode
            key={child.affiliate_id}
            node={child}
            onExpand={toggleExpand}
            expandedNodes={expandedNodes}
            depth={0}
          />
        ))}
      </div>

      <div className="mt-4 pt-4 border-t border-stitch-border text-center text-sm text-stitch-muted">
        {t('totalReferrals', { count: treeData.total_nodes - 1 })}
      </div>
    </div>
  );
}

interface CopyAffiliateCodeProps {
  code: string;
  shareLink: string;
}

function CopyAffiliateCode({ code, shareLink }: CopyAffiliateCodeProps) {
  const t = useTranslations('affiliates.code');
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);

  const copyToClipboard = async (text: string, type: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(type);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Ignore clipboard write failures gracefully
    }
  };

  return (
    <div className="bg-stitch-surface rounded-2xl border border-stitch-border p-6">
      <h3 className="text-lg font-semibold text-stitch-primary mb-2">{t('title')}</h3>
      <p className="text-sm text-stitch-muted mb-6">{t('subtitle')}</p>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-stitch-muted mb-2">{t('yourCode')}</label>
          <div className="flex gap-2">
            <div className="flex-1 px-4 py-3 bg-stitch-well border border-stitch-indigo/30 rounded-lg font-mono text-lg font-bold text-stitch-indigo text-center">
              {code}
            </div>
            <button
              onClick={() => copyToClipboard(code, 'code')}
              className="px-4 py-3 bg-stitch-indigo text-white rounded-lg hover:bg-stitch-violet transition-colors font-medium flex items-center gap-2"
            >
              {copied === 'code' ? (
                <>
                  <Check className="w-5 h-5" />
                  {t('copied')}
                </>
              ) : (
                <>
                  <Copy className="w-5 h-5" />
                  {t('copy')}
                </>
              )}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-stitch-muted mb-2">{t('shareLink')}</label>
          <div className="flex gap-2">
            <div className="flex-1 px-4 py-3 bg-stitch-canvas border border-stitch-border rounded-lg text-sm text-stitch-muted truncate font-mono">
              {shareLink}
            </div>
            <button
              onClick={() => copyToClipboard(shareLink, 'link')}
              className="px-4 py-3 bg-stitch-well text-stitch-primary rounded-lg hover:bg-stitch-well/80 transition-colors font-medium border border-stitch-border"
            >
              {copied === 'link' ? t('copied') : t('copy')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface RecentPayoutsProps {
  payouts: PayoutRecord[];
}

function RecentPayouts({ payouts }: RecentPayoutsProps) {
  const t = useTranslations('affiliates.payouts');

  const statusColors: Record<string, string> = {
    pending: 'bg-stitch-amber/15 text-stitch-amber border border-stitch-amber/30',
    processing: 'bg-stitch-cyan/15 text-stitch-cyan border border-stitch-cyan/30',
    completed: 'bg-stitch-emerald/15 text-stitch-emerald border border-stitch-emerald/30',
    failed: 'bg-stitch-crimson/15 text-stitch-crimson border border-stitch-crimson/30',
    cancelled: 'bg-stitch-well text-stitch-muted border border-stitch-border',
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (payouts.length === 0) {
    return (
      <div className="bg-stitch-surface rounded-2xl border border-stitch-border p-12 text-center">
        <DollarSign className="w-16 h-16 text-stitch-muted mx-auto mb-4" />
        <p className="text-stitch-muted">{t('empty')}</p>
      </div>
    );
  }

  return (
    <div className="bg-stitch-surface rounded-2xl border border-stitch-border p-6">
      <h3 className="text-lg font-semibold text-stitch-primary mb-6">{t('title')}</h3>

      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead>
            <tr className="text-left text-sm font-medium text-stitch-muted border-b border-stitch-border">
              <th className="pb-3">{t('columns.date')}</th>
              <th className="pb-3 text-right">{t('columns.amount')}</th>
              <th className="pb-3 text-right">{t('columns.netAmount')}</th>
              <th className="pb-3">{t('columns.status')}</th>
              <th className="pb-3">{t('columns.transactionId')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stitch-border">
            {payouts.map(payout => (
              <tr key={payout.id} className="text-sm">
                <td className="py-4 text-stitch-primary">{formatDate(payout.paid_at || payout.scheduled_at)}</td>
                <td className="py-4 font-mono font-medium text-stitch-primary text-right">${payout.amount.toFixed(2)}</td>
                <td className="py-4 font-mono text-stitch-muted text-right">${payout.net_amount.toFixed(2)}</td>
                <td className="py-4">
                  <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${statusColors[payout.status] || 'bg-stitch-well text-stitch-muted'}`}>
                    {t(`status.${payout.status}`, { fallback: payout.status })}
                  </span>
                </td>
                <td className="py-4 font-mono text-stitch-muted">
                  {payout.transaction_id ? (
                    <span className="truncate block max-w-[150px]" title={payout.transaction_id}>
                      {payout.transaction_id.slice(0, 12)}...
                    </span>
                  ) : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface AffiliatesClientProps {
  initialData: AffiliateDashboardData;
}

export default function AffiliatesClient({ initialData }: AffiliatesClientProps) {
  const t = useTranslations('affiliates');
  const [data] = useState<AffiliateDashboardData>(initialData);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(value);
  };

  const formatNumber = (value: number) => {
    return new Intl.NumberFormat('en-US').format(value);
  };

  const formatPercent = (value: number) => {
    return `${(value * 100).toFixed(1)}%`;
  };

  const statsCards = [
    {
      key: 'lifetime_earnings',
      title: t('stats.lifetimeEarnings'),
      format: formatCurrency,
      icon: <DollarSign className="w-6 h-6 text-stitch-emerald" />
    },
    {
      key: 'pending_earnings',
      title: t('stats.pendingEarnings'),
      format: formatCurrency,
      subtitle: t('stats.thisMonth'),
      icon: <TrendingUp className="w-6 h-6 text-stitch-cyan" />
    },
    {
      key: 'total_referrals',
      title: t('stats.totalReferrals'),
      format: formatNumber,
      icon: <Users className="w-6 h-6 text-stitch-violet" />
    },
    {
      key: 'conversion_rate',
      title: t('stats.conversionRate'),
      format: formatPercent,
      icon: <ShoppingCart className="w-6 h-6 text-stitch-amber" />
    },
  ];

  const stats = data.stats as typeof data.stats & Record<string, number>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-stitch-primary">{t('title')}</h1>
        <p className="text-stitch-muted mt-2">{t('subtitle')}</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {statsCards.map(card => (
          <StatsCard
            key={card.key}
            title={card.title}
            value={card.format(stats[card.key])}
            subtitle={card.subtitle}
            icon={card.icon}
          />
        ))}
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Affiliate Code & Commission Tiers */}
        <div className="lg:col-span-1 space-y-6">
          <CopyAffiliateCode
            code={data.profile.referral_code}
            shareLink={data.share_link}
          />
          <CommissionTiers />
        </div>

        {/* Right Column - Referral Tree */}
        <div className="lg:col-span-2">
          <ReferralTree treeData={data.referral_tree} />
        </div>
      </div>

      {/* Recent Payouts */}
      <div>
        <RecentPayouts payouts={data.recent_payouts} />
      </div>
    </div>
  );
}
