#!/usr/bin/env tsx
/**
 * ApexOS Alerting System Test Suite
 *
 * Tests:
 * 1. Notification channel configuration validation
 * 2. Direct channel notification delivery (Slack, Email, Telegram)
 * 3. Alert Engine API integration
 * 4. Alert silencing/snooze functionality
 * 5. Rate limiting verification
 *
 * Usage:
 *   tsx scripts/test-alerting-system.ts
 *
 * Requirements:
 * - .env.local with notification configs (see .env.production.example)
 * - D1 database initialized with alert tables
 * - For local testing: wrangler dev running
 */

// Import config directly since loadConfig isn't re-exported from index
import { loadConfig, defaultContext } from '@/lib/notifications/config';
import { NotificationService, createNotificationService } from '@/lib/notifications';

interface TestResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  details?: string;
  error?: string;
}

class AlertSystemTester {
  private results: TestResult[] = [];
  private service: NotificationService | null = null;

  async run(): Promise<void> {
    console.log('='.repeat(60));
    console.log('APEXOS ALERTING SYSTEM TEST SUITE');
    console.log('='.repeat(60));
    console.log('');

    // Run test suites
    await this.testNotificationConfiguration();
    await this.testNotificationService();
    await this.testChannelConnections();
    await this.testAlertEngineAPI();
    await this.testSnoozeFeature();

    // Print summary
    this.printSummary();
  }

  // ============================================================================
  // Test Suite 1: Configuration Validation
  // ============================================================================

  private async testNotificationConfiguration(): Promise<void> {
    console.log('\n📋 Test Suite 1: Notification Configuration');
    console.log('-'.repeat(40));

    const config = loadConfig();

    // Test 1.1: Environment detection
    this.addResult({
      name: 'Environment detection',
      status: config.environment === 'development' || config.environment === 'staging' || config.environment === 'production'
        ? 'PASS'
        : 'FAIL',
      details: `Detected environment: ${config.environment}`,
    });

    // Test 1.2: Global enabled flag
    this.addResult({
      name: 'Global notifications enabled',
      status: config.enabled ? 'PASS' : 'FAIL',
      details: `NOTIFICATIONS_ENABLED = ${config.enabled}`,
    });

    // Test 1.3: Slack configuration
    const slackConfig = config.channels.slack;
    if (slackConfig) {
      this.addResult({
        name: 'Slack configuration present',
        status: 'PASS',
        details: `Webhook URL: ${slackConfig.webhookUrl ? '✓ Set' : '✗ Missing'}`,
      });
      this.addResult({
        name: 'Slack channel enabled',
        status: slackConfig.enabled ? 'PASS' : 'SKIP',
        details: `SLACK_ENABLED = ${slackConfig.enabled}`,
      });
    } else {
      this.addResult({
        name: 'Slack configuration',
        status: 'SKIP',
        details: 'SLACK_WEBHOOK_URL not set',
      });
    }

    // Test 1.4: Email configuration
    const emailConfig = config.channels.email;
    if (emailConfig) {
      this.addResult({
        name: 'Email configuration present',
        status: 'PASS',
        details: `API Key: ${emailConfig.apiKey ? '✓ Set' : '✗ Missing'}`,
      });
      this.addResult({
        name: 'Email recipients configured',
        status: emailConfig.defaultRecipients.length > 0 ? 'PASS' : 'WARN',
        details: `${emailConfig.defaultRecipients.length} recipient(s)`,
      });
      this.addResult({
        name: 'Email channel enabled',
        status: emailConfig.enabled ? 'PASS' : 'SKIP',
        details: `EMAIL_ENABLED = ${emailConfig.enabled}`,
      });
    } else {
      this.addResult({
        name: 'Email configuration',
        status: 'SKIP',
        details: 'RESEND_API_KEY not set',
      });
    }

    // Test 1.5: Telegram configuration
    const telegramConfig = config.channels.telegram;
    if (telegramConfig) {
      this.addResult({
        name: 'Telegram configuration present',
        status: 'PASS',
        details: `Bot token: ${telegramConfig.botToken ? '✓ Set' : '✗ Missing'}, Chat IDs: ${telegramConfig.chatIds.length}`,
      });
      this.addResult({
        name: 'Telegram chat IDs configured',
        status: telegramConfig.chatIds.length > 0 ? 'PASS' : 'WARN',
        details: `${telegramConfig.chatIds.length} chat(s)`,
      });
      this.addResult({
        name: 'Telegram channel enabled',
        status: telegramConfig.enabled ? 'PASS' : 'SKIP',
        details: `TELEGRAM_ENABLED = ${telegramConfig.enabled}`,
      });
    } else {
      this.addResult({
        name: 'Telegram configuration',
        status: 'SKIP',
        details: 'TELEGRAM_BOT_TOKEN not set',
      });
    }

    // Test 1.6: Rate limiting config
    this.addResult({
      name: 'Rate limiting configured',
      status: config.rateLimitPerMinute > 0 ? 'PASS' : 'FAIL',
      details: `${config.rateLimitPerMinute} notifications/minute`,
    });

    // Test 1.7: Retry configuration
    this.addResult({
      name: 'Retry configuration',
      status: config.retries.maxAttempts > 0 && config.retries.backoffMs > 0 ? 'PASS' : 'FAIL',
      details: `Max attempts: ${config.retries.maxAttempts}, Backoff: ${config.retries.backoffMs}ms`,
    });

    // Test 1.8: Default context
    const ctx = defaultContext();
    this.addResult({
      name: 'Default context configured',
      status: ctx.baseUrl && ctx.appName ? 'PASS' : 'FAIL',
      details: `App: ${ctx.appName}, URL: ${ctx.baseUrl}`,
    });
  }

  // ============================================================================
  // Test Suite 2: Notification Service Initialization
  // ============================================================================

  private async testNotificationService(): Promise<void> {
    console.log('\n🔧 Test Suite 2: Notification Service');
    console.log('-'.repeat(40));

    try {
      this.service = createNotificationService();
      const service = this.service;

      // Test 2.1: Service initialization
      this.addResult({
        name: 'Service instantiation',
        status: 'PASS',
        details: 'NotificationService created successfully',
      });

      // Test 2.2: Get enabled channels
      const enabledChannels = service.getEnabledChannels();
      this.addResult({
        name: 'Enabled channels detection',
        status: Array.isArray(enabledChannels) ? 'PASS' : 'FAIL',
        details: `Enabled: ${enabledChannels.join(', ') || 'none'}`,
      });

      // Test 2.3: Channel checks
      const config = service.getConfig();
      if (config.channels.slack?.enabled) {
        this.addResult({
          name: 'Slack channel registered',
          status: service.hasChannel('slack') ? 'PASS' : 'FAIL',
          details: '',
        });
      }
      if (config.channels.email?.enabled) {
        this.addResult({
          name: 'Email channel registered',
          status: service.hasChannel('email') ? 'PASS' : 'FAIL',
          details: '',
        });
      }
      if (config.channels.telegram?.enabled) {
        this.addResult({
          name: 'Telegram channel registered',
          status: service.hasChannel('telegram') ? 'PASS' : 'FAIL',
          details: '',
        });
      }

      // Test 2.4: Context retrieval
      const ctx = service.getContext();
      this.addResult({
        name: 'Context retrieval',
        status: ctx.baseUrl && ctx.appName ? 'PASS' : 'FAIL',
        details: `Base URL: ${ctx.baseUrl}, Locale: ${ctx.locale}`,
      });

      // Test 2.5: Config retrieval
      const retrievedConfig = service.getConfig();
      this.addResult({
        name: 'Config retrieval',
        status: retrievedConfig.environment ? 'PASS' : 'FAIL',
        details: `Environment: ${retrievedConfig.environment}`,
      });
    } catch (error) {
      this.addResult({
        name: 'Service initialization',
        status: 'FAIL',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // ============================================================================
  // Test Suite 3: Channel Connection Tests
  // ============================================================================

  private async testChannelConnections(): Promise<void> {
    console.log('\n📡 Test Suite 3: Channel Connection Tests');
    console.log('-'.repeat(40));

    if (!this.service) {
      this.addResult({
        name: 'Channel tests prerequisite',
        status: 'SKIP',
        details: 'NotificationService not initialized',
      });
      return;
    }

    const config = this.service.getConfig();

    // Test Slack
    if (config.channels.slack?.enabled) {
      await this.testSlackConnection();
    } else {
      this.addResult({
        name: 'Slack connection test',
        status: 'SKIP',
        details: 'Slack not configured',
      });
    }

    // Test Email
    if (config.channels.email?.enabled) {
      await this.testEmailConnection();
    } else {
      this.addResult({
        name: 'Email connection test',
        status: 'SKIP',
        details: 'Email not configured',
      });
    }

    // Test Telegram
    if (config.channels.telegram?.enabled) {
      await this.testTelegramConnection();
    } else {
      this.addResult({
        name: 'Telegram connection test',
        status: 'SKIP',
        details: 'Telegram not configured',
      });
    }
  }

  private async testSlackConnection(): Promise<void> {
    try {
      const results = await this.service!.sendCustom(
        '🧪 ApexOS Alert System Test',
        'This is a test notification from the ApexOS alerting system. If you see this, Slack integration is working.',
        {
          test: true,
          timestamp: new Date().toISOString(),
          actions: [
            { label: 'View Dashboard', url: 'https://apex-os.pages.dev/admin/monitoring' },
            { label: 'Alert Config', url: 'https://apex-os.pages.dev/admin/alerts/config' },
          ],
        },
        { priority: 'normal', channels: ['slack'] }
      );

      const result = results[0];
      this.addResult({
        name: 'Slack notification send',
        status: result.success ? 'PASS' : 'FAIL',
        details: result.success ? `Message ID: ${result.messageId}` : `Error: ${result.error}`,
        error: result.error,
      });
    } catch (error) {
      this.addResult({
        name: 'Slack notification send',
        status: 'FAIL',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private async testEmailConnection(): Promise<void> {
    try {
      const results = await this.service!.sendCustom(
        '🧪 ApexOS Alert System Test',
        'This is a test notification from the ApexOS alerting system. If you receive this email, the Resend integration is working correctly.',
        {
          test: true,
          timestamp: new Date().toISOString(),
          priority: 'normal',
        },
        { priority: 'normal', channels: ['email'] }
      );

      const result = results[0];
      this.addResult({
        name: 'Email notification send',
        status: result.success ? 'PASS' : 'FAIL',
        details: result.success ? `Message ID: ${result.messageId}` : `Error: ${result.error}`,
        error: result.error,
      });
    } catch (error) {
      this.addResult({
        name: 'Email notification send',
        status: 'FAIL',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private async testTelegramConnection(): Promise<void> {
    try {
      const results = await this.service!.sendCustom(
        '🧪 ApexOS Alert System Test',
        'This is a test notification from the ApexOS alerting system. If you see this message, Telegram integration is working.',
        {
          test: true,
          timestamp: new Date().toISOString(),
        },
        { priority: 'normal', channels: ['telegram'] }
      );

      const result = results[0];
      this.addResult({
        name: 'Telegram notification send',
        status: result.success ? 'PASS' : 'FAIL',
        details: result.success ? `Message ID: ${result.messageId}` : `Error: ${result.error}`,
        error: result.error,
      });
    } catch (error) {
      this.addResult({
        name: 'Telegram notification send',
        status: 'FAIL',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // ============================================================================
  // Test Suite 4: Alert Engine API Tests
  // ============================================================================

  private async testAlertEngineAPI(): Promise<void> {
    console.log('\n🔔 Test Suite 4: Alert Engine API');
    console.log('-'.repeat(40));

    // Check if running in Cloudflare Pages environment (DB binding)
    // @ts-ignore
    const db = typeof DB !== 'undefined' ? DB : null;

    if (!db) {
      this.addResult({
        name: 'Alert Engine API test',
        status: 'SKIP',
        details: 'Not running in Cloudflare Pages environment (DB binding not available)',
      });
      return;
    }

    try {
      // Test 4.1: Get alert engine status
      const statusResponse = await fetch('/api/monitoring/alert-engine');
      if (statusResponse.ok) {
        const statusData = await statusResponse.json();
        this.addResult({
          name: 'Alert Engine status endpoint',
          status: 'PASS',
          details: `Rules: ${statusData.data?.enabledRules || 0} enabled`,
        });
      } else {
        this.addResult({
          name: 'Alert Engine status endpoint',
          status: 'FAIL',
          details: `HTTP ${statusResponse.status}`,
        });
      }

      // Test 4.2: Trigger manual alert evaluation
      const runResponse = await fetch('/api/monitoring/alert-engine?run=true');
      if (runResponse.ok) {
        const runData = await runResponse.json();
        this.addResult({
          name: 'Alert Engine run endpoint',
          status: 'PASS',
          details: `Triggered ${runData.data?.alertsTriggered || 0} alerts`,
        });
      } else {
        this.addResult({
          name: 'Alert Engine run endpoint',
          status: 'FAIL',
          details: `HTTP ${runResponse.status}`,
        });
      }

      // Test 4.3: Check snooze endpoint
      const snoozeResponse = await fetch('/api/monitoring/d1/snoozes');
      if (snoozeResponse.ok) {
        const snoozeData = await snoozeResponse.json();
        this.addResult({
          name: 'Snooze management API',
          status: 'PASS',
          details: `Active snoozes: ${snoozeData.data?.length || 0}`,
        });
      } else {
        this.addResult({
          name: 'Snooze management API',
          status: 'FAIL',
          details: `HTTP ${snoozeResponse.status}`,
        });
      }
    } catch (error) {
      this.addResult({
        name: 'Alert Engine API test',
        status: 'FAIL',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // ============================================================================
  // Test Suite 5: Snooze/Silence Feature Tests
  // ============================================================================

  private async testSnoozeFeature(): Promise<void> {
    console.log('\n🔇 Test Suite 5: Alert Snooze/Silence Feature');
    console.log('-'.repeat(40));

    // @ts-ignore
    const db = typeof DB !== 'undefined' ? DB : null;

    if (!db) {
      this.addResult({
        name: 'Snooze feature test',
        status: 'SKIP',
        details: 'Not running in Cloudflare Pages environment',
      });
      return;
    }

    try {
      // Import d1-monitor functions
      const { createSnooze, getActiveSnoozes, deleteSnooze, getSnoozeForConfig } = await import('@/lib/monitoring/d1-monitor');

      // Test 5.1: Get active snoozes (should work even with none)
      const activeSnoozes = await getActiveSnoozes(db);
      this.addResult({
        name: 'Get active snoozes',
        status: 'PASS',
        details: `${activeSnoozes.length} active snooze(s)`,
      });

      // Test 5.2: Create test snooze (if we have alert configs)
      const configsResult = await db
        .prepare('SELECT id FROM d1_alert_configs WHERE is_enabled = 1 LIMIT 1')
        .first<{ id: string }>();

      if (configsResult?.id) {
        const testSnooze = await createSnooze(db, {
          alertConfigId: configsResult.id,
          durationMinutes: 60, // 1 hour
          reason: 'Test snooze - automated testing',
          snoozedBy: 'test-script',
        });

        this.addResult({
          name: 'Create snooze',
          status: testSnooze ? 'PASS' : 'FAIL',
          details: testSnooze ? `Snooze ID: ${testSnooze.id}, Expires: ${testSnooze.expiresAt.toISOString()}` : 'Failed to create',
        });

        // Test 5.3: Verify snooze created
        const checkSnooze = await getSnoozeForConfig(db, configsResult.id);
        this.addResult({
          name: 'Verify snooze exists',
          status: checkSnooze ? 'PASS' : 'FAIL',
          details: checkSnooze ? `Found snooze for config ${configsResult.id}` : 'Snooze not found',
        });

        // Test 5.4: Get active snoozes again (should have 1)
        const afterCreateSnoozes = await getActiveSnoozes(db);
        this.addResult({
          name: 'Active snoozes after create',
          status: afterCreateSnoozes.length === 1 ? 'PASS' : 'FAIL',
          details: `${afterCreateSnoozes.length} active snooze(s)`,
        });

        // Test 5.5: Delete snooze
        const deleted = await deleteSnooze(db, testSnooze.id);
        this.addResult({
          name: 'Delete snooze',
          status: deleted ? 'PASS' : 'FAIL',
          details: deleted ? `Snooze ${testSnooze.id} deleted` : 'Delete failed',
        });

        // Test 5.6: Verify deletion
        const afterDeleteSnooze = await getSnoozeForConfig(db, configsResult.id);
        this.addResult({
          name: 'Verify snooze deleted',
          status: afterDeleteSnooze === null ? 'PASS' : 'FAIL',
          details: afterDeleteSnooze ? 'Snooze still exists' : 'Snooze successfully removed',
        });
      } else {
        this.addResult({
          name: 'Snooze with alert config',
          status: 'SKIP',
          details: 'No alert configurations found in database',
        });
      }

      // Test 5.7: Snooze cleanup
      const cleanupCount = await (await import('@/lib/monitoring/d1-monitor')).cleanupExpiredSnoozes(db);
      this.addResult({
        name: 'Cleanup expired snoozes',
        status: 'PASS',
        details: `${cleanupCount} expired snooze(s) cleaned up`,
      });
    } catch (error) {
      this.addResult({
        name: 'Snooze feature test',
        status: 'FAIL',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private addResult(result: TestResult): void {
    this.results.push(result);

    const statusIcon = result.status === 'PASS' ? '✅' : result.status === 'FAIL' ? '❌' : result.status === 'SKIP' ? '⏭️' : '⚠️';
    console.log(`${statusIcon} ${result.name}`);
    if (result.details) {
      console.log(`   └─ ${result.details}`);
    }
    if (result.error) {
      console.log(`   └─ Error: ${result.error}`);
    }
  }

  private printSummary(): void {
    console.log('\n' + '='.repeat(60));
    console.log('TEST SUMMARY');
    console.log('='.repeat(60));

    const passed = this.results.filter(r => r.status === 'PASS').length;
    const failed = this.results.filter(r => r.status === 'FAIL').length;
    const skipped = this.results.filter(r => r.status === 'SKIP').length;
    const warned = this.results.filter(r => r.status === 'WARN').length;
    const total = this.results.length;

    console.log(`\nTotal Tests: ${total}`);
    console.log(`  ✅ Passed:  ${passed}`);
    console.log(`  ❌ Failed:  ${failed}`);
    console.log(`  ⚠️  Warnings: ${warned}`);
    console.log(`  ⏭️  Skipped:  ${skipped}`);

    const successRate = ((passed / (total - skipped)) * 100).toFixed(1);
    console.log(`\nSuccess Rate: ${successRate}% (${passed}/${total - skipped})`);

    if (failed > 0) {
      console.log('\n❌ FAILED TESTS:');
      this.results
        .filter(r => r.status === 'FAIL')
        .forEach(r => {
          console.log(`  - ${r.name}`);
          if (r.error) console.log(`    └─ ${r.error}`);
        });
    }

    if (warned > 0) {
      console.log('\n⚠️  WARNINGS:');
      this.results
        .filter(r => r.status === 'WARN')
        .forEach(r => {
          console.log(`  - ${r.name}: ${r.details}`);
        });
    }

    console.log('\n' + '='.repeat(60));

    // Overall status
    const allPassed = failed === 0;
    if (allPassed) {
      console.log('✅ ALL TESTS PASSED (or skipped due to config)');
    } else {
      console.log('❌ SOME TESTS FAILED - Review configuration and try again');
    }

    console.log('='.repeat(60));

    // Configuration checklist
    console.log('\n📝 CONFIGURATION CHECKLIST:');
    console.log('-'.repeat(40));

    const config = loadConfig();
    const missingConfigs: string[] = [];

    if (!config.channels.slack?.enabled) missingConfigs.push('Slack (SLACK_WEBHOOK_URL, SLACK_ENABLED=true)');
    if (!config.channels.email?.enabled) missingConfigs.push('Email (RESEND_API_KEY)');
    if (!config.channels.telegram?.enabled) missingConfigs.push('Telegram (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_IDS)');

    if (missingConfigs.length > 0) {
      console.log('\nDisabled channels (set env vars to enable):');
      missingConfigs.forEach(c => console.log(`  • ${c}`));
    } else {
      console.log('\n✅ All notification channels are configured and enabled');
    }

    console.log('\n' + '='.repeat(60));
    console.log('Test completed at:', new Date().toISOString());
    console.log('='.repeat(60));
  }
}

// Run the test suite
const tester = new AlertSystemTester();
tester.run().catch(error => {
  console.error('Test suite failed:', error);
  process.exit(1);
});
