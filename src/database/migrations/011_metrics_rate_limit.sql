-- ============================================================
-- Add admin_metrics rate limit configuration
-- Migration 011: Business Metrics Rate Limit Config
--
-- Adds rate limiting configuration for the business metrics API endpoint:
-- - Admin metrics: 100 req/hour per authenticated admin user
-- ============================================================

INSERT OR REPLACE INTO rate_limit_configs (endpoint_type, max_requests, window_seconds, applies_to, role_multiplier, tier_multiplier, description, is_active)
VALUES
  ('admin_metrics', 100, 3600, 'user', 1.0, 1.0, 'Business metrics API - 100 req/hour per admin user', 1);

-- Verify insertion
SELECT 'Rate limit configs after update:' as status
UNION ALL
SELECT 'admin_metrics config added' as config
FROM rate_limit_configs
WHERE endpoint_type = 'admin_metrics';
