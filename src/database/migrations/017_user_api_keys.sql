-- Phase 017: user_api_keys table cho lưu trữ API keys của user.
--
-- Lưu trữ API keys từ các provider (Binance, Bybit, Resend) đã mã hóa.
-- encrypted_key BLOB = dữ liệu mã hóa, giải mã ở app-level.
--
-- PRIMARY KEY (user_id, provider) đảm bảo mỗi user chỉ có 1 key/provider.
-- Provider values: 'binance', 'bybit', 'resend' (không enum trong DB).
--
-- Trigger tự động cập nhật updated_at khi row được UPDATE.
-- Idempotent: có thể chạy nhiều lần an toàn.

PRAGMA foreign_keys = ON;

-- Xóa cũ nếu tồn tại (idempotent)
DROP TRIGGER IF EXISTS trg_user_api_keys_updated;
DROP INDEX IF EXISTS idx_user_api_keys_user;
DROP TABLE IF EXISTS user_api_keys;

-- Tạo bảng mới
CREATE TABLE user_api_keys (
  user_id       TEXT NOT NULL,
  provider      TEXT NOT NULL,
  encrypted_key BLOB NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, provider)
);

-- Index để fast-listing keys của một user
CREATE INDEX idx_user_api_keys_user
  ON user_api_keys(user_id);

-- Trigger: tự động set updated_at = datetime('now') sau mỗi UPDATE
CREATE TRIGGER trg_user_api_keys_updated
  AFTER UPDATE ON user_api_keys
FOR EACH ROW
BEGIN
  UPDATE user_api_keys
  SET updated_at = datetime('now')
  WHERE user_id = NEW.user_id AND provider = NEW.provider;
END;
