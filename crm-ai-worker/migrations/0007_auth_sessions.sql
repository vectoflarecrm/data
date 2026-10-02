-- Security V2 Stage 1: 服务端管理会话
-- 适用：已存在的线上 D1 数据库（全新数据库直接执行 schema.sql 即可，无需本文件）
-- 执行：npx wrangler d1 execute crm-ai-db --remote --file=./migrations/0007_auth_sessions.sql
-- 说明：与 schema.sql 中的定义一致，全部使用 IF NOT EXISTS / OR IGNORE，可重复执行。
--       CI 每次部署都会跑 schema.sql，因此线上会自动获得这两张表。
-- 回滚限制：forward-only。回滚需 DROP TABLE admin_sessions, admin_users（会话全部失效，
--       操作员退回 ADMIN_PANEL_TOKEN bootstrap 登录，不影响业务数据）。

-- 会话主体：登录仍用 ADMIN_PANEL_TOKEN（bootstrap 凭据），但签发的会话绑定到
-- admin_users 行，为 RBAC（Stage 2）和禁用用户提供稳定的主体。
CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'super_admin' CHECK (role IN ('super_admin', 'operator', 'researcher', 'sender', 'readonly')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 服务端会话：只存 SHA-256(token_hash)，绝不存明文 token。
-- revoked_at 非空 = 立即失效（登出/撤销即刻生效）；expires_at 为绝对过期时间（≤1h）。
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  ip_hash TEXT,
  user_agent_hash TEXT,
  FOREIGN KEY (user_id) REFERENCES admin_users (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_sessions_token ON admin_sessions(token_hash);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry ON admin_sessions(expires_at);

INSERT OR IGNORE INTO admin_users (id, username, role) VALUES ('u_admin', 'admin', 'super_admin');
