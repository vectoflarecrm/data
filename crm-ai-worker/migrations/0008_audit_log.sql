-- Security V2 Stage 9: 审计日志（spec §10）
-- 适用：已存在的线上 D1 数据库（全新数据库直接执行 schema.sql 即可，无需本文件）
-- 执行：npx wrangler d1 execute crm-ai-db --remote --file=./migrations/0008_audit_log.sql
-- 说明：与 schema.sql 中的定义一致，全部使用 IF NOT EXISTS，可重复执行。
--       CI 每次部署都会跑 schema.sql，因此线上会自动获得这张表。
-- 回滚限制：forward-only。回滚需 DROP TABLE audit_logs（丢失全部审计历史），
--       不影响任何业务数据。

-- 重要操作审计（spec §10.1）：LOGIN / LOGOUT / LOGIN_FAILED / CREATE|UPDATE|DELETE_CUSTOMER /
-- IMPORT_CSV / CREATE|UPDATE|DELETE_API_KEY / CREATE|UPDATE|DELETE_GMAIL_ACCOUNT /
-- CREATE|UPDATE|DELETE_CAMPAIGN / GENERATE_EMAIL / SEND_EMAIL /
-- START|COMPLETE|FAIL_RESEARCH，外加中央授权门拒绝（ACCESS_DENIED）。
-- §10.2 铁律：任何机密值（api_key / private_key / refresh_token / password / session
-- token 等）绝不入表 —— 写入侧 redactAuditMetadata() 按键名防御性打码；ip/UA 只存哈希。
CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT,
    actor_role TEXT,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    request_id TEXT,
    metadata_json TEXT,
    ip_hash TEXT,
    user_agent_hash TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
ON audit_logs(created_at);

CREATE INDEX IF NOT EXISTS idx_audit_logs_resource
ON audit_logs(resource_type, resource_id);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor
ON audit_logs(actor_user_id);
