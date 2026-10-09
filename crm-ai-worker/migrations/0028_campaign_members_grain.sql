-- 2026-10: Phase 9 Stage 53 — outreach_campaign_members 粒度键重建
-- 背景：表的 PRIMARY KEY (campaign_id, customer_id) 把「每公司恰好一行」
--       写死，Phase 8 的 per-person 粒度因此只能每公司取一个联系人。
--       Phase 9（docs/phase9-contact-multi-touch.md §3，operator 签核
--       2026-10-09）放开为「每公司至多 N 个联系人」（filters 里的
--       contacts_per_company，服务端上限 3），成员表必须允许同公司
--       多行、且每种粒度仍各只许一行。
-- 平台限制（实证，node:sqlite 探针）：
--   1) SQLite 不允许生成列出现在 PRIMARY KEY 中（"generated columns
--      cannot be part of the PRIMARY KEY"）；
--   2) contact_id 可空，而 SQLite 对 PK/UNIQUE 里的 NULL 各自视为互异，
--      (campaign, customer, NULL) 的重复行不会违规——contact_id 裸进
--      唯一键挡不住公司粒度重复。
-- 结论：重建后的表不带显式 PK（隐式 rowid），粒度唯一性由
--   contact_norm（STORED 生成列 COALESCE(contact_id, 0)）上的 UNIQUE
--   INDEX 保证——实证对两种粒度都拒绝重复：公司行 (c, cu, NULL→0)
--   二次插入违规；联系人行 (c, cu, id) 重复违规。写入方只写
--   contact_id，contact_norm 只此一处定义，无双重写入纪律问题。
-- 修复：单事务表重建（D1 对 --file 整文件一个隐式事务，任一语句失败
--   整体回滚——0019 已验证的同款行为）：
--     DROP IF EXISTS 临时表 → CREATE 新表 → INSERT SELECT（显式列名；
--     不搬 contact_norm——生成列不能被 INSERT 指定）→ DROP 旧表 →
--     RENAME → 重建 queue 索引 + 新建 grain 唯一索引。
-- 幂等：文件可重复执行（开头 DROP TABLE IF EXISTS；重复执行 = 再搬移
--   一遍，结果等价；对已重建库重跑同样安全）。
-- 本表无 FOREIGN KEY、无 AUTOINCREMENT（outreach_email_id 是软引用，
--   无单调性依赖），不涉及父表搬移——0019 的孤儿防线在此不适用。
DROP TABLE IF EXISTS outreach_campaign_members_new;
CREATE TABLE outreach_campaign_members_new (
  campaign_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  contact_id INTEGER,
  contact_norm INTEGER NOT NULL GENERATED ALWAYS AS (COALESCE(contact_id, 0)) STORED,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'generated', 'sent', 'skipped', 'failed')),
  outreach_email_id INTEGER,
  error TEXT
);
INSERT INTO outreach_campaign_members_new
  (campaign_id, customer_id, contact_id, status, outreach_email_id, error)
SELECT
  campaign_id, customer_id, contact_id, status, outreach_email_id, error
FROM outreach_campaign_members;
DROP TABLE outreach_campaign_members;
ALTER TABLE outreach_campaign_members_new RENAME TO outreach_campaign_members;
CREATE INDEX IF NOT EXISTS idx_campaign_members_queue
  ON outreach_campaign_members(campaign_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_members_grain
  ON outreach_campaign_members(campaign_id, customer_id, contact_norm);
