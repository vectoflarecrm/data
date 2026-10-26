-- ⑦ Gmail 入站同步（vs OpenCRM 的 Gmail Sync）：
-- crm_mail_sync   — 每个发件邮箱的同步游标（Gmail internalDate 毫秒），
--                   连续失败计数 + 最近错误（退避/诊断用）。
-- crm_mail_seen   — 已处理消息去重（Gmail message id），保证同步幂等：
--                   重复 tick / 交叠 cron 永远不会写重复的收件时间线。
CREATE TABLE IF NOT EXISTS crm_mail_sync (
  mailbox TEXT PRIMARY KEY,
  last_internal_date INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_error TEXT,
  error_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS crm_mail_seen (
  mailbox TEXT NOT NULL,
  message_id TEXT NOT NULL,
  received_at TEXT,
  PRIMARY KEY (mailbox, message_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_mail_seen_mailbox ON crm_mail_seen(mailbox);
