-- 0037 多角色联系人图谱 + 持续采购意向监测（更新.txt 第 6/7 项，开发顺序阶段四）。
-- ⑦ 多角色采购联系人图谱：
--   crm_contacts.procurement_role   采购角色（owner/procurement/finance/
--                                  channel/operations/sales/other/unknown，
--                                  新建/改职位时按职位关键词自动推断）
--   crm_contacts.role_evidence      角色依据（命中关键词/来源说明）
--   crm_contacts.role_updated_at    角色更新时间
--   crm_deal_contacts               同一公司多位联系人 ↔ 商机关联（图谱边）
-- ⑥ 持续采购意向监测：
--   crm_signal_watch    监测配置（重要客户自动入表；可停用/改周期）
--   crm_signal_checks   检测到的信号（类型/内容/来源/发生时间/失效时间，
--                       来源去重；新信号 → 时间线 + 待办 + 优先级上调）

ALTER TABLE crm_contacts ADD COLUMN procurement_role TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE crm_contacts ADD COLUMN role_evidence TEXT;
ALTER TABLE crm_contacts ADD COLUMN role_updated_at TEXT;
CREATE INDEX IF NOT EXISTS idx_contacts_procurement_role ON crm_contacts(procurement_role);

CREATE TABLE IF NOT EXISTS crm_deal_contacts (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  role_in_deal TEXT,
  added_at TEXT NOT NULL,
  UNIQUE(deal_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_deal_contacts_deal ON crm_deal_contacts(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_contacts_contact ON crm_deal_contacts(contact_id);

CREATE TABLE IF NOT EXISTS crm_signal_watch (
  company_id TEXT PRIMARY KEY REFERENCES crm_companies(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_days INTEGER NOT NULL DEFAULT 14,
  last_checked_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_signal_watch_due
  ON crm_signal_watch(enabled, last_checked_at);

CREATE TABLE IF NOT EXISTS crm_signal_checks (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL,
  signal_text TEXT NOT NULL,
  source_url TEXT,
  detected_at TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(company_id, signal_type, source_url)
);

CREATE INDEX IF NOT EXISTS idx_signal_checks_company ON crm_signal_checks(company_id, detected_at);
