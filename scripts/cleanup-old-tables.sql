-- ApexOS Database Cleanup Script
-- Use with caution: removes old/obsolete tables
--
-- Usage: wrangler d1 execute apex-os-db --file scripts/cleanup-old-tables.sql
--
-- This script is for cleaning up after schema migrations.
-- Review before running on production!

BEGIN TRANSACTION;

-- Example: Drop deprecated tables after migration
-- DROP TABLE IF EXISTS old_affiliates;
-- DROP TABLE IF EXISTS temp_conversions;

-- Example: Clean up old data
-- DELETE FROM payouts 
-- WHERE status = 'failed' 
--   AND created_at < date('now', '-90 days');

-- Example: Vacuum (if using SQLite)
-- VACUUM;

COMMIT;

SELECT 'Cleanup script executed successfully. Review logs for changes.' as message;
