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
 * Usage: tsx scripts/validate-data.ts
 *
 * Requires: wrangler CLI configured with D1 database
 */

import { execSync } from 'child_process'

const DB_NAME = 'apex-os-db'

interface ValidationResult {
  name: string
  status: 'PASS' | 'FAIL' | 'WARN'
  count?: number
  details?: string
  rows?: any[]
}

class D1Validator {
  private results: ValidationResult[] = []

  private execute(sql: string): any[] {
    try {
      const output = execSync(`wrangler d1 execute ${DB_NAME} --command "${sql}" 2>/dev/null`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      // Parse output - wrangler returns tabular output
      return this.parseWranglerOutput(output)
    } catch (error) {
      console.error(`Query failed: ${sql}`, error)
      return []
    }
  }

  private executeRaw(sql: string): string {
    try {
      return execSync(`wrangler d1 execute ${DB_NAME} --command "${sql}" 2>/dev/null`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch (error) {
      console.error(`Query failed: ${sql}`, error)
      return ''
    }
  }

  private parseWranglerOutput(output: string): any[] {
    const lines = output.trim().split('\n')
    if (lines.length < 2) return []

    // Skip header lines and parse data rows
    const dataRows = lines.filter(line => !line.startsWith('==') && line.trim() && !line.includes('---'))
    const results: any[] = []

    for (const row of dataRows) {
      const trimmed = row.trim()
      if (!trimmed) continue
      // Simple parsing for key-value output
      const parts = trimmed.split(/\s{2,}/)
      if (parts.length >= 2) {
        const obj: any = {}
        for (const part of parts) {
          const [key, ...valueParts] = part.split(/:\s*/)
          if (key && valueParts.length > 0) {
            obj[key.trim()] = valueParts.join(': ').trim()
          }
        }
        if (Object.keys(obj).length > 0) {
          results.push(obj)
        }
      }
    }
    return results
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
      const result = this.executeRaw(`SELECT COUNT(*) as count FROM ${table}`)
      const match = result.match(/\|\s*count\s*\|\s*(\d+)/)
      const count = match ? parseInt(match[1]) : 0

      this.addResult({
        name: `${table} count`,
        status: count > 0 ? 'PASS' : count === 0 ? 'WARN' : 'FAIL',
        count
      })
    }
  }

  // ============================================
  // PROFILE ROLES VALIDATION
  // ============================================

  validateProfileRoles() {
    console.log('\n👤 PROFILE ROLES VALIDATION\n')

    const validRoles = ['shopper', 'affiliate', 'admin', 'master_trader']
    const roleList = validRoles.map(r => `'${r}'`).join(',')

    // Invalid roles
    const invalidRoles = this.execute(`
      SELECT id, email, role FROM profiles
      WHERE role NOT IN (${roleList})
    `)

    this.addResult({
      name: 'Profile roles within valid enum',
      status: invalidRoles.length === 0 ? 'PASS' : 'FAIL',
      count: invalidRoles.length,
      rows: invalidRoles.length > 0 ? invalidRoles.slice(0, 10) : undefined
    })

    // Role distribution
    const roles = this.execute(`
      SELECT role, COUNT(*) as count FROM profiles GROUP BY role ORDER BY count DESC
    `)

    console.log('\n   Role distribution:')
    roles.forEach((r: any) => {
      console.log(`   - ${r.role}: ${r.count}`)
    })

    // Null referral codes
    const nullRef = this.executeRaw(`SELECT COUNT(*) as count FROM profiles WHERE referral_code IS NULL`)
    const nullMatch = nullRef.match(/\|\s*count\s*\|\s*(\d+)/)
    const nullCount = nullMatch ? parseInt(nullMatch[1]) : 0

    this.addResult({
      name: 'All profiles have referral_code',
      status: nullCount === 0 ? 'PASS' : 'WARN',
      count: nullCount
    })
  }

  // ============================================
  // REFERRAL TREE INTEGRITY
  // ============================================

  validateReferralTree() {
    console.log('\n🌲 REFERRAL TREE INTEGRITY\n')

    // Orphaned affiliate_id references
    const orphaned = this.execute(`
      SELECT rt.id, rt.affiliate_id
      FROM referral_tree rt
      LEFT JOIN profiles p ON rt.affiliate_id = p.id
      WHERE p.id IS NULL
    `)

    this.addResult({
      name: 'No orphaned referral_tree.affiliate_id',
      status: orphaned.length === 0 ? 'PASS' : 'FAIL',
      count: orphaned.length,
      rows: orphaned
    })

    // Broken parent references
    const brokenParent = this.execute(`
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

    // Broken root references
    const brokenRoot = this.execute(`
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

    // Invalid levels
    const invalidLevel = this.execute(`
      SELECT id, affiliate_id, level FROM referral_tree
      WHERE level < 1 OR level > 10
    `)

    this.addResult({
      name: 'All levels within 1-10 range',
      status: invalidLevel.length === 0 ? 'PASS' : 'FAIL',
      count: invalidLevel.length,
      rows: invalidLevel
    })

    // Missing paths
    const missingPath = this.execute(`
      SELECT id, affiliate_id FROM referral_tree WHERE path IS NULL OR path = ''
    `)

    this.addResult({
      name: 'All nodes have path',
      status: missingPath.length === 0 ? 'PASS' : 'FAIL',
      count: missingPath.length,
      rows: missingPath
    })

    // Path starts with affiliate_id check (for level > 1)
    const badPath = this.execute(`
      SELECT rt.id, rt.affiliate_id, rt.path, rt.level
      FROM referral_tree rt
      WHERE rt.level > 1 AND rt.path NOT LIKE rt.affiliate_id || '/%'
    `)

    this.addResult({
      name: 'Path starts with affiliate_id (for level>1)',
      status: badPath.length === 0 ? 'PASS' : 'FAIL',
      count: badPath.length,
      rows: badPath.slice(0, 10)
    })

    // Level vs path depth mismatch
    const levelMismatch = this.execute(`
      SELECT rt.id, rt.level, rt.path,
        (LENGTH(rt.path) - LENGTH(REPLACE(rt.path, '/', '')) + 1) as calculated_level
      FROM referral_tree rt
      WHERE (LENGTH(rt.path) - LENGTH(REPLACE(rt.path, '/', '')) + 1) != rt.level
    `)

    this.addResult({
      name: 'Level matches path depth',
      status: levelMismatch.length === 0 ? 'PASS' : 'FAIL',
      count: levelMismatch.length,
      rows: levelMismatch.slice(0, 10)
    })

    // Cycle detection using recursive CTE
    try {
      const cycles = this.execute(`
        WITH RECURSIVE paths(id, parent_id, path, depth) AS (
          SELECT id, parent_id, CAST(id AS TEXT), 1
          FROM referral_tree
          WHERE parent_id IS NULL
          UNION ALL
          SELECT rt.id, rt.parent_id, paths.path || '->' || rt.id, depth + 1
          FROM referral_tree rt
          INNER JOIN paths ON rt.parent_id = paths.id
          WHERE depth < 100
        )
        SELECT * FROM paths WHERE id LIKE '%->' || id OR depth > 10 LIMIT 10
      `)

      this.addResult({
        name: 'No referral tree cycles',
        status: cycles.length === 0 ? 'PASS' : 'FAIL',
        count: cycles.length,
        rows: cycles
      })
    } catch {
      this.addResult({
        name: 'No referral tree cycles',
        status: 'WARN',
        details: 'Could not perform cycle check (recursive CTE may not be supported)'
      })
    }
  }

  // ============================================
  // FOREIGN KEY ORPHAN CHECKS
  // ============================================

  validateOrphans() {
    console.log('\n🔗 FOREIGN KEY ORPHAN CHECKS\n')

    // profiles.referred_by
    const orphanRef = this.execute(`
      SELECT p.id, p.email, p.referred_by
      FROM profiles p
      LEFT JOIN profiles parent ON p.referred_by = parent.referral_code
      WHERE p.referred_by IS NOT NULL AND parent.id IS NULL
    `)

    this.addResult({
      name: 'profiles.referred_by references valid referral_code',
      status: orphanRef.length === 0 ? 'PASS' : 'FAIL',
      count: orphanRef.length,
      rows: orphanRef.slice(0, 10)
    })

    // affiliate_codes.affiliate_id
    const orphanAC = this.execute(`
      SELECT ac.id, ac.affiliate_id FROM affiliate_codes ac
      LEFT JOIN profiles p ON ac.affiliate_id = p.id WHERE p.id IS NULL
    `)

    this.addResult({
      name: 'affiliate_codes.affiliate_id references valid profile',
      status: orphanAC.length === 0 ? 'PASS' : 'FAIL',
      count: orphanAC.length,
      rows: orphanAC
    })

    // deals.created_by
    const orphanDeal = this.execute(`
      SELECT d.id, d.created_by FROM deals d
      LEFT JOIN profiles p ON d.created_by = p.id
      WHERE d.created_by IS NOT NULL AND p.id IS NULL
    `)

    this.addResult({
      name: 'deals.created_by references valid profile',
      status: orphanDeal.length === 0 ? 'PASS' : 'FAIL',
      count: orphanDeal.length,
      rows: orphanDeal
    })

    // deal_clicks.affiliate_id
    const orphanClickAff = this.execute(`
      SELECT dc.id, dc.affiliate_id FROM deal_clicks dc
      LEFT JOIN profiles p ON dc.affiliate_id = p.id
      WHERE dc.affiliate_id IS NOT NULL AND p.id IS NULL
    `)

    this.addResult({
      name: 'deal_clicks.affiliate_id references valid profile',
      status: orphanClickAff.length === 0 ? 'PASS' : 'FAIL',
      count: orphanClickAff.length,
      rows: orphanClickAff.slice(0, 10)
    })

    // deal_clicks.deal_id
    const orphanClickDeal = this.execute(`
      SELECT dc.id, dc.deal_id FROM deal_clicks dc
      LEFT JOIN deals d ON dc.deal_id = d.id WHERE d.id IS NULL
    `)

    this.addResult({
      name: 'deal_clicks.deal_id references valid deal',
      status: orphanClickDeal.length === 0 ? 'PASS' : 'FAIL',
      count: orphanClickDeal.length,
      rows: orphanClickDeal.slice(0, 10)
    })

    // conversions.affiliate_id
    const orphanConvAff = this.execute(`
      SELECT c.id, c.affiliate_id FROM conversions c
      LEFT JOIN profiles p ON c.affiliate_id = p.id WHERE p.id IS NULL
    `)

    this.addResult({
      name: 'conversions.affiliate_id references valid profile',
      status: orphanConvAff.length === 0 ? 'PASS' : 'FAIL',
      count: orphanConvAff.length,
      rows: orphanConvAff.slice(0, 10)
    })

    // conversions.deal_id
    const orphanConvDeal = this.execute(`
      SELECT c.id, c.deal_id FROM conversions c
      LEFT JOIN deals d ON c.deal_id = d.id WHERE d.id IS NULL
    `)

    this.addResult({
      name: 'conversions.deal_id references valid deal',
      status: orphanConvDeal.length === 0 ? 'PASS' : 'FAIL',
      count: orphanConvDeal.length,
      rows: orphanConvDeal.slice(0, 10)
    })

    // earnings.conversion_id
    const orphanEarnConv = this.execute(`
      SELECT e.id, e.conversion_id FROM earnings e
      LEFT JOIN conversions c ON e.conversion_id = c.id WHERE c.id IS NULL
    `)

    this.addResult({
      name: 'earnings.conversion_id references valid conversion',
      status: orphanEarnConv.length === 0 ? 'PASS' : 'FAIL',
      count: orphanEarnConv.length,
      rows: orphanEarnConv
    })

    // earnings.affiliate_id
    const orphanEarnAff = this.execute(`
      SELECT e.id, e.affiliate_id FROM earnings e
      LEFT JOIN profiles p ON e.affiliate_id = p.id WHERE p.id IS NULL
    `)

    this.addResult({
      name: 'earnings.affiliate_id references valid profile',
      status: orphanEarnAff.length === 0 ? 'PASS' : 'FAIL',
      count: orphanEarnAff.length,
      rows: orphanEarnAff
    })

    // payouts.affiliate_id
    const orphanPayout = this.execute(`
      SELECT po.id, po.affiliate_id FROM payouts po
      LEFT JOIN profiles p ON po.affiliate_id = p.id WHERE p.id IS NULL
    `)

    this.addResult({
      name: 'payouts.affiliate_id references valid profile',
      status: orphanPayout.length === 0 ? 'PASS' : 'FAIL',
      count: orphanPayout.length,
      rows: orphanPayout
    })

    // earnings.referral_tree_id
    const orphanEarnTree = this.execute(`
      SELECT e.id, e.referral_tree_id FROM earnings e
      LEFT JOIN referral_tree rt ON e.referral_tree_id = rt.id
      WHERE e.referral_tree_id IS NOT NULL AND rt.id IS NULL
    `)

    this.addResult({
      name: 'earnings.referral_tree_id references valid referral_tree',
      status: orphanEarnTree.length === 0 ? 'PASS' : 'FAIL',
      count: orphanEarnTree.length,
      rows: orphanEarnTree
    })
  }

  // ============================================
  // ADDITIONAL VALIDATION
  // ============================================

  validateConsistency() {
    console.log('\n🔍 CONSISTENCY CHECKS\n')

    // Affiliates without referral_tree entry
    const missingTree = this.execute(`
      SELECT p.id, p.email, p.role FROM profiles p
      LEFT JOIN referral_tree rt ON p.id = rt.affiliate_id
      WHERE p.role IN ('affiliate', 'admin', 'master_trader') AND rt.id IS NULL
    `)

    this.addResult({
      name: 'All affiliates have referral_tree entry',
      status: missingTree.length === 0 ? 'PASS' : 'FAIL',
      count: missingTree.length,
      rows: missingTree
    })

    // Level 1 root check
    const badRoot = this.execute(`
      SELECT id, level FROM referral_tree WHERE level = 1 AND parent_id IS NOT NULL
    `)

    this.addResult({
      name: 'Level 1 nodes have NULL parent_id',
      status: badRoot.length === 0 ? 'PASS' : 'FAIL',
      count: badRoot.length,
      rows: badRoot
    })

    // Non-root parent_id check
    const missingParent = this.execute(`
      SELECT id, level FROM referral_tree WHERE level > 1 AND parent_id IS NULL
    `)

    this.addResult({
      name: 'Non-root nodes have parent_id',
      status: missingParent.length === 0 ? 'PASS' : 'FAIL',
      count: missingParent.length,
      rows: missingParent
    })

    // total_direct_referrals consistency
    const directMismatch = this.execute(`
      SELECT rt.affiliate_id, rt.total_direct_referrals as expected,
        (SELECT COUNT(*) FROM referral_tree WHERE parent_id = rt.id) as actual
      FROM referral_tree rt
      WHERE rt.total_direct_referrals != (SELECT COUNT(*) FROM referral_tree WHERE parent_id = rt.id)
    `)

    this.addResult({
      name: 'total_direct_referrals matches child count',
      status: directMismatch.length === 0 ? 'PASS' : 'FAIL',
      count: directMismatch.length,
      rows: directMismatch.slice(0, 10)
    })
  }

  // ============================================
  // RUN ALL
  // ============================================

  runAll() {
    console.log('═══════════════════════════════════════════════')
    console.log('   APEXOS DATA VALIDATION REPORT')
    console.log('═══════════════════════════════════════════════')

    this.validateCounts()
    this.validateProfileRoles()
    this.validateReferralTree()
    this.validateConsistency()
    this.validateOrphans()

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

    if (failed > 0) {
      process.exit(1)
    }
  }
}

// Run
const validator = new D1Validator()
try {
  validator.runAll()
} catch (error) {
  console.error('Validation failed:', error)
  process.exit(1)
}
