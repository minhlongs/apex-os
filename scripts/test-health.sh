#!/usr/bin/env bash

# Health Check Test Script for ApexOS
# Tests the /api/health endpoint with various options
#
# Usage:
#   ./scripts/test-health.sh [options]
#
# Options:
#   --url URL          Health endpoint URL (default: from NEXT_PUBLIC_APP_URL or https://apex-os.pages.dev/api/health)
#   --verbose         Show full JSON response
#   --iterations N    Run N iterations (default: 1)
#   --interval N      Wait N seconds between iterations (default: 0)
#   --timeout N       Request timeout in seconds (default: 10)
#   --markdown        Output results in markdown table format
#
# Examples:
#   ./scripts/test-health.sh                              # Single test
#   ./scripts/test-health.sh --verbose                   # Show full JSON
#   ./scripts/test-health.sh --iterations 10 --interval 5  # Test every 5s, 10 times
#   NEXT_PUBLIC_APP_URL=https://staging.example.com ./scripts/test-health.sh --markdown

set -e

# Configuration
HEALTH_URL="${NEXT_PUBLIC_APP_URL:-https://apex-os.pages.dev}/api/health"
VERBOSE=false
ITERATIONS=1
INTERVAL=0
TIMEOUT=10
MARKDOWN=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --url)
            HEALTH_URL="$2"
            shift 2
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --iterations)
            ITERATIONS="$2"
            shift 2
            ;;
        --interval)
            INTERVAL="$2"
            shift 2
            ;;
        --timeout)
            TIMEOUT="$2"
            shift 2
            ;;
        --markdown)
            MARKDOWN=true
            shift
            ;;
        -h|--help)
            echo "Health Check Test Script for ApexOS"
            echo ""
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --url URL          Health endpoint URL"
            echo "  --verbose         Show full JSON response"
            echo "  --iterations N    Run N iterations (default: 1)"
            echo "  --interval N      Wait N seconds between iterations (default: 0)"
            echo "  --timeout N       Request timeout in seconds (default: 10)"
            echo "  --markdown        Output results in markdown table format"
            echo "  -h, --help        Show this help message"
            echo ""
            echo "Examples:"
            echo "  $0                              # Single test"
            echo "  $0 --verbose                   # Show full JSON"
            echo "  $0 --iterations 10 --interval 5  # Test every 5s"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Results storage
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
AVG_RESPONSE_TIME=0
ALL_TIMES=()

print_header() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

print_result() {
    local status="$1"
    local time="$2"
    local http_code="$3"
    local message="$4"

    if [ "$status" = "PASS" ]; then
        echo -e "${GREEN}✓ PASS${NC}  HTTP $http_code  ${time}s  $message"
    else
        echo -e "${RED}✗ FAIL${NC}  HTTP $http_code  ${time}s  $message"
    fi
}

run_test() {
    local start_time=$(date +%s.%N)
    local response
    local http_code

    # Make request with timeout
    response=$(curl -s -m "$TIMEOUT" -H "Accept: application/json" "$HEALTH_URL" 2>/dev/null) || true
    http_code=$(curl -s -o /dev/null -w "%{http_code}" -m "$TIMEOUT" "$HEALTH_URL" 2>/dev/null) || http_code="000"
    local end_time=$(date +%s.%N)

    local total_time=$(echo "$end_time - $start_time" | bc -l 2>/dev/null || echo "0")
    ALL_TIMES+=("$total_time")

    # Parse response
    if [ -z "$response" ] || [ "$response" = "{}" ]; then
        echo "FAIL|$http_code|$total_time|No response or empty response"
        return
    fi

    # Check status
    local status_field=$(echo "$response" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
    local db_status=$(echo "$response" | grep -o '"database":"[^"]*"' | cut -d'"' -f4)

    if [ "$http_code" = "200" ] && [ "$status_field" = "ok" ]; then
        local msg="status=$status_field, database=$db_status"
        echo "PASS|$http_code|$total_time|$msg"
    elif [ "$http_code" = "200" ] && [ "$status_field" = "degraded" ]; then
        local msg="status=$status_field (WARNING), database=$db_status"
        echo "WARN|$http_code|$total_time|$msg"
    else
        local msg="status=$status_field, database=$db_status"
        echo "FAIL|$http_code|$total_time|$msg"
    fi
}

print_markdown_header() {
    echo "| Timestamp | Status | HTTP Code | Response Time | Details |"
    echo "|-----------|--------|-----------|---------------|---------|"
}

print_markdown_row() {
    local timestamp=$(date -u +"%Y-%m-%d %H:%M:%S UTC")
    local status="$1"
    local http_code="$2"
    local time="$3"
    local details="$4"
    echo "| $timestamp | $status | $http_code | ${time}s | $details |"
}

# Main execution
print_header "ApexOS Health Check Test"
echo ""
echo "Target: $HEALTH_URL"
echo "Timeout: ${TIMEOUT}s"
echo "Iterations: $ITERATIONS"
if [ "$INTERVAL" -gt 0 ]; then
    echo "Interval: ${INTERVAL}s"
fi
echo ""

if [ "$MARKDOWN" = true ]; then
    print_markdown_header
fi

for (( i=1; i<=ITERATIONS; i++ )); do
    if [ "$MARKDOWN" = false ]; then
        echo -n "Test $i/$ITERATIONS: "
    fi

    TOTAL_TESTS=$((TOTAL_TESTS + 1))

    result=$(run_test)
    IFS='|' read -r status http_code time details <<< "$result"

    case "$status" in
        PASS)
            PASSED_TESTS=$((PASSED_TESTS + 1))
            ;;
        WARN)
            PASSED_TESTS=$((PASSED_TESTS + 1))
            ;;
        FAIL)
            FAILED_TESTS=$((FAILED_TESTS + 1))
            ;;
    esac

    if [ "$MARKDOWN" = true ]; then
        print_markdown_row "$status" "$http_code" "$time" "$details"
    else
        print_result "$status" "$time" "$http_code" "$details"
    fi

    # Show verbose response
    if [ "$VERBOSE" = true ] && [ "$MARKDOWN" = false ]; then
        echo "  Full response:"
        curl -s -m "$TIMEOUT" "$HEALTH_URL" | sed 's/^/    /'
        echo ""
    fi

    # Wait between iterations
    if [ "$i" -lt "$ITERATIONS" ] && [ "$INTERVAL" -gt 0 ]; then
        sleep "$INTERVAL"
    fi
done

# Calculate average response time
if [ ${#ALL_TIMES[@]} -gt 0 ]; then
    sum=0
    for t in "${ALL_TIMES[@]}"; do
        sum=$(echo "$sum + $t" | bc -l)
    done
    AVG_RESPONSE_TIME=$(echo "scale=3; $sum / ${#ALL_TIMES[@]}" | bc -l)
fi

# Summary
print_header "Summary"
echo "Total Tests:    $TOTAL_TESTS"
echo -e "Passed:         ${GREEN}$PASSED_TESTS${NC}"
echo -e "Failed:         ${RED}$FAILED_TESTS${NC}"
echo "Avg Response:   ${AVG_RESPONSE_TIME}s"
echo ""

if [ "$FAILED_TESTS" -eq 0 ]; then
    print_success "All health checks passed!"
    exit 0
else
    print_error "Some health checks failed!"
    exit 1
fi
