-- 2026-10: post-V2 Stage 33 — 业务表补 request_id 列（追踪链缩短）
-- 背景：Stage 20 给每个 admin 请求发一个 UUID（响应头 X-Request-ID、
--       audit_logs.request_id），但业务事件行（生成草稿、发送尝试、导入行）
--       不带它——"这封邮件为什么被发送"要先经过多层间接关联才能对上请求。
-- 修复：outreach_emails / gmail_send_log / customer_imports 三张 admin 请求
--       驱动的事件表各补 request_id TEXT，写入点从 getRequestId(request)
--       取值（与该请求所有 audit 行同一个 id）。
-- 刻意排除（语义上就不该有）：
--   research_runs / evidence —— 仅由 cron 触发，没有 HTTP 请求上下文，
--     行的关联键是 research_run_id（evidence.research_run_id → run）；
--     塞一个永远为 NULL 的 request_id 反而误导。
--   api_key_usage —— 每键每日累计计数行（聚合语义），不是事件行。
-- 存量线上库：本文件 + deploy workflow 的幂等 ALTER 块（duplicate column
--       容忍 + pragma_table_info 校验）。
-- 全新数据库：schema.sql 已含列，本文件为无操作。
ALTER TABLE outreach_emails ADD COLUMN request_id TEXT;
ALTER TABLE gmail_send_log ADD COLUMN request_id TEXT;
ALTER TABLE customer_imports ADD COLUMN request_id TEXT;
