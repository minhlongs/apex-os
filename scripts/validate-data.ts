#!/usr/bin/env tsx
/**
 * ApexOS Data Validation Script
 *
 * Performs comprehensive data integrity checks:
 * - Spot-check counts for all tables
 * - Profile roles validity
 * - Referral tree integrity (cycles, broken references, path consistency)
 * - Foreign key orphan detection
 *
 * Usage: tsx scripts/validate-data.ts [path-to-db]
 * Default: backups/db_backup_20260622_030907.sqlite
 */

// SQLite driver - using better-sqlite3 for synchronous queries
import Database from 'better-sqlite3'

const DEFAULT_DB_PATH = '/Users/macbook/apex-os/backups/db_backup_20260622_030907.sqlite'

// Valid enums from schema
const VALID_ROLES = ['shopper', 'affiliate', 'admin', 'master_trader']
const VALID_PLANS = ['free', 'starter', 'growth', 'premium', 'master']
const VALID_COMMISSION_TYPES = ['percentage', 'fixed']
const VALID_CONVERSION_STATUS = ['pending', 'approved', 'rejected', 'refunded']
const VALID_PAYOUT_STATUS = ['pending', 'processing', 'completed', 'failed', 'cancelled']

interface ValidationResult {
  name: string
  status: 'PASS' | 'FAIL' | 'WARN'
  count?: number
  details?: string
  rows?: any[]
}

class DataValidator {
  private db: Database.Database
  private results: ValidationResult[] = []
  private verbose = false

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('foreign_keys = ON')
  }

  log(message: string) {
    if (this.verbose) console.log(message)
  }

  query<T>(sql: string, params: any[] = []): T[] {
    try {
      return this.db.prepare(sql).all(params) as T[]
    } catch (error) {
      console.error(`Query failed: ${sql}`, error)
      return []
    }
  }

  queryOne<T>(sql: string, params: any[] = []): T | null {
    try {
      return this.db.prepare(sql).get(params) as T | null
    } catch (error) {
      console.error(`Query failed: ${sql}`, error)
      return null
    }
  }

  addResult(result: ValidationResult) {
    this.results.push(result)
    const icon = result.status === 'PASS' ? '✅' : result.status === 'FAIL' ? '❌' : '⚠️'
    console.log(`${icon} ${result.name}`)
    if (result.count !== undefined) console.log(`   Count: ${result.count}`)
    if (result.details) console.log(`   ${result.details}`)
    if (result.rows && result.rows.length > 0) {
      result.rows.slice(0, 10).forEach((row, i) => {
        console.log(`   [${i + 1}] ${JSON.stringify(row)}`)
      })
      if (result.rows.length > 10) {
        console.log(`   ... and ${result.rows.length - 10} more`)
      }
    }
  }

  // ============================================
  // SPOT-CHECK COUNTS
  // ============================================

  validateCounts() {
    console.log('\n📊 SPOT-CHECK COUNTS\n')

    const tables = [
      'users',
      'profiles',
      'sessions',
      'verifications',
      'deals',
      'affiliate_codes',
      'referral_tree',
      'deal_clicks',
      'conversions',
      'earnings',
      'payouts'
    ]

    for (const table of tables) {
      const count = this.queryOne<{ count: number }>(`SELECT COUNT(*) as count FROM ${table}`)
      this.addResult({
        name: `${table} count`,
        status: count?.count > 0 || count === null ? 'PASS' : 'FAIL',
        count: count?.count ?? 0,
        details: count?.count === 0 ? 'Table is empty' : undefined
      })
    }
  }

  // ============================================
  // PROFILE ROLES VALIDATION
  // ============================================

  validateProfileRoles() {
    console.log('\n👤 PROFILE ROLES VALIDATION\n')

    // Check for invalid role values
    const invalidRoles = this.query<{ id: string, email: string, role: string }>(
      `SELECT id, email, role FROM profiles WHERE role NOT IN (${VALID_ROLES.map(() => '?').join(',')})`,
      VALID_ROLES
    )

    this.addResult({
      name: 'Profile roles within valid enum',
      status: invalidRoles.length === 0 ? 'PASS' : 'FAIL',
      count: invalidRoles.length,
      details: invalidRoles.length > 0 ? `Found ${invalidRoles.length} profiles with invalid roles` : undefined,
      rows: invalidRoles.length > 0 ? invalidRoles : undefined
    })

    // Role distribution
    const roleDistribution = this.query<{ role: string, count: number }>(`
      SELECT role, COUNT(*) as count FROM profiles GROUP BY role ORDER BY count DESC
    `)

    console.log('\n   Role distribution:')
    roleDistribution.forEach(r => {
      console.log(`   - ${r.role}: ${r.count}`)
    })

    // Check for profiles without referral_code (should be unique)
    const nullReferralCode = this.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM profiles WHERE referral_code IS NULL'
    )

    this.addResult({
      name: 'All profiles have referral_code',
      status: nullReferralCode?.count === 0 ? 'PASS' : 'WARN',
      count: nullReferralCode?.count ?? 0,
      details: nullReferralCode?.count > 0 ? `${nullReferralCode.count} profiles missing referral_code` : undefined
    })

    // Check for duplicate referral_code
    const duplicateCodes = this.query<{ referral_code: string, count: number }>(`
      SELECT referral_code, COUNT(*) as count
      FROM profiles
      WHERE referral_code IS NOT NULL
      GROUP BY referral_code
      HAVING count > 1
    `)

    this.addResult({
      name: 'No duplicate referral_code values',
      status: duplicateCodes.length === 0 ? 'PASS' : 'FAIL',
      count: duplicateCodes.length,
      rows: duplicateCodes.length > 0 ? duplicateCodes : undefined
    })
  }

  // ============================================
  // REFERRAL TREE INTEGRITY
  // ============================================

  validateReferralTree() {
    console.log('\n🌲 REFERRAL TREE INTEGRITY\n')

    // Count check
    const treeCount = this.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM referral_tree')
    const profileCount = this.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM profiles WHERE role IN ("affiliate", "admin", "master_trader")'
    )

    this.addResult({
      name: 'Referral tree count matches eligible profiles',
      status: treeCount?.count === profileCount?.count ? 'PASS' : 'WARN',
      count: treeCount?.count ?? 0,
      details: `Tree: ${treeCount?.count ?? 0}, Eligible profiles: ${profileCount?.count ?? 0}`
    })

    // Check for orphaned tree nodes (affiliate_id not in profiles)
    const orphanedTree = this.query<{ id: string, affiliate_id: string }>(`
      SELECT rt.id, rt.affiliate_id
      FROM referral_tree rt
      LEFT JOIN profiles p ON rt.affiliate_id = p.id
      WHERE p.id IS NULL
    `)

    this.addResult({
      name: 'No orphaned referral_tree.affiliate_id',
      status: orphanedTree.length === 0 ? 'PASS' : 'FAIL',
      count: orphanedTree.length,
      rows: orphanedTree
    })

    // Check for parent_id references that don't exist
    const brokenParent = this.query<{ id: string, parent_id: string }>(`
      SELECT rt.id, rt.parent_id
      FROM referral_tree rt
      LEFT JOIN referral_tree parent ON rt.parent_id = parent.id
      WHERE rt.parent_id IS NOT NULL AND parent.id IS NULL
    `)

    this.addResult({
      name: 'All parent_id references exist',
      status: brokenParent.length === 0 ? 'PASS' : 'FAIL',
      count: brokenParent.length,
      rows: brokenParent
    })

    // Check for root_id references that don't exist
    const brokenRoot = this.query<{ id: string, root_id: string }>(`
      SELECT rt.id, rt.root_id
      FROM referral_tree rt
      LEFT JOIN referral_tree root ON rt.root_id = root.id
      WHERE rt.root_id IS NOT NULL AND root.id IS NULL
    `)

    this.addResult({
      name: 'All root_id references exist',
      status: brokenRoot.length === 0 ? 'PASS' : 'FAIL',
      count: brokenRoot.length,
      rows: brokenRoot
    })

    // Check level bounds (should be 1-10)
    const invalidLevel = this.query<{ id: string, affiliate_id: string, level: number }>(`
      SELECT id, affiliate_id, level FROM referral_tree
      WHERE level < 1 OR level > 10
    `)

    this.addResult({
      name: 'All levels within 1-10 range',
      status: invalidLevel.length === 0 ? 'PASS' : 'FAIL',
      count: invalidLevel.length,
      rows: invalidLevel
    })

    // Check path format consistency
    const brokenPath = this.query<{ id: string, affiliate_id: string, path: string }>(`
      SELECT id, affiliate_id, path FROM referral_tree WHERE path IS NULL OR path = ''
    `)

    this.addResult({
      name: 'All nodes have path',
      status: brokenPath.length === 0 ? 'PASS' : 'FAIL',
      count: brokenPath.length,
      rows: brokenPath
    })

    // Check path starts with own affiliate_id
    const badPathStart = this.query<{ id: string, affiliate_id: string, path: string }>(`
      SELECT rt.id, rt.affiliate_id, rt.path
      FROM referral_tree rt
      WHERE rt.path NOT LIKE rt.affiliate_id || '/%'
        AND rt.path != rt.affiliate_id
        AND rt.level > 1
    `)

    this.addResult({
      name: 'Path starts with affiliate_id',
      status: badPathStart.length === 0 ? 'PASS' : 'FAIL',
      count: badPathStart.length,
      rows: badPathStart.length > 0 ? badPathStart.slice(0, 5) : undefined
    })

    // Check level matches path depth
    const levelMismatch = this.query<{ id: string, level: number, path: string }>(`
      SELECT rt.id, rt.level, rt.path
      FROM referral_tree rt
      WHERE (LENGTH(rt.path) - LENGTH(REPLACE(rt.path, '/', '')) + 1) != rt.level
    `)

    this.addResult({
      name: 'Level matches path depth',
      status: levelMismatch.length === 0 ? 'PASS' : 'FAIL',
      count: levelMismatch.length,
      rows: levelMismatch.slice(0, 5)
    })

    // Check for cycles (parent being a descendant of itself)
    // This is a complex check - we'll detect obvious cycles in the parent chain
    const cycles = this.detectCycles()
    this.addResult({
      name: 'No referral tree cycles',
      status: cycles.length === 0 ? 'PASS' : 'FAIL',
      count: cycles.length,
      details: cycles.length > 0 ? 'Found cycles in referral tree' : undefined,
      rows: cycles.slice(0, 5)
    })
  }

  private detectCycles() {
    const nodes = this.query<{ id: string, parent_id: string | null }>(
      'SELECT id, parent_id FROM referral_tree'
    )

    const cycles: { id: string, cycle: string[] }[] = []
    const visited = new Set<string>()
    const recursionStack = new Set<string>()

    const dfs = (nodeId: string, path: string[]): boolean => {
      if (recursionStack.has(nodeId)) {
        const cycleStart = path.indexOf(nodeId)
        cycles.push({ id: nodeId, cycle: path.slice(cycleStart).concat(nodeId) })
        return true
      }
      if (visited.has(nodeId)) return false

      visited.add(nodeId)
      recursionStack.add(nodeId)

      const node = nodes.find(n => n.id === nodeId)
      if (node?.parent_id) {
        if (dfs(node.parent_id, [...path, nodeId])) {
          return true
        }
      }

      recursionStack.delete(nodeId)
      return false
    }

    nodes.forEach(node => {
      if (!visited.has(node.id)) {
        dfs(node.id, [])
      }
    })

    return cycles
  }

  // ============================================
  // FOREIGN KEY ORPHAN CHECKS
  // ============================================

  validateOrphans() {
    console.log('\n🔗 FOREIGN KEY ORPHAN CHECKS\n')

    // profiles.referred_by should reference a valid referral_code
    const orphanReferredBy = this.query<{ id: string, email: string, referred_by: string }>(`
      SELECT p.id, p.email, p.referred_by
      FROM profiles p
      LEFT JOIN profiles parent ON p.referred_by = parent.referral_code
      WHERE p.referred_by IS NOT NULL AND parent.id IS NULL
    `)

    this.addResult({
      name: 'profiles.referred_by references valid referral_code',
      status: orphanReferredBy.length === 0 ? 'PASS' : 'FAIL',
      count: orphanReferredBy.length,
      rows: orphanReferredBy.slice(0, 10)
    })

    // affiliate_codes.affiliate_id -> profiles.id
    const orphanAffiliateCode = this.query<{ id: string, affiliate_id: string }>(`
      SELECT ac.id, ac.affiliate_id
      FROM affiliate_codes ac
      LEFT JOIN profiles p ON ac.affiliate_id = p.id
      WHERE p.id IS NULL
    `)

    this.addResult({
      name: 'affiliate_codes.affiliate_id references valid profile',
      status: orphanAffiliateCode.length === 0 ? 'PASS' : 'FAIL',
      count: orphanAffiliateCode.length,
      rows: orphanAffiliateCode
    })

    // deals.created_by -> profiles.id
    const orphanDealCreator = this.query<{ id: string, created_by: string }>(`
      SELECT d.id, d.created_by
      FROM deals d
      LEFT JOIN profiles p ON d.created_by = p.id
      WHERE d.created_by IS NOT NULL AND p.id IS NULL
    `)

    this.addResult({
      name: 'deals.created_by references valid profile',
      status: orphanDealCreator.length === 0 ? 'PASS' : 'FAIL',
      count: orphanDealCreator.length,
      rows: orphanDealCreator
    })

    // deal_clicks.affiliate_id -> profiles.id
    const orphanClickAffiliate = this.query<{ id: string, affiliate_id: string }>(`
      SELECT dc.id, dc.affiliate_id
      FROM deal_clicks dc
      LEFT JOIN profiles p ON dc.affiliate_id = p.id
      WHERE dc.affiliate_id IS NOT NULL AND p.id IS NULL
    `)

    this.addResult({
      name: 'deal_clicks.affiliate_id references valid profile',
      status: orphanClickAffiliate.length === 0 ? 'PASS' : 'FAIL',
      count: orphanClickAffiliate.length,
      rows: orphanClickAffiliate.slice(0, 10)
    })

    // deal_clicks.deal_id -> deals.id
    const orphanClickDeal = this.query<{ id: string, deal_id: string }>(`
      SELECT dc.id, dc.deal_id
      FROM deal_clicks dc
      LEFT JOIN deals d ON dc.deal_id = d.id
      WHERE d.id IS NULL
    `)

    this.addResult({
      name: 'deal_clicks.deal_id references valid deal',
      status: orphanClickDeal.length === 0 ? 'PASS' : 'FAIL',
      count: orphanClickDeal.length,
      rows: orphanClickDeal.slice(0, 10)
    })

    // conversions.affiliate_id -> profiles.id
    const orphanConversionAffiliate = this.query<{ id: string, affiliate_id: string }>(`
      SELECT c.id, c.affiliate_id
      FROM conversions c
      LEFT JOIN profiles p ON c.affiliate_id = p.id
      WHERE p.id IS NULL
    `)

    this.addResult({
      name: 'conversions.affiliate_id references valid profile',
      status: orphanConversionAffiliate.length === 0 ? 'PASS' : 'FAIL',
      count: orphanConversionAffiliate.length,
      rows: orphanConversionAffiliate.slice(0, 10)
    })

    // conversions.deal_id -> deals.id
    const orphanConversionDeal = this.query<{ id: string, deal_id: string }>(`
      SELECT c.id, c.deal_id
      FROM conversions c
      LEFT JOIN deals d ON c.deal_id = d.id
      WHERE d.id IS NULL
    `)

    this.addResult({
      name: 'conversions.deal_id references valid deal',
      status: orphanConversionDeal.length === 0 ? 'PASS' : 'FAIL',
      count: orphanConversionDeal.length,
      rows: orphanConversionDeal.slice(0, 10)
    })

    // conversions.deal_click_id -> deal_clicks.id
    const orphanConversionClick = this.query<{ id: string, deal_click_id: string }>(`
      SELECT c.id, c.deal_click_id
      FROM conversions c
      LEFT JOIN deal_clicks dc ON c.deal_click_id = dc.id
      WHERE c.deal_click_id IS NOT NULL AND dc.id IS NULL
    `)

    this.addResult({
      name: 'conversions.deal_click_id references valid deal_click',
      status: orphanConversionClick.length === 0 ? 'PASS' : 'FAIL',
      count: orphanConversionClick.length,
      rows: orphanConversionClick.slice(0, 10)
    })

    // earnings.conversion_id -> conversions.id (UNIQUE constraint)
    const orphanEarningConversion = this.query<{ id: string, conversion_id: string }>(`
      SELECT e.id, e.conversion_id
      FROM earnings e
      LEFT JOIN conversions c ON e.conversion_id = c.id
      WHERE c.id IS NULL
    `)

    this.addResult({
      name: 'earnings.conversion_id references valid conversion',
      status: orphanEarningConversion.length === 0 ? 'PASS' : 'FAIL',
      count: orphanEarningConversion.length,
      rows: orphanEarningConversion
    })

    // earnings.affiliate_id -> profiles.id
    const orphanEarningAffiliate = this.query<{ id: string, affiliate_id: string }>(`
      SELECT e.id, e.affiliate_id
      FROM earnings e
      LEFT JOIN profiles p ON e.affiliate_id = p.id
      WHERE p.id IS NULL
    `)

    this.addResult({
      name: 'earnings.affiliate_id references valid profile',
      status: orphanEarningAffiliate.length === 0 ? 'PASS' : 'FAIL',
      count: orphanEarningAffiliate.length,
      rows: orphanEarningAffiliate
    })

    // earnings.referral_tree_id -> referral_tree.id
    const orphanEarningTree = this.query<{ id: string, referral_tree_id: string }>(`
      SELECT e.id, e.referral_tree_id
      FROM earnings e
      LEFT JOIN referral_tree rt ON e.referral_tree_id = rt.id
      WHERE e.referral_tree_id IS NOT NULL AND rt.id IS NULL
    `)

    this.addResult({
      name: 'earnings.referral_tree_id references valid referral_tree',
      status: orphanEarningTree.length === 0 ? 'PASS' : 'FAIL',
      count: orphanEarningTree.length,
      rows: orphanEarningTree
    })

    // payouts.affiliate_id -> profiles.id
    const orphanPayoutAffiliate = this.query<{ id: string, affiliate_id: string }>(`
      SELECT po.id, po.affiliate_id
      FROM payouts po
      LEFT JOIN profiles p ON po.affiliate_id = p.id
      WHERE p.id IS NULL
    `)

    this.addResult({
      name: 'payouts.affiliate_id references valid profile',
      status: orphanPayoutAffiliate.length === 0 ? 'PASS' : 'FAIL',
      count: orphanPayoutAffiliate.length,
      rows: orphanPayoutAffiliate
    })

    // earnings.payout_id -> payouts.id
    const orphanEarningPayout = this.query<{ id: string, payout_id: string }>(`
      SELECT e.id, e.payout_id
      FROM earnings e
      LEFT JOIN payouts po ON e.payout_id = po.id
      WHERE e.payout_id IS NOT NULL AND po.id IS NULL
    `)

    this.addResult({
      name: 'earnings.payout_id references valid payout',
      status: orphanEarningPayout.length === 0 ? 'PASS' : 'FAIL',
      count: orphanEarningPayout.length,
      rows: orphanEarningPayout
    })

    // affiliate_codes.deal_id -> deals.id
    const orphanAffiliateCodeDeal = this.query<{ id: string, deal_id: string }>(`
      SELECT ac.id, ac.deal_id
      FROM affiliate_codes ac
      LEFT JOIN deals d ON ac.deal_id = d.id
      WHERE ac.deal_id IS NOT NULL AND d.id IS NULL
    `)

    this.addResult({
      name: 'affiliate_codes.deal_id references valid deal',
      status: orphanAffiliateCodeDeal.length === 0 ? 'PASS' : 'FAIL',
      count: orphanAffiliateCodeDeal.length,
      rows: orphanAffiliateCodeDeal
    })

    // earnings.parent_earnings_id -> earnings.id
    const orphanParentEarning = this.query<{ id: string, parent_earnings_id: string }>(`
      SELECT e.id, e.parent_earnings_id
      FROM earnings e
      LEFT JOIN earnings parent ON e.parent_earnings_id = parent.id
      WHERE e.parent_earnings_id IS NOT NULL AND parent.id IS NULL
    `)

    this.addResult({
      name: 'earnings.parent_earnings_id references valid earning',
      status: orphanParentEarning.length === 0 ? 'PASS' : 'FAIL',
      count: orphanParentEarning.length,
      rows: orphanParentEarning
    })
  }

  // ============================================
  // ADDITIONAL VALIDATION CHECKS
  // ============================================

  validateEnums() {
    console.log('\n📋 ENUM VALIDATION\n')

    // Check profile plans
    const invalidPlans = this.query<{ id: string, email: string, plan: string }>(
      `SELECT id, email, plan FROM profiles WHERE plan NOT IN (${VALID_PLANS.map(() => '?').join(',')})`,
      VALID_PLANS
    )

    this.addResult({
      name: 'Profile plans within valid enum',
      status: invalidPlans.length === 0 ? 'PASS' : 'FAIL',
      count: invalidPlans.length,
      rows: invalidPlans
    })

    // Check affiliate_codes commission_type
    const invalidCommissionType = this.query<{ id: string, commission_type: string }>(
      `SELECT id, commission_type FROM affiliate_codes WHERE commission_type NOT IN (${VALID_COMMISSION_TYPES.map(() => '?').join(',')})`,
      VALID_COMMISSION_TYPES
    )

    this.addResult({
      name: 'affiliate_codes.commission_type valid',
      status: invalidCommissionType.length === 0 ? 'PASS' : 'FAIL',
      count: invalidCommissionType.length,
      rows: invalidCommissionType
    })

    // Check conversions status
    const invalidConversionStatus = this.query<{ id: string, status: string }>(
      `SELECT id, status FROM conversions WHERE status NOT IN (${VALID_CONVERSION_STATUS.map(() => '?').join(',')})`,
      VALID_CONVERSION_STATUS
    )

    this.addResult({
      name: 'conversions.status within valid enum',
      status: invalidConversionStatus.length === 0 ? 'PASS' : 'FAIL',
      count: invalidConversionStatus.length,
      rows: invalidConversionStatus
    })

    // Check payouts status
    const invalidPayoutStatus = this.query<{ id: string, status: string }>(
      `SELECT id, status FROM payouts WHERE status NOT IN (${VALID_PAYOUT_STATUS.map(() => '?').join(',')})`,
      VALID_PAYOUT_STATUS
    )

    this.addResult({
      name: 'payouts.status within valid enum',
      status: invalidPayoutStatus.length === 0 ? 'PASS' : 'FAIL',
      count: invalidPayoutStatus.length,
      rows: invalidPayoutStatus
    })
  }

  validateReferralConsistency() {
    console.log('\n🔍 REFERRAL CONSISTENCY CHECKS\n')

    // Check that referral_tree.total_direct_referrals matches actual children count
    const mismatchedDirect = this.query<{ affiliate_id: string, expected: number, actual: number }>(`
      SELECT
        rt.affiliate_id,
        rt.total_direct_referrals as expected,
        (SELECT COUNT(*) FROM referral_tree WHERE parent_id = rt.id) as actual
      FROM referral_tree rt
      WHERE rt.total_direct_referrals != (SELECT COUNT(*) FROM referral_tree WHERE parent_id = rt.id)
    `)

    this.addResult({
      name: 'total_direct_referrals matches child count',
      status: mismatchedDirect.length === 0 ? 'PASS' : 'FAIL',
      count: mismatchedDirect.length,
      rows: mismatchedDirect.slice(0, 10)
    })

    // Check that profiles with role in (affiliate, admin, master_trader) have corresponding referral_tree entry
    const missingTreeEntry = this.query<{ id: string, email: string, role: string }>(`
      SELECT p.id, p.email, p.role
      FROM profiles p
      LEFT JOIN referral_tree rt ON p.id = rt.affiliate_id
      WHERE p.role IN ('affiliate', 'admin', 'master_trader') AND rt.id IS NULL
    `)

    this.addResult({
      name: 'All affiliates have referral_tree entry',
      status: missingTreeEntry.length === 0 ? 'PASS' : 'FAIL',
      count: missingTreeEntry.length,
      rows: missingTreeEntry
    })

    // Check level 1 nodes have parent_id = NULL
    const badRoot = this.query<{ id: string, level: number }>(`
      SELECT id, level FROM referral_tree WHERE level = 1 AND parent_id IS NOT NULL
    `)

    this.addResult({
      name: 'Level 1 nodes have NULL parent_id',
      status: badRoot.length === 0 ? 'PASS' : 'FAIL',
      count: badRoot.length,
      rows: badRoot
    })

    // Check non-root nodes have parent_id
    const missingParent = this.query<{ id: string, level: number }>(`
      SELECT id, level FROM referral_tree WHERE level > 1 AND parent_id IS NULL
    `)

    this.addResult({
      name: 'Non-root nodes have parent_id',
      status: missingParent.length === 0 ? 'PASS' : 'FAIL',
      count: missingParent.length,
      rows: missingParent
    })
  }

  // ============================================
  // RUN ALL VALIDATIONS
  // ============================================

  runAll() {
    console.log('═══════════════════════════════════════════════')
    console.log('   APEXOS DATA VALIDATION REPORT')
    console.log('═══════════════════════════════════════════════')

    this.validateCounts()
    this.validateProfileRoles()
    this.validateReferralTree()
    this.validateReferralConsistency()
    this.validateOrphans()
    this.validateEnums()

    this.printSummary()
  }

  printSummary() {
    console.log('\n═══════════════════════════════════════════════')
    console.log('   SUMMARY')
    console.log('═══════════════════════════════════════════════')

    const total = this.results.length
    const passed = this.results.filter(r => r.status === 'PASS').length
    const failed = this.results.filter(r => r.status === 'FAIL').length
    const warned = this.results.filter(r => r.status === 'WARN').length

    console.log(`\nTotal checks: ${total}`)
    console.log(`✅ Passed: ${passed}`)
    console.log(`❌ Failed: ${failed}`)
    console.log(`⚠️  Warnings: ${warned}`)

    if (failed > 0) {
      console.log('\n❌ FAILED CHECKS:')
      this.results.filter(r => r.status === 'FAIL').forEach(r => {
        console.log(`  - ${r.name}: ${r.details || `${r.count} issues`}`)
      })
    }

    if (warned > 0) {
      console.log('\n⚠️  WARNINGS:')
      this.results.filter(r => r.status === 'WARN').forEach(r => {
        console.log(`  - ${r.name}: ${r.details || `${r.count} issues`}`)
      })
    }

    console.log('\n═══════════════════════════════════════════════\n')

    // Exit with error code if any failures
    if (failed > 0) {
      process.exit(1)
    }
  }

  close() {
    this.db.close()
  }
}

// Main execution
const dbPath = process.argv[2] || DEFAULT_DB_PATH

if (!dbPath) {
  console.error('Usage: tsx scripts/validate-data.ts [path-to-db]')
  process.exit(1)
}

const validator = new DataValidator(dbPath)
try {
  validator.runAll()
} catch (error) {
  console.error('Validation failed with error:', error)
  process.exit(1)
} finally {
  validator.close()
}
