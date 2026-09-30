-- 定向群发：可复用客群 + 可续跑群发任务
-- 适用：已存在的线上 D1 数据库（全新数据库直接执行 schema.sql 即可，无需本文件）
-- 执行：npx wrangler d1 execute crm-ai-db --remote --file=./migrations/0004_outreach_campaigns.sql
-- 说明：本文件与 schema.sql 中的定义一致，且全部使用 IF NOT EXISTS，
--       可重复执行。CI 每次部署都会跑 schema.sql，因此线上会自动获得这三张表。

CREATE TABLE IF NOT EXISTS outreach_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  filters TEXT NOT NULL CHECK (filters IS NULL OR json_valid(filters)),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS outreach_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand_name TEXT NOT NULL,
  group_id INTEGER,
  filters TEXT CHECK (filters IS NULL OR json_valid(filters)),
  total INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'paused', 'done')),
  last_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaigns_brand ON outreach_campaigns(brand_name, status);

CREATE TABLE IF NOT EXISTS outreach_campaign_members (
  campaign_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'generated', 'sent', 'skipped', 'failed')),
  outreach_email_id INTEGER,
  error TEXT,
  PRIMARY KEY (campaign_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_members_queue ON outreach_campaign_members(campaign_id, status);
