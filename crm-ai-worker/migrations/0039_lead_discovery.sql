-- 0039 自动寻找新客户（更新.txt 第 1 项，开发顺序阶段六）。
-- ① 线索自动发现：
--   lead_discovery_rules  发现规则（目标行业/国家/产品关键词/每次上限/运行
--                          间隔/开关）。基于现有搜索舰队（Tavily/Exa/Searlo/
--                          DuckDuckGo）自动生成查询，零新增付费 API。
--   lead_discovery_log    每次运行的候选记录（查询词/公司名/域名/来源 URL/
--                          结果 inserted|duplicate|skipped），可追溯可去重。
--   customers.discovery_rule_id  线索来源规则（NULL = CSV 导入/手工录入）。
--                          发现的公司去重后写入 customers（status='pending'），
--                          研究管线照常 enrich，线索提升后进入 CRM。
-- 运行方式：cron 空闲 tick 自动运行到期规则（每 tick 一条，fail-open），
--           或面板「立即运行」按钮同步触发。

CREATE TABLE IF NOT EXISTS lead_discovery_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  keywords TEXT NOT NULL,
  industry TEXT,
  country TEXT,
  max_results INTEGER NOT NULL DEFAULT 20,
  interval_hours INTEGER NOT NULL DEFAULT 168,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_discovery_rules_due ON lead_discovery_rules(enabled, last_run_at);

CREATE TABLE IF NOT EXISTS lead_discovery_log (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  run_at TEXT NOT NULL DEFAULT (datetime('now')),
  query TEXT NOT NULL,
  company_name TEXT NOT NULL,
  domain TEXT,
  source_url TEXT,
  snippet TEXT,
  outcome TEXT NOT NULL DEFAULT 'inserted' CHECK (outcome IN ('inserted', 'duplicate', 'skipped')),
  customer_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_discovery_log_rule ON lead_discovery_log(rule_id, run_at);
CREATE INDEX IF NOT EXISTS idx_discovery_log_customer ON lead_discovery_log(customer_id);

ALTER TABLE customers ADD COLUMN discovery_rule_id TEXT;

CREATE INDEX IF NOT EXISTS idx_customers_discovery_rule ON customers(discovery_rule_id);
