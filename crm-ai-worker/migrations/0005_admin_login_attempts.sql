-- 面板登录暴力破解限流
-- 适用：已存在的线上 D1 数据库（全新数据库直接执行 schema.sql 即可，无需本文件）
-- 执行：npx wrangler d1 execute crm-ai-db --remote --file=./migrations/0005_admin_login_attempts.sql
-- 说明：与 schema.sql 中的定义一致，全部使用 IF NOT EXISTS，可重复执行。
--       CI 每次部署都会跑 schema.sql，因此线上会自动获得这张表。

-- scope='ip' 限制单个来源；scope='global' 是分布式喷洒也会撞到的地板
-- （只按 IP 限流会被轮换来源地址绕过）。
-- ident 在写入前会被校验为 IP 字面量——不校验的话，攻击者可以用任意
-- CF-Connecting-IP 伪造出无限多的行，把这张表撑爆。
-- 过期行在检查时顺带清理，不额外占用 cron。
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  scope TEXT NOT NULL CHECK (scope IN ('ip', 'global')),
  ident TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scope, ident)
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_updated ON admin_login_attempts(updated_at);
