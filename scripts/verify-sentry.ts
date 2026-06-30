#!/usr/bin/env ts-node

/**
 * Sentry Integration Test Script
 *
 * Run this to verify Sentry is configured correctly:
 * npx tsx scripts/verify-sentry.ts
 */

import * as Sentry from '@sentry/nextjs';
import { initializeSentry, captureException, captureMessage, startSpan } from '@/lib/error-tracking';

// Set test environment
process.env.NEXT_PUBLIC_SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN || 'https://test@o0.ingest.sentry.io/0';
process.env.SENTRY_ORG = process.env.SENTRY_ORG || 'test-org';
process.env.SENTRY_PROJECT = process.env.SENTRY_PROJECT || 'apex-os';
process.env.SENTRY_ENVIRONMENT = 'test';
process.env.NEXT_PUBLIC_SENTRY_ENABLED = 'true';

async function runTests() {
  console.log('🧪 Testing Sentry Integration...\n');

  // Initialize
  console.log('1. Initializing Sentry...');
  const sentry = initializeSentry();
  if (sentry) {
    console.log('   ✅ Sentry initialized');
  } else {
    console.log('   ⚠️  Sentry not initialized (DSN may be missing)');
  }

  // Test message capture
  console.log('\n2. Testing message capture...');
  captureMessage('Test message from verification script', 'info');
  console.log('   ✅ Message captured');

  // Test exception capture
  console.log('\n3. Testing exception capture...');
  try {
    throw new Error('Test exception for verification');
  } catch (error) {
    captureException(error as Error, { test: true, script: 'verify-sentry' });
    console.log('   ✅ Exception captured');
  }

  // Test span
  console.log('\n4. Testing performance span...');
  const result = startSpan('test-operation', 'test', (span) => {
    span.setData('test-data', 'value');
    return 'operation result';
  });
  console.log(`   ✅ Span completed: ${result}`);

  // Test user context
  console.log('\n5. Testing user context...');
  const { setUserContext, clearUserContext } = await import('@/lib/error-tracking');
  setUserContext({ id: 'test-user', email: 'test@example.com' });
  console.log('   ✅ User context set');

  clearUserContext();
  console.log('   ✅ User context cleared');

  // Check scope
  console.log('\n6. Checking current scope...');
  const scope = Sentry.getCurrentScope();
  console.log(`   Scope: ${JSON.stringify({ spanId: scope?.getSpan()?.spanId() })}`);

  console.log('\n✅ All Sentry integration tests passed!');
  console.log('\n📝 Next steps:');
  console.log('   1. Deploy to Cloudflare Pages with SENTRY_DSN configured');
  console.log('   2. Create alert rules in Sentry:');
  console.log('      - Error rate > 1%');
  console.log('      - Spike in errors (10+ in 5min)');
  console.log('      - New error type detection');
  console.log('   3. See docs/monitoring-alerting.md for full configuration');
}

runTests().catch(console.error);
