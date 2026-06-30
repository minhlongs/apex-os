'use client';

import { useState } from 'react';
import { ExternalLink, Clock, CheckCircle, UserPlus } from 'lucide-react';

interface RecentActivity {
  id: string;
  type: 'conversion' | 'click' | 'payout' | 'affiliate_signup';
  dealName?: string;
  affiliateEmail?: string;
  affiliateName?: string;
  amount?: number;
  status: 'approved' | 'pending' | 'rejected' | 'completed' | 'failed';
  timestamp: string;
  metadata?: {
    exchange?: string;
    wallet_address?: string;
    order_id?: string;
  };
}

interface RecentActivityTableProps {
  activities: RecentActivity[];
  title?: string;
  maxItems?: number;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function getTypeIcon(type: RecentActivity['type']) {
  switch (type) {
    case 'conversion':
      return <CheckCircle className="w-4 h-4 text-green-500" />;
    case 'click':
      return <ExternalLink className="w-4 h-4 text-blue-500" />;
    case 'payout':
      return <CheckCircle className="w-4 h-4 text-purple-500" />;
    case 'affiliate_signup':
      return <UserPlus className="w-4 h-4 text-orange-500" />;
    default:
      return <Clock className="w-4 h-4 text-gray-500" />;
  }
}

function getStatusBadge(status: RecentActivity['status']) {
  const styles = {
    approved: 'bg-green-100 text-green-800',
    pending: 'bg-yellow-100 text-yellow-800',
    rejected: 'bg-red-100 text-red-800',
    completed: 'bg-blue-100 text-blue-800',
    failed: 'bg-red-100 text-red-800',
  };

  return (
    <span className={`px-2 py-1 text-xs font-medium rounded-full ${styles[status]}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

export default function RecentActivityTable({
  activities,
  title = 'Recent Activity',
  maxItems = 10
}: RecentActivityTableProps) {
  const displayActivities = activities.slice(0, maxItems);

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="px-6 py-4 border-b border-gray-200">
        <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
        <p className="text-sm text-gray-500 mt-1">
          Latest activity across the platform
        </p>
      </div>

      <div className="divide-y divide-gray-200">
        {displayActivities.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <Clock className="w-12 h-12 mx-auto mb-3 text-gray-300" />
            <p>No recent activity</p>
          </div>
        ) : (
          displayActivities.map((activity) => (
            <div key={activity.id} className="p-4 hover:bg-gray-50 transition-colors">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <div className="mt-1">{getTypeIcon(activity.type)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-gray-900">
                        {activity.type === 'conversion' && 'New Conversion'}
                        {activity.type === 'click' && 'Deal Click'}
                        {activity.type === 'payout' && 'Payout Processed'}
                        {activity.type === 'affiliate_signup' && 'New Affiliate'}
                      </span>
                      {activity.dealName && (
                        <span className="text-gray-600">— {activity.dealName}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-sm text-gray-500 flex-wrap">
                      {activity.affiliateEmail && (
                        <span>{activity.affiliateEmail}</span>
                      )}
                      {activity.metadata?.exchange && (
                        <span className="capitalize">via {activity.metadata.exchange}</span>
                      )}
                      {activity.metadata?.order_id && (
                        <span className="font-mono text-xs">Order: {activity.metadata.order_id.slice(-8)}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  {activity.amount && (
                    <span className={`font-semibold ${
                      activity.amount > 0 ? 'text-green-600' : 'text-gray-900'
                    }`}>
                      {formatCurrency(activity.amount)}
                    </span>
                  )}
                  {getStatusBadge(activity.status)}
                  <span className="text-xs text-gray-400 whitespace-nowrap">
                    {formatTimeAgo(activity.timestamp)}
                  </span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {activities.length > maxItems && (
        <div className="px-6 py-3 border-t border-gray-200 bg-gray-50">
          <button className="text-sm text-blue-600 hover:text-blue-700 font-medium">
            View all {activities.length} activities →
          </button>
        </div>
      )}
    </div>
  );
}
