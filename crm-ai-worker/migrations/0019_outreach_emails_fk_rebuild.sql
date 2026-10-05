-- 2026-10: post-V2 Stage 34 — 存量库 outreach_emails 补 FOREIGN KEY 声明
-- 背景：SQLite 无法对已有表 ALTER 添加 FOREIGN KEY 约束（与 CHECK(enc:v1:)
--       同一个平台限制）。fresh install 的 schema.sql 一直带
--       FOREIGN KEY (customer_id) REFERENCES customers(id)，且 D1 对每个
--       事务默认强制 FK —— 即新装库已经在约束下运行；只有存量库的
--       outreach_emails 是无 FK 的旧形态（schema 漂移，Stage 23 同类）。
-- 修复：单事务表重建（D1 把 --file 的整个文件作为一个隐式事务执行，
--       任一语句失败整体回滚 —— "D1 fails a whole schema file" 是仓库
--       已验证的行为）：
--         DROP IF EXISTS 临时表 → CREATE 新表（schema.sql 同构 + FK）→
--         INSERT SELECT（显式列名，顺序无关）→ DROP 旧表 → RENAME →
--         重建该表全部 5 个索引（DROP TABLE 会带走表上索引）。
-- 幂等：文件可重复执行（开头 DROP TABLE IF EXISTS；重复执行 = 再搬移
--       一遍数据，结果等价）。生产 CI 以 FK 存在性检测为准 —— 已有 FK
--       则整块跳过，不做无谓搬移（rows_written 配额友好）。
-- 孤儿防线：customers 从无 DELETE 路径（结构性防孤儿，stage-17），存量
--       应无孤行；CI 在执行前仍检测孤儿，>0 则明确报错并列出清理 SQL，
--       绝不静默删改业务数据。
-- 不使用 PRAGMA defer_foreign_keys：本迁移父表（customers）原地不动、
--       子表按显式列名搬移，无需延迟检查。且实测（node:sqlite 构建的
--       SQLite）在 COMMIT 前执行 `defer_foreign_keys = off` 会清掉延迟
--       违规计数、令孤儿行静默落库 —— 留开不关才能在 COMMIT 处报错。
--       不引入 defer 后，孤儿在 INSERT SELECT 语句处立即失败：整文件
--       单事务回滚（D1 隐式事务语义），错误定位更准。
DROP TABLE IF EXISTS outreach_emails_new;
CREATE TABLE outreach_emails_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER,
  company_id TEXT,
  display_id TEXT,
  company_name TEXT,
  email_to TEXT,
  product_category TEXT,
  brand_name TEXT,
  subject TEXT,
  body TEXT,
  status TEXT DEFAULT 'draft',
  sent_at TIMESTAMP,
  idempotency_key TEXT,
  send_attempts INTEGER NOT NULL DEFAULT 0,
  locked_at TEXT,
  locked_by TEXT,
  last_error TEXT,
  gmail_message_id TEXT,
  request_id TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);
INSERT INTO outreach_emails_new
  (id, customer_id, company_id, display_id, company_name, email_to,
   product_category, brand_name, subject, body, status, sent_at,
   idempotency_key, send_attempts, locked_at, locked_by, last_error,
   gmail_message_id, request_id, created_at)
SELECT
  id, customer_id, company_id, display_id, company_name, email_to,
  product_category, brand_name, subject, body, status, sent_at,
  idempotency_key, send_attempts, locked_at, locked_by, last_error,
  gmail_message_id, request_id, created_at
FROM outreach_emails;
DROP TABLE outreach_emails;
ALTER TABLE outreach_emails_new RENAME TO outreach_emails;
CREATE INDEX IF NOT EXISTS idx_outreach_customer_id ON outreach_emails(customer_id);
CREATE INDEX IF NOT EXISTS idx_outreach_status ON outreach_emails(status);
CREATE INDEX IF NOT EXISTS idx_outreach_product ON outreach_emails(product_category);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_idempotency
  ON outreach_emails(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outreach_send_lock
  ON outreach_emails(status, locked_at);
