-- 0043 CRM 自动资料补全队列（crm_enrich_queue）。
--
-- 加入待办（导入面板「全部加入待办」/ 单家「加入待办」）时，公司同时排入
-- 本队列；cron 空闲 tick 逐家补全：抓官网首页 + DuckDuckGo 搜公司名 →
-- Workers AI 提取结构化字段（行业/产品/国家/城市/地区/规模/简介）→
-- 只回填 crm_companies 里的空缺字段（已有值不动），并记时间线备注。
-- 与 customers 研究管线的关系：lead-discovery 明确禁止已进 CRM 的公司
-- 回研究管线（方向是 customers → 研究 → promote → crm_companies），因此
-- CRM 侧补全是独立队列，复用同样的搜索/抓取原语，不写 customers。
--
-- status: pending（待处理）| done（已补全/已尝试且无可补全）| failed（重试
-- 次数用尽仍失败）。重新入队幂等：pending/done/failed 再入队为 no-op。

CREATE TABLE IF NOT EXISTS crm_enrich_queue (
  company_id TEXT PRIMARY KEY REFERENCES crm_companies(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  enqueued_at TEXT NOT NULL,
  finished_at TEXT,
  filled_fields TEXT,
  note TEXT,
  run_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_crm_enrich_queue_status
  ON crm_enrich_queue(status, enqueued_at);
