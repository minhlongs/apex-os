/**
 * ApexOS Icon Type Definitions
 * TypeScript support cho icon system
 */

// Navigation icons
export const NAVIGATION_ICONS = [
  'dashboard',
  'deals',
  'affiliates',
  'payouts',
  'profile',
  'settings',
  'analytics',
  'health',
  'alerts'
] as const;

// Action icons
export const ACTION_ICONS = [
  'add',
  'edit',
  'delete',
  'save',
  'cancel',
  'confirm',
  'refresh',
  'download',
  'upload',
  'share',
  'copy',
  'search',
  'filter',
  'sort'
] as const;

// Status icons
export const STATUS_ICONS = [
  'success',
  'warning',
  'error',
  'info',
  'loading',
  'pending',
  'active',
  'inactive'
] as const;

// Crypto icons
export const CRYPTO_ICONS = [
  'wallet',
  'coin',
  'chart',
  'transaction',
  'exchange',
  'stellar',
  'usdc',
  'blockchain'
] as const;

// Communication icons
export const COMMUNICATION_ICONS = [
  'email',
  'slack',
  'telegram',
  'webhook',
  'notification',
  'bell',
  'message'
] as const;

// Affiliate icons
export const AFFILIATE_ICONS = [
  'users',
  'user-plus',
  'link',
  'referral',
  'tree',
  'commission',
  'earnings',
  'payout'
] as const;

// Tất cả icons
export const ALL_ICONS = [
  ...NAVIGATION_ICONS,
  ...ACTION_ICONS,
  ...STATUS_ICONS,
  ...CRYPTO_ICONS,
  ...COMMUNICATION_ICONS,
  ...AFFILIATE_ICONS
] as const;

// Icon size types
export type IconSize = 'sm' | 'md' | 'lg' | 'xl';

// Icon name type (union của tất cả icon names)
export type IconName = typeof ALL_ICONS[number];

// Icon props interface
export interface IconProps {
  /** Tên icon */
  name: IconName;
  /** Kích thước icon */
  size?: IconSize;
  /** CSS class bổ sung */
  className?: string;
  /** Màu icon (override default) */
  color?: string;
  /** Aria label cho accessibility */
  ariaLabel?: string;
}

// Category types
export type IconCategory =
  | 'navigation'
  | 'action'
  | 'status'
  | 'crypto'
  | 'communication'
  | 'affiliate';

// Icon metadata
export interface IconMeta {
  name: IconName;
  category: IconCategory;
  description: string;
}

// Metadata cho từng icon
export const ICON_METADATA: Record<IconName, IconMeta> = {
  // Navigation
  dashboard: { name: 'dashboard', category: 'navigation', description: 'Dashboard icon' },
  deals: { name: 'deals', category: 'navigation', description: 'Deals icon' },
  affiliates: { name: 'affiliates', category: 'navigation', description: 'Affiliates icon' },
  payouts: { name: 'payouts', category: 'navigation', description: 'Payouts icon' },
  profile: { name: 'profile', category: 'navigation', description: 'Profile icon' },
  settings: { name: 'settings', category: 'navigation', description: 'Settings icon' },
  analytics: { name: 'analytics', category: 'navigation', description: 'Analytics icon' },
  health: { name: 'health', category: 'navigation', description: 'Health icon' },
  alerts: { name: 'alerts', category: 'navigation', description: 'Alerts icon' },

  // Actions
  add: { name: 'add', category: 'action', description: 'Add icon' },
  edit: { name: 'edit', category: 'action', description: 'Edit icon' },
  delete: { name: 'delete', category: 'action', description: 'Delete icon' },
  save: { name: 'save', category: 'action', description: 'Save icon' },
  cancel: { name: 'cancel', category: 'action', description: 'Cancel icon' },
  confirm: { name: 'confirm', category: 'action', description: 'Confirm icon' },
  refresh: { name: 'refresh', category: 'action', description: 'Refresh icon' },
  download: { name: 'download', category: 'action', description: 'Download icon' },
  upload: { name: 'upload', category: 'action', description: 'Upload icon' },
  share: { name: 'share', category: 'action', description: 'Share icon' },
  copy: { name: 'copy', category: 'action', description: 'Copy icon' },
  search: { name: 'search', category: 'action', description: 'Search icon' },
  filter: { name: 'filter', category: 'action', description: 'Filter icon' },
  sort: { name: 'sort', category: 'action', description: 'Sort icon' },

  // Status
  success: { name: 'success', category: 'status', description: 'Success status' },
  warning: { name: 'warning', category: 'status', description: 'Warning status' },
  error: { name: 'error', category: 'status', description: 'Error status' },
  info: { name: 'info', category: 'status', description: 'Info status' },
  loading: { name: 'loading', category: 'status', description: 'Loading status' },
  pending: { name: 'pending', category: 'status', description: 'Pending status' },
  active: { name: 'active', category: 'status', description: 'Active status' },
  inactive: { name: 'inactive', category: 'status', description: 'Inactive status' },

  // Crypto
  wallet: { name: 'wallet', category: 'crypto', description: 'Wallet icon' },
  coin: { name: 'coin', category: 'crypto', description: 'Coin icon' },
  chart: { name: 'chart', category: 'crypto', description: 'Chart icon' },
  transaction: { name: 'transaction', category: 'crypto', description: 'Transaction icon' },
  exchange: { name: 'exchange', category: 'crypto', description: 'Exchange icon' },
  stellar: { name: 'stellar', category: 'crypto', description: 'Stellar icon' },
  usdc: { name: 'usdc', category: 'crypto', description: 'USDC icon' },
  blockchain: { name: 'blockchain', category: 'crypto', description: 'Blockchain icon' },

  // Communication
  email: { name: 'email', category: 'communication', description: 'Email icon' },
  slack: { name: 'slack', category: 'communication', description: 'Slack icon' },
  telegram: { name: 'telegram', category: 'communication', description: 'Telegram icon' },
  webhook: { name: 'webhook', category: 'communication', description: 'Webhook icon' },
  notification: { name: 'notification', category: 'communication', description: 'Notification icon' },
  bell: { name: 'bell', category: 'communication', description: 'Bell icon' },
  message: { name: 'message', category: 'communication', description: 'Message icon' },

  // Affiliate
  users: { name: 'users', category: 'affiliate', description: 'Users icon' },
  'user-plus': { name: 'user-plus', category: 'affiliate', description: 'User plus icon' },
  link: { name: 'link', category: 'affiliate', description: 'Link icon' },
  referral: { name: 'referral', category: 'affiliate', description: 'Referral icon' },
  tree: { name: 'tree', category: 'affiliate', description: 'Tree icon' },
  commission: { name: 'commission', category: 'affiliate', description: 'Commission icon' },
  earnings: { name: 'earnings', category: 'affiliate', description: 'Earnings icon' },
  payout: { name: 'payout', category: 'affiliate', description: 'Payout icon' }
};

// Helper function: lấy icons theo category
export function getIconsByCategory(category: IconCategory): IconName[] {
  return ALL_ICONS.filter(name => ICON_METADATA[name].category === category);
}

// Helper function: validate icon name
export function isValidIcon(name: string): name is IconName {
  return ALL_ICONS.includes(name as IconName);
}

// CSS class name generator
export function getIconClassName(
  name: IconName,
  size?: IconSize,
  extraClass?: string
): string {
  const className = `icon icon-${name}`;
  const sizeClass = size ? `icon-${size}` : '';
  return [className, sizeClass, extraClass].filter(Boolean).join(' ');
}
