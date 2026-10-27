-- 0040 发现成本与合格率报表（Prospecting Engine 模块 A 验收指标）。
-- 每次发现运行写入一条 lead_discovery_runs：查询数、候选数、入库/重复数、
-- 搜索积分成本（Tavily advanced=2/次，Exa/Searlo=1/次，DDG=0）、触发来源
-- （manual 面板手动 / cron 空闲 tick）。配合 customers.discovery_rule_id 可
-- 计算：重复率、合格率（研究完成且 lead_score≥60）、已提升/商机数、单个
-- 合格线索成本（GET /admin/api/discovery/stats）。

CREATE TABLE IF NOT EXISTS lead_discovery_runs (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  run_at TEXT NOT NULL DEFAULT (datetime('now')),
  trigger_source TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_source IN ('manual', 'cron')),
  queries INTEGER NOT NULL DEFAULT 0,
  candidates INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  search_credits REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_discovery_runs_rule ON lead_discovery_runs(rule_id, run_at);
