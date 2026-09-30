-- 2026-09: Gmail 发信账号池（面板可管理多个服务账号）
-- 适用：已存在的线上 D1 数据库（全新数据库直接执行 schema.sql 即可，无需本文件）
-- 执行：npx wrangler d1 execute crm-ai-db --remote --file=./migrations/0003_gmail_account_pool.sql
-- 注意：worker 代码里有运行时兜底（ensureGmailAccountsTable / ensureSettingsColumns），
--       表或列已存在时会报错，可跳过对应语句。

-- 1) 发信账号池表（credential_type: oauth_refresh=OAuth 令牌 / service_account=服务账号）
CREATE TABLE IF NOT EXISTS gmail_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT,
  credential_type TEXT NOT NULL DEFAULT 'service_account' CHECK (credential_type IN ('service_account', 'oauth_refresh')),
  client_email TEXT NOT NULL UNIQUE,
  private_key TEXT NOT NULL,
  delegated_domain TEXT,
  daily_limit INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_error TEXT,
  cooldown_until TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2) 发送日志记录使用哪个服务账号（按账号统计每日配额）
ALTER TABLE gmail_send_log ADD COLUMN sender_client_email TEXT;

-- 3) 品牌可绑定指定服务账号（NULL = 自动从池中分配）
ALTER TABLE outreach_settings ADD COLUMN gmail_account TEXT;
