#!/usr/bin/env node
/**
 * ApexOS Load Test Runner
 *
 * Convenience script to run k6 load tests with common configurations.
 *
 * Usage:
 *   node k6/run-load-test.js [config]
 *
 * Configs:
 *   quick    - 25 VUs, 15s (quick smoke test)
 *   normal   - 50 VUs, 30s (default)
 *   stress   - 100 VUs, 60s (stress test)
 *   endurance - 50 VUs, 5m (endurance test)
 *
 * Examples:
 *   node k6/run-load-test.js              # Run normal config
 *   node k6/run-load-test.js quick        # Quick smoke test
 *   node k6/run-load-test.js stress       # Stress test
 *
 * Environment Variables:
 *   K6_TARGET_URL: Target server URL (default: http://localhost:8787)
 *   ADMIN_SESSION_TOKEN: Admin session for business metrics endpoint
 */

const { execSync } = require('child_process');
const path = require('path');

const configs = {
  quick: {
    vus: 25,
    duration: '15s',
    name: 'Quick Smoke Test',
    description: '25 VUs for 15 seconds - quick validation',
  },
  normal: {
    vus: 50,
    duration: '30s',
    name: 'Standard Load Test',
    description: '50 VUs for 30 seconds - typical load test',
  },
  stress: {
    vus: 100,
    duration: '60s',
    name: 'Stress Test',
    description: '100 VUs for 60 seconds - stress the system',
  },
  endurance: {
    vus: 50,
    duration: '5m',
    name: 'Endurance Test',
    description: '50 VUs for 5 minutes - check for memory leaks',
  },
};

function runTest(configName) {
  const config = configs[configName];

  if (!config) {
    console.error(`Unknown config: ${configName}`);
    console.error(`Available configs: ${Object.keys(configs).join(', ')}`);
    process.exit(1);
  }

  const targetUrl = process.env.K6_TARGET_URL || 'http://localhost:3000';
  const adminToken = process.env.ADMIN_SESSION_TOKEN || '';

  console.log('\n' + '='.repeat(80));
  console.log(`  LOAD TEST: ${config.name}`);
  console.log('='.repeat(80));
  console.log(`  Description: ${config.description}`);
  console.log(`  Target URL: ${targetUrl}`);
  console.log(`  Virtual Users: ${config.vus}`);
  console.log(`  Duration: ${config.duration}`);
  console.log(`  Admin Token: ${adminToken ? 'provided' : 'NOT SET (business metrics will fail)'}`);
  console.log('='.repeat(80) + '\n');

  // Check if target server is responding
  try {
    console.log('Checking target server health...');
    const healthCheck = execSync(`curl -s -o /dev/null -w "%{http_code}" ${targetUrl}/api/health`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (healthCheck.trim() === '200') {
      console.log('✅ Health check passed\n');
    } else {
      console.log(`⚠️  Health check returned: ${healthCheck.trim()}`);
      console.log('   Continuing anyway...\n');
    }
  } catch (err) {
    console.log('⚠️  Could not reach health endpoint');
    console.log('   Make sure the server is running: pnpm dev or pnpm start\n');
  }

  // Build k6 command (no --vus/--duration flags - they come from env vars)
  const k6Script = path.join(__dirname, 'load-test.js');
  const k6Cmd = [
    'k6',
    'run',
    '--out',
    `json=load-test-${configName}-${new Date().toISOString().split('T')[0]}.json`,
    k6Script,
  ].join(' ');

  const env = {
    ...process.env,
    K6_TARGET_URL: targetUrl,
    APEX_VUS: String(config.vus),
    APEX_DURATION: config.duration,
  };

  if (adminToken) {
    env.ADMIN_SESSION_TOKEN = adminToken;
  }

  console.log(`Running: k6 run ${k6Script}\n`);
  console.log('-'.repeat(80));
  console.log('Test Output:');
  console.log('-'.repeat(80) + '\n');

  try {
    execSync(k6Cmd, {
      env,
      stdio: 'inherit',
      cwd: process.cwd(),
    });
  } catch (err) {
    console.error('\n' + '='.repeat(80));
    console.error('LOAD TEST FAILED');
    console.error('='.repeat(80));
    console.error(err.message);
    process.exit(1);
  }

  console.log('\n' + '='.repeat(80));
  console.log('  Load test completed');
  console.log('='.repeat(80));
  console.log(`  Results saved to: load-test-${configName}-*.json`);
  console.log(`  Markdown report printed above`);
  console.log('='.repeat(80) + '\n');
}

// Main execution
const configArg = process.argv[2] || 'normal';

if (!configs[configArg]) {
  console.error('Usage: node k6/run-load-test.js [config]');
  console.error('');
  console.error('Configs:');
  Object.entries(configs).forEach(([key, cfg]) => {
    console.error(`  ${key.padEnd(12)} - ${cfg.description} (${cfg.vus} VUs, ${cfg.duration})`);
  });
  process.exit(1);
}

runTest(configArg);
