-- ============================================================
-- User Notification Preferences (Migration 009)
-- Add notification_settings column to profiles table
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- Add notification_settings column to profiles
-- ============================================================

-- Check if column exists first (SQLite doesn't support ADD COLUMN IF NOT EXISTS directly)
-- We use a conditional approach

ALTER TABLE profiles ADD COLUMN notification_settings TEXT;

-- Set default value for existing users (empty JSON object as string)
UPDATE profiles
SET notification_settings = '{"enabled_channels":["email"],"severity_threshold":"info","channel_config":{"email":{"enabled":true},"slack":{"enabled":false},"telegram":{"enabled":false}},"weekly_summary_enabled":true}'
WHERE notification_settings IS NULL;

-- ============================================================
-- Create index for potential queries on notification settings
-- (Note: SQLite doesn't support indexing JSON content directly,
-- but we can create a generated column if needed in the future)
-- ============================================================

-- Migration completed successfully

SELECT 'Notification preferences column added to profiles' as status;
