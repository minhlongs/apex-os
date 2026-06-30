'use client'

import React from 'react'

export type IconName =
  // Navigation
  | 'dashboard' | 'deals' | 'affiliates' | 'payouts' | 'profile' | 'settings'
  | 'analytics' | 'health' | 'alerts' | 'logout' | 'menu' | 'close'
  // Actions
  | 'plus' | 'edit' | 'trash' | 'save' | 'x' | 'check' | 'refresh' | 'download'
  | 'upload' | 'share' | 'copy' | 'search' | 'filter' | 'sort' | 'chevron-down'
  | 'chevron-up' | 'chevron-right' | 'more-horizontal' | 'external-link'
  // Status
  | 'check-circle' | 'alert-triangle' | 'x-circle' | 'info' | 'loader'
  | 'clock' | 'activity' | 'shield'
  // Crypto
  | 'wallet' | 'coin' | 'trending-up' | 'arrow-up-right' | 'arrow-down-left'
  | 'repeat' | 'lock' | 'unlock' | 'key' | 'globe'
  // Communication
  | 'mail' | 'message-square' | 'send' | 'bell' | 'bell-off' | 'users'
  | 'user-plus' | 'link'
  // Affiliate
  | 'user' | 'link-2' | 'git-branch' | 'dollar-sign'
  | 'percent' | 'award' | 'target'

export type IconSize = 'sm' | 'md' | 'lg' | 'xl'

export type IconColor =
  | 'primary' | 'secondary' | 'accent' | 'success' | 'warning'
  | 'error' | 'info' | 'muted' | 'inherit'

interface IconProps {
  /** Icon name from the icon set */
  name: IconName
  /** Size of the icon */
  size?: IconSize
  /** Color class (uses CSS variable or currentColor) */
  color?: IconColor
  /** Additional CSS classes */
  className?: string
  /** Accessible label */
  'aria-label'?: string
  /** Click handler */
  onClick?: () => void
}

const sizeMap: Record<IconSize, number> = {
  sm: 16,
  md: 24,
  lg: 32,
  xl: 48,
}

// Map icon names to category and SVG name
const iconCategoryMap: Record<IconName, { category: string; name: string }> = {
  // Navigation
  dashboard: { category: 'navigation', name: 'dashboard' },
  deals: { category: 'navigation', name: 'deals' },
  affiliates: { category: 'navigation', name: 'affiliates' },
  payouts: { category: 'navigation', name: 'payouts' },
  profile: { category: 'navigation', name: 'profile' },
  settings: { category: 'navigation', name: 'settings' },
  analytics: { category: 'navigation', name: 'analytics' },
  health: { category: 'navigation', name: 'health' },
  alerts: { category: 'navigation', name: 'alerts' },
  logout: { category: 'navigation', name: 'logout' },
  menu: { category: 'navigation', name: 'menu' },
  close: { category: 'navigation', name: 'close' },

  // Actions
  plus: { category: 'actions', name: 'plus' },
  edit: { category: 'actions', name: 'edit' },
  trash: { category: 'actions', name: 'trash' },
  save: { category: 'actions', name: 'save' },
  x: { category: 'actions', name: 'x' },
  check: { category: 'actions', name: 'check' },
  refresh: { category: 'actions', name: 'refresh-cw' },
  download: { category: 'actions', name: 'download' },
  upload: { category: 'actions', name: 'upload' },
  share: { category: 'actions', name: 'share' },
  copy: { category: 'actions', name: 'copy' },
  search: { category: 'actions', name: 'search' },
  filter: { category: 'actions', name: 'filter' },
  sort: { category: 'actions', name: 'sort' },
  'chevron-down': { category: 'actions', name: 'chevron-down' },
  'chevron-up': { category: 'actions', name: 'chevron-up' },
  'chevron-right': { category: 'actions', name: 'chevron-right' },
  'more-horizontal': { category: 'actions', name: 'more-horizontal' },
  'external-link': { category: 'actions', name: 'external-link' },

  // Status
  'check-circle': { category: 'status', name: 'check-circle' },
  'alert-triangle': { category: 'status', name: 'alert-triangle' },
  'x-circle': { category: 'status', name: 'x-circle' },
  info: { category: 'status', name: 'info' },
  loader: { category: 'status', name: 'loader' },
  clock: { category: 'status', name: 'clock' },
  activity: { category: 'status', name: 'activity' },
  shield: { category: 'status', name: 'shield' },

  // Crypto
  wallet: { category: 'crypto', name: 'wallet' },
  coin: { category: 'crypto', name: 'coin' },
  'trending-up': { category: 'crypto', name: 'trending-up' },
  'arrow-up-right': { category: 'crypto', name: 'arrow-up-right' },
  'arrow-down-left': { category: 'crypto', name: 'arrow-down-left' },
  repeat: { category: 'crypto', name: 'repeat' },
  lock: { category: 'crypto', name: 'lock' },
  unlock: { category: 'crypto', name: 'unlock' },
  key: { category: 'crypto', name: 'key' },
  globe: { category: 'crypto', name: 'globe' },

  // Communication
  mail: { category: 'communication', name: 'mail' },
  'message-square': { category: 'communication', name: 'message-square' },
  send: { category: 'communication', name: 'send' },
  bell: { category: 'communication', name: 'bell' },
  'bell-off': { category: 'communication', name: 'bell-off' },
  users: { category: 'communication', name: 'users' },
  'user-plus': { category: 'communication', name: 'user-plus' },
  link: { category: 'communication', name: 'link' },

  // Affiliate
  user: { category: 'affiliate', name: 'user' },
  'link-2': { category: 'affiliate', name: 'link-2' },
  'git-branch': { category: 'affiliate', name: 'git-branch' },
  'dollar-sign': { category: 'affiliate', name: 'dollar-sign' },
  percent: { category: 'affiliate', name: 'percent' },
  award: { category: 'affiliate', name: 'award' },
  target: { category: 'affiliate', name: 'target' },
}

/**
 * ApexOS Icon Component
 *
 * Uses SVG sprite system from design/icons/*.svg
 *
 * @example
 * <Icon name="dashboard" size="md" color="primary" />
 * <Icon name="check-circle" size="lg" color="success" aria-label="Success" />
 */
export function Icon({
  name,
  size = 'md',
  color = 'muted',
  className = '',
  'aria-label': ariaLabel,
  onClick,
}: IconProps) {
  const iconInfo = iconCategoryMap[name]
  const pixelSize = sizeMap[size]

  if (!iconInfo) {
    console.error(`Icon "${name}" not found in icon map`)
    return null
  }

  const colorClass = color === 'inherit' ? '' : `icon--${color}`
  const combinedClassName = `icon ${colorClass} icon--${size} ${className}`.trim()
  const ariaLabelValue = ariaLabel || name.replace(/-/g, ' ')

  return (
    <svg
      className={combinedClassName}
      width={pixelSize}
      height={pixelSize}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label={ariaLabelValue}
      role={ariaLabel ? 'img' : undefined}
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
    >
      <use href={`/design/icons/${iconInfo.category}.svg#icon-${iconInfo.name}`} />
    </svg>
  )
}

export default Icon
