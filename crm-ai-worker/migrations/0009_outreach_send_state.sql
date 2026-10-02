-- Security V2 Stage 10 (spec §11): Gmail 发送状态机.
--
-- outreach_emails 原本只有 draft/sent 两个事实点，Gmail API 调用与 DB 写入之间
-- 没有任何状态记录（§11.2 禁止的形态）：并发点击会重复发送，Worker 在 Gmail
-- 成功后、写库前崩溃会把"已发出"伪装成"未发送"。本迁移补齐状态机所需的全部
-- 列与约束：
--   status            状态机本体（复用现有列）：draft/reserved/sending/sent/
--                     failed/uncertain/cancelled
--   idempotency_key   campaign_id + customer_id + 内容版本 的稳定哈希；
--                     唯一部分索引把"同一逻辑消息出现两行"变成 claim 时的
--                     拒绝而不是一次重复发送
--   send_attempts     每次成功 claim 自增，审计/排障用
--   locked_at/by      claim 时间与 Worker 标识；超时锁由 reap 保守回收
--                     （reserved→draft 可重试；sending→uncertain 永不自动重发）
--   last_error        最近一次失败/未知原因（截断 300 字符）
--   gmail_message_id  Gmail 接受后的 message id，人工核实时可到发件箱对账

ALTER TABLE outreach_emails ADD COLUMN idempotency_key TEXT;
ALTER TABLE outreach_emails ADD COLUMN send_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outreach_emails ADD COLUMN locked_at TEXT;
ALTER TABLE outreach_emails ADD COLUMN locked_by TEXT;
ALTER TABLE outreach_emails ADD COLUMN last_error TEXT;
ALTER TABLE outreach_emails ADD COLUMN gmail_message_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_idempotency
ON outreach_emails(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- 锁回收扫描：status + locked_at 定位超时行。
CREATE INDEX IF NOT EXISTS idx_outreach_send_lock
ON outreach_emails(status, locked_at);
