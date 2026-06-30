#!/usr/bin/env bash

# Uptime Monitoring Setup Script for ApexOS
# This script helps configure UptimeRobot monitoring for the /api/health endpoint
#
# Usage:
#   ./scripts/setup-monitoring.sh [--dry-run] [--uptimerobot] [--pingdom]
#
# Options:
#   --dry-run      Show what would be done without making changes
#   --uptimerobot  Setup UptimeRobot monitoring (default)
#   --pingdom      Setup Pingdom monitoring
#   --all          Setup all monitoring services

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
APP_URL="${NEXT_PUBLIC_APP_URL:-https://apex-os.pages.dev}"
HEALTH_ENDPOINT="${APP_URL}/api/health"
MONITOR_INTERVAL=1
ALERT_CONFIRMATION=5
TIMEOUT=10

# Alert contacts (configure these)
ALERT_EMAILS="${MONITOR_ALERT_EMAILS:-devops@yourdomain.com}"
SLACK_WEBHOOK="${SLACK_WEBHOOK_URL:-}"
PAGERDUTY_SERVICE_KEY="${PAGERDUTY_SERVICE_KEY:-}"

DRY_RUN=false
SETUP_UPTIMEROBOT=true
SETUP_PINGDOM=false

print_header() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ $1${NC}"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --uptimerobot)
            SETUP_UPTIMEROBOT=true
            shift
            ;;
        --pingdom)
            SETUP_PINGDOM=true
            shift
            ;;
        --all)
            SETUP_UPTIMEROBOT=true
            SETUP_PINGDOM=true
            shift
            ;;
        *)
            print_error "Unknown option: $1"
            exit 1
            ;;
    esac
done

print_header "ApexOS Monitoring Setup"

print_info "Configuration:"
echo "  App URL: $APP_URL"
echo "  Health Endpoint: $HEALTH_ENDPOINT"
echo "  Check Interval: ${MONITOR_INTERVAL} minute"
echo "  Alert Threshold: $ALERT_CONFIRMATION consecutive failures"
echo "  Timeout: ${TIMEOUT}s"
echo ""

# Test health endpoint first
print_header "Testing Health Endpoint"
if [ "$DRY_RUN" = false ]; then
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_ENDPOINT" --max-time 10)
    RESPONSE_TIME=$(curl -s -o /dev/null -w "%{time_total}" "$HEALTH_ENDPOINT" --max-time 10)

    if [ "$HTTP_CODE" = "200" ]; then
        print_success "Health endpoint is accessible (HTTP $HTTP_CODE, ${RESPONSE_TIME}s)"
    else
        print_error "Health endpoint returned HTTP $HTTP_CODE"
        print_warning "Please ensure the application is deployed and healthy before setting up monitoring"
        read -p "Continue anyway? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
else
    print_info "DRY RUN: Would test health endpoint: curl $HEALTH_ENDPOINT"
fi

# UptimeRobot Setup
if [ "$SETUP_UPTIMEROBOT" = true ]; then
    print_header "UptimeRobot Setup"

    print_info "Follow these steps to configure UptimeRobot:"
    echo ""
    echo "1. Go to https://uptimerobot.com and sign in"
    echo "2. Click '+ Add New Monitor'"
    echo "3. Select 'HTTP(s)' monitor type"
    echo "4. Configure:"
    echo "   - Monitor Name: ApexOS - Health Check"
    echo "   - URL (or IP): $HEALTH_ENDPOINT"
    echo "   - Monitoring Interval: $MONITOR_INTERVAL minute(s)"
    echo "   - HTTP Method: GET"
    echo "   - Expected Status Code: 200"
    echo "   - Expected String: \"status\":\"ok\""
    echo "   - Timeout: ${TIMEOUT} seconds"
    echo ""
    echo "5. Advanced Settings:"
    echo "   - Alert Contacts: Add your email and Slack webhook"
    echo "   - Alert Confirmation: $ALERT_CONFIRMATION failures"
    echo ""
    echo "6. Click 'Create Monitor'"
    echo ""

    if [ -n "$SLACK_WEBHOOK" ] && [ "$DRY_RUN" = false ]; then
        print_warning "You have SLACK_WEBHOOK_URL configured. Add it as a Webhook alert contact in UptimeRobot."
    fi

    print_success "UptimeRobot configuration documented"
fi

# Pingdom Setup
if [ "$SETUP_PINGDOM" = true ]; then
    print_header "Pingdom Setup"

    print_info "Follow these steps to configure Pingdom:"
    echo ""
    echo "1. Go to https://pingdom.com and sign in"
    echo "2. Click 'Add Check' → 'HTTP Check'"
    echo "3. Configure:"
    echo "   - Name: ApexOS - Health API"
    echo "   - URL: $HEALTH_ENDPOINT"
    echo "   - Check every: $MONITOR_INTERVAL minute(s)"
    echo "   - Probe server: US East (N. Virginia)"
    echo "   - Connection timeout: ${TIMEOUT} seconds"
    echo ""
    echo "4. Alerting:"
    echo "   - Send notification when: Down"
    echo "   - Confirm before alerting: $ALERT_CONFIRMATION minutes"
    echo "   - Add notifications: Email, Slack, PagerDuty"
    echo ""
    echo "5. Save check"
    echo ""

    print_success "Pingdom configuration documented"
fi

# Create alert templates directory
print_header "Alert Templates"

if [ "$DRY_RUN" = false ]; then
    TEMPLATE_DIR="./scripts/alert-templates"
    mkdir -p "$TEMPLATE_DIR"

    # Create Slack alert template
    cat > "$TEMPLATE_DIR/slack-alert.json" << 'EOF'
{
  "attachments": [
    {
      "fallback": "ApexOS is down",
      "color": "danger",
      "title": "🚨 ApexOS is DOWN",
      "fields": [
        {
          "title": "Monitor",
          "value": "{{monitorname}}",
          "short": true
        },
        {
          "title": "URL",
          "value": "{{url}}",
          "short": true
        },
        {
          "title": "Status Code",
          "value": "{{statuscode}}",
          "short": true
        },
        {
          "title": "Down Since",
          "value": "{{downsince}}",
          "short": true
        },
        {
          "title": "Response Time",
          "value": "{{responsetime}}ms",
          "short": true
        },
        {
          "title": "Runbook",
          "value": "https://github.com/your-org/apex-os/wiki/Incident-Runbook",
          "short": false
        }
      ],
      "footer": "ApexOS Monitoring",
      "ts": "{{timestamp}}"
    }
  ]
}
EOF
    print_success "Created Slack alert template: $TEMPLATE_DIR/slack-alert.json"

    # Create recovery notification template
    cat > "$TEMPLATE_DIR/slack-recovery.json" << 'EOF'
{
  "attachments": [
    {
      "fallback": "ApexOS is back up",
      "color": "good",
      "title": "✅ ApexOS is BACK UP",
      "fields": [
        {
          "title": "Monitor",
          "value": "{{monitorname}}",
          "short": true
        },
        {
          "title": "URL",
          "value": "{{url}}",
          "short": true
        },
        {
          "title": "Recovered At",
          "value": "{{upsince}}",
          "short": true
        },
        {
          "title": "Total Downtime",
          "value": "{{downtime}}",
          "short": true
        }
      ],
      "footer": "ApexOS Monitoring",
      "ts": "{{timestamp}}"
    }
  ]
}
EOF
    print_success "Created Slack recovery template: $TEMPLATE_DIR/slack-recovery.json"

    # Create alert contacts config
    cat > "$TEMPLATE_DIR/contacts.json" << EOF
{
  "emails": [
    "${ALERT_EMAILS}"
  ],
  "slack": {
    "webhook_url": "${SLACK_WEBHOOK}",
    "channel": "#infra-alerts"
  },
  "pagerduty": {
    "service_key": "${PAGERDUTY_SERVICE_KEY}",
    "severity": "critical"
  }
}
EOF
    print_success "Created contacts config: $TEMPLATE_DIR/contacts.json"
else
    print_info "DRY RUN: Would create alert templates in scripts/alert-templates/"
fi

print_header "Next Steps"

echo ""
echo "1. COMPLETE THE SETUP:"
echo "   - Follow the UptimeRobot/Pingdom steps above"
echo "   - Add alert contacts (email, Slack, PagerDuty)"
echo "   - Configure alert escalation (5-minute threshold)"
echo ""
echo "2. TEST THE SETUP:"
echo "   - Set maintenance mode: pnpm build && NEXT_PUBLIC_MAINTENANCE_MODE=true pnpm start"
echo "   - Or temporarily make /api/health return 503"
echo "   - Wait 5-7 minutes for alerts to trigger"
echo "   - Verify all notification channels received alerts"
echo "   - Restore service and verify recovery notifications"
echo ""
echo "3. DOCUMENT YOUR CONTACTS:"
echo "   - Update on-call rotation in your wiki"
echo "   - Document escalation procedures"
echo "   - Keep PagerDuty service key secure"
echo ""
echo "4. MONITOR MONITORING:"
echo "   - Check monitoring service status monthly"
echo "   - Review false positives and adjust thresholds"
echo "   - Update alert contacts when team changes"
echo ""

print_success "Monitoring setup script complete!"
print_info "See docs/monitoring-setup.md for full documentation"
