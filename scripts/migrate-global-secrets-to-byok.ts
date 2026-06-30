#!/usr/bin/env tsx

/**
 * Migrate global secrets to admin user's BYOK keys
 *
 * Usage:
 *   tsx scripts/migrate-global-secrets-to-byok.ts --env staging
 *   tsx scripts/migrate-global-secrets-to-byok.ts --env production
 *
 * This script:
 * 1. Loads global secrets from .env.{env} or Cloudflare Secrets
 * 2. Finds admin user (role = 'admin')
 * 3. Encrypts each secret và stores in user_api_keys table
 */

import { DB } from '../src/lib/db/client'
import { setUserApiKey } from '../src/lib/byok/user-api-key-store'
import { encryptApiKey } from '../src/lib/byok/crypto'
import fs from 'fs'
import path from 'path'

const BYOK_PROVIDERS = ['binance', 'bybit', 'resend'] as const

const env = process.argv.includes('--production')
  ? 'production'
  : process.argv.includes('--staging')
  ? 'staging'
  : process.argv.includes('--env')
    ? process.argv[process.argv.indexOf('--env') + 1]
    : 'staging'

const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n')

// Load .env file
const envFile = path.resolve(process.cwd(), `.env.${env}.example`)
if (fs.existsSync(envFile)) {
  const content = fs.readFileSync(envFile, 'utf-8')
  const lines = content.split('\n')
  for (const line of lines) {
    const [key, ...valueParts] = line.split('=')
    if (key && valueParts.length) {
      const value = valueParts.join('=').replace(/^["']|["']$/g, '')
      if (value) process.env[key] = value
    }
  }
}

async function main() {
  console.log(`\n🔑 BYOK Migration — Environment: ${env} (dry-run: ${dryRun})`)

  // 1. Find admin user
  console.log('\n📋 Step 1: Finding admin user...')
  const admin = await DB.prepare(
    `SELECT id FROM profiles WHERE role = 'admin' LIMIT 1`
  ).first<{ id: string }>()

  if (!admin) {
    console.error('❌ No admin user found in profiles table')
    process.exit(1)
  }
  console.log(`✅ Admin user ID: ${admin.id}`)

  // 2. Check BYOK_MASTER_KEY
  if (!process.env.BYOK_MASTER_KEY) {
    console.error('❌ BYOK_MASTER_KEY not set')
    process.exit(1)
  }

  // 3. Migrate each provider
  console.log('\n📦 Step 2: Migrating global secrets to BYOK...\n')

  const envVarMap: Record<string, string> = {
    binance: process.env.BINANCE_WEBHOOK_SECRET,
    bybit: process.env.BYBIT_WEBHOOK_SECRET,
    resend: process.env.RESEND_API_KEY,
  }

  let migrated = 0
  let skipped = 0

  for (const provider of BYOK_PROVIDERS) {
    const secret = envVarMap[provider]
    if (!secret) {
      console.log(`  ${provider}: ⚠️  No global secret found, skipping`)
      skipped++
      continue
    }

    // Check if user already has key
    const existing = await DB.prepare(
      `SELECT 1 FROM user_api_keys WHERE user_id = ? AND provider = ?`
    ).bind(admin.id, provider).first()

    if (existing) {
      console.log(`  ${provider}: ⚠️  User already has key, skipping`)
      skipped++
      continue
    }

    if (dryRun) {
      console.log(`  ${provider}: [DRY-RUN] Would encrypt and store key for admin`)
      migrated++
      continue
    }

    // Encrypt and store
    try {
      const encrypted = await encryptApiKey(secret)
      await setUserApiKey(admin.id, provider, secret)
      console.log(`  ${provider}: ✅ Encrypted and stored (${encrypted.length} bytes)`)
      migrated++
    } catch (error) {
      console.error(`  ${provider}: ❌ Failed — ${error}`)
    }
  }

  // 4. Summary
  console.log('\n📊 Migration Summary:')
  console.log(`   Migrated: ${migrated}`)
  console.log(`   Skipped: ${skipped}`)
  console.log(`   Admin user: ${admin.id}`)
  console.log(`   Dry-run: ${dryRun}`)

  if (!dryRun && migrated > 0) {
    console.log('\n✅ Migration complete!')
    console.log('Next steps:')
    console.log('  1. Verify: wrangler d1 execute apex-os-db --command "SELECT * FROM user_api_keys WHERE user_id = \'' + admin.id + '\'"')
    console.log('  2. Set BYOK_ENABLED=true in Cloudflare Secrets')
    console.log('  3. Test webhook with admin user')
  }
}

main().catch((error) => {
  console.error('❌ Migration failed:', error)
  process.exit(1)
})
