'use client'

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { DollarSign, Users, TrendingUp, ShoppingCart, Copy, Check, ChevronRight, User } from 'lucide-react';

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
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-500">{title}</p>
          <p className="mt-2 text-3xl font-bold text-gray-900">{value}</p>
          {subtitle && <p className="mt-1 text-sm text-gray-400">{subtitle}</p>}
          {trend && trendValue && (
            <p className={`mt-2 text-sm ${trend === 'up' ? 'text-green-600' : trend === 'down' ? 'text-red-600' : 'text-gray-500'}`}>
              {trend === 'up' ? '↑' : trend === 'down' ? '↓' : '•'} {trendValue}
            </p>
          )}
        </div>
        <div className="p-3 bg-gradient-to-br from-indigo-50 to-purple-50 rounded-lg">
          {icon}
        </div>
      </div>
    </div>
  )
}

function CommissionTiers() {
  const t = useTranslations('affiliates.tiers');

  const tiers = [
    { name: t('tier1.name'), desc: t('tier1.description'), rate: t('tier1.rate'), icon: '👥', color: 'from-green-400 to-green-600' },
    { name: t('tier2.name'), desc: t('tier2.description'), rate: t('tier2.rate'), icon: '👤', color: 'from-blue-400 to-blue-600' },
    { name: t('tier3.name'), desc: t('tier3.description'), rate: t('tier3.rate'), icon: '⭐', color: 'from-purple-400 to-purple-600' },
  ];

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-2">{t('title')}</h3>
      <p className="text-sm text-gray-500 mb-4">{t('subtitle')}</p>
      <div className="space-y-3">
        {tiers.map((tier, idx) => (
          <div key={idx} className="flex items-center gap-4 p-4 rounded-lg bg-gradient-to-r from-gray-50 to-gray-100 border border-gray-200">
            <div className="text-3xl">{tier.icon}</div>
            <div className="flex-1">
              <h4 className="font-semibold text-gray-900">{tier.name}</h4>
              <p className="text-sm text-gray-500">{tier.desc}</p>
            </div>
            <div className={`text-2xl font-bold bg-gradient-to-r ${tier.color} bg-clip-text text-transparent`}>
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
    'bg-indigo-50 border-indigo-200',
    'bg-blue-50 border-blue-200',
    'bg-purple-50 border-purple-200',
  ];

  return (
    <div className="select-none">
      <div
        className={`flex items-center gap-3 p-3 rounded-lg border ${levelColors[depth % 3]} mb-2 cursor-pointer hover:shadow-sm transition-shadow`}
        style={{ marginLeft: `${depth * 24}px` }}
        onClick={() => hasChildren && onExpand(node.affiliate_id)}
      >
        {hasChildren ? (
          <ChevronRight className={`w-4 h-4 text-gray-600 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
        ) : (
          <User className="w-4 h-4 text-gray-400" />
        )}
        <div className="flex-1 min-w-0">
          <p className="font-medium text-gray-900 truncate">
            {node.full_name || node.email.split('@')[0]}
          </p>
          <p className="text-xs text-gray-500 truncate">{node.email}</p>
        </div>
        <div className="text-right">
          <p className="font-semibold text-gray-900">${node.total_earnings.toFixed(2)}</p>
          <p className="text-xs text-gray-500">{node.total_conversions} {t('conversions', { count: node.total_conversions })}</p>
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
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center">
        <Users className="w-16 h-16 text-gray-300 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-900 mb-2">{t('empty')}</h3>
        <p className="text-gray-500">{t('subtitle')}</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">{t('title')}</h3>
          <p className="text-sm text-gray-500">{t('subtitle')}</p>
        </div>
        <button
          onClick={toggleAll}
          className="px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
        >
          {expandedNodes.size > 0 ? t('collapseAll') : t('expandAll')}
        </button>
      </div>

      {/* Root Node */}
      <div className="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-lg p-4 mb-4 border border-indigo-200">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-semibold">
            {treeData.root.full_name?.charAt(0) || treeData.root.email.charAt(0).toUpperCase()}
          </div>
          <div>
            <p className="font-semibold text-gray-900">{treeData.root.full_name || 'You'}</p>
            <p className="text-sm text-gray-500">{t('level', { level: 0 })} — {t('direct')}</p>
          </div>
          <div className="ml-auto text-right">
            <p className="font-bold text-gray-900">${treeData.root.total_earnings.toFixed(2)}</p>
            <p className="text-xs text-gray-500">{treeData.root.total_conversions} {t('conversions', { count: treeData.root.total_conversions })}</p>
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

      <div className="mt-4 pt-4 border-t border-gray-200 text-center text-sm text-gray-500">
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
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-2">{t('title')}</h3>
      <p className="text-sm text-gray-500 mb-6">{t('subtitle')}</p>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">{t('yourCode')}</label>
          <div className="flex gap-2">
            <div className="flex-1 px-4 py-3 bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-200 rounded-lg font-mono text-lg font-bold text-indigo-900 text-center">
              {code}
            </div>
            <button
              onClick={() => copyToClipboard(code, 'code')}
              className="px-4 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-medium flex items-center gap-2"
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
          <label className="block text-sm font-medium text-gray-700 mb-2">{t('shareLink')}</label>
          <div className="flex gap-2">
            <div className="flex-1 px-4 py-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600 truncate">
              {shareLink}
            </div>
            <button
              onClick={() => copyToClipboard(shareLink, 'link')}
              className="px-4 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors font-medium"
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
    pending: 'bg-yellow-100 text-yellow-800',
    processing: 'bg-blue-100 text-blue-800',
    completed: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
    cancelled: 'bg-gray-100 text-gray-800',
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (payouts.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center">
        <DollarSign className="w-16 h-16 text-gray-300 mx-auto mb-4" />
        <p className="text-gray-500">{t('empty')}</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-6">{t('title')}</h3>

      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead>
            <tr className="text-left text-sm font-medium text-gray-500 border-b border-gray-200">
              <th className="pb-3">{t('columns.date')}</th>
              <th className="pb-3 text-right">{t('columns.amount')}</th>
              <th className="pb-3 text-right">{t('columns.netAmount')}</th>
              <th className="pb-3">{t('columns.status')}</th>
              <th className="pb-3">{t('columns.transactionId')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {payouts.map(payout => (
              <tr key={payout.id} className="text-sm">
                <td className="py-4 text-gray-900">{formatDate(payout.paid_at || payout.scheduled_at)}</td>
                <td className="py-4 font-medium text-gray-900 text-right">${payout.amount.toFixed(2)}</td>
                <td className="py-4 text-gray-600 text-right">${payout.net_amount.toFixed(2)}</td>
                <td className="py-4">
                  <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${statusColors[payout.status] || 'bg-gray-100 text-gray-800'}`}>
                    {t(`status.${payout.status}`, { fallback: payout.status })}
                  </span>
                </td>
                <td className="py-4 font-mono text-gray-600">
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
      icon: <DollarSign className="w-6 h-6 text-green-600" />
    },
    {
      key: 'pending_earnings',
      title: t('stats.pendingEarnings'),
      format: formatCurrency,
      subtitle: t('stats.thisMonth'),
      icon: <TrendingUp className="w-6 h-6 text-blue-600" />
    },
    {
      key: 'total_referrals',
      title: t('stats.totalReferrals'),
      format: formatNumber,
      icon: <Users className="w-6 h-6 text-purple-600" />
    },
    {
      key: 'conversion_rate',
      title: t('stats.conversionRate'),
      format: formatPercent,
      icon: <ShoppingCart className="w-6 h-6 text-orange-600" />
    },
  ];

  const stats = data.stats as typeof data.stats & Record<string, number>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900">{t('title')}</h1>
        <p className="text-gray-500 mt-2">{t('subtitle')}</p>
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
