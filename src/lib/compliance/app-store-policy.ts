/**
 * Apple App Store Guideline 3.1.5(v) & Google Play Financial Policy Guard
 *
 * Enforces read-only B2B/1-tier fee analytics mode for mobile & PWA surfaces:
 * 1. Blocks incentivized app-install or social-share reward tasks (Apple 3.2.2(vi) & 3.1.5(v))
 * 2. Disables in-app custodial wallet key storage, swaps, or direct token transfers
 * 3. Rejects multi-level/MLM commission positioning in mobile/PWA manifests
 */

export type RewardTaskKind =
  | 'app_install'
  | 'social_share'
  | 'app_review'
  | 'push_opt_in'
  | 'verified_trade_fee_rebate'
  | 'b2b_api_onboarding';

export interface MobileRewardTaskConfig {
  id: string;
  kind: RewardTaskKind | string;
  enabled: boolean;
}

export interface AppStoreSurfaceConfig {
  platform: 'ios' | 'android' | 'pwa' | 'web';
  mode: 'read_only_fee_analytics' | 'full_transactional';
  custodialWalletEnabled?: boolean;
  inAppTokenTransfersEnabled?: boolean;
  multiTierCommissionPromoted?: boolean;
  rewardTasks?: readonly MobileRewardTaskConfig[];
  manifest?: {
    name?: string;
    description?: string;
    lang?: string;
  };
}

export interface AppStoreComplianceVerdict {
  compliant: boolean;
  violations: string[];
}

const FORBIDDEN_REWARD_TASK_KINDS: ReadonlySet<string> = new Set<string>([
  'app_install',
  'install_app',
  'download_app',
  'social_share',
  'share_on_social',
  'retweet',
  'app_review',
  'rate_app',
]);

const FORBIDDEN_MANIFEST_PHRASES: readonly RegExp[] = [
  /multi[-\s]?tier\s+commission/i,
  /mlm/i,
  /custodial\s+wallet/i,
  /guaranteed\s+yield/i,
];

/**
 * Evaluates a mobile/PWA surface configuration against Apple Guideline 3.1.5(v)
 * and Google Play Developer Program Policies.
 */
export function evaluateAppStorePolicyCompliance(
  config: AppStoreSurfaceConfig
): AppStoreComplianceVerdict {
  const violations: string[] = [];
  const isStoreRegulatedSurface =
    config.platform === 'ios' || config.platform === 'android' || config.platform === 'pwa';

  if (isStoreRegulatedSurface && config.mode !== 'read_only_fee_analytics') {
    violations.push(
      'APPLE_3_1_5_V_READ_ONLY_REQUIRED: Mobile/PWA surfaces must operate in read_only_fee_analytics mode.'
    );
  }

  if (config.custodialWalletEnabled === true) {
    violations.push(
      'CUSTODIAL_WALLET_PROHIBITED: In-app custodial wallet features are prohibited; ApexOS is strictly non-custodial.'
    );
  }

  if (isStoreRegulatedSurface && config.inAppTokenTransfersEnabled === true) {
    violations.push(
      'APPLE_3_1_5_V_IN_APP_TRANSFER_PROHIBITED: Direct in-app cryptocurrency transfers or swaps are disabled on mobile/PWA.'
    );
  }

  if (config.multiTierCommissionPromoted === true) {
    violations.push(
      'MULTI_TIER_PROMOTION_PROHIBITED: Multi-tier commission promotion is prohibited on App Store / PWA surfaces.'
    );
  }

  if (config.rewardTasks) {
    for (const task of config.rewardTasks) {
      if (!task.enabled) continue;
      const normalizedKind = task.kind.trim().toLowerCase();
      if (FORBIDDEN_REWARD_TASK_KINDS.has(normalizedKind)) {
        violations.push(
          `APPLE_REWARD_TASK_PROHIBITED: Incentivized reward task '${task.id}' (${task.kind}) violates App Store Guideline 3.1.5(v) / 3.2.2(vi).`
        );
      }
    }
  }

  if (config.manifest) {
    if (config.manifest.lang && config.manifest.lang !== 'en') {
      violations.push(
        `MANIFEST_DEFAULT_LOCALE_MISMATCH: PWA manifest lang must default to 'en' (found '${config.manifest.lang}').`
      );
    }

    const combinedText = `${config.manifest.name ?? ''} ${config.manifest.description ?? ''}`;
    for (const pattern of FORBIDDEN_MANIFEST_PHRASES) {
      if (pattern.test(combinedText)) {
        violations.push(
          `MANIFEST_COPY_VIOLATION: Manifest text matched prohibited pattern ${pattern.toString()}.`
        );
      }
    }
  }

  return {
    compliant: violations.length === 0,
    violations,
  };
}

/**
 * Asserts Apple 3.1.5(v) & Google Play compliance; throws an error listing all violations if non-compliant.
 */
export function assertAppStorePolicyCompliance(
  config: AppStoreSurfaceConfig
): AppStoreComplianceVerdict {
  const verdict = evaluateAppStorePolicyCompliance(config);
  if (!verdict.compliant) {
    throw new Error(`App Store Policy Violation: ${verdict.violations.join(' | ')}`);
  }
  return verdict;
}
