-- 0038 客户开发 ROI 与来源归因 + 任务日历（更新.txt 第 5/8 项，开发顺序阶段五）。
-- ⑤ 来源归因：
--   crm_companies.source   获客来源（promoted 管线提升 / manual 手工录入 /
--                          csv_import CSV 导入 / merge 合并 / referral 转介绍 /
--                          other 其他 / unknown 未知），PATCH companies 可修正。
--   归因统计按 来源/国家/行业/联系人角色/序列 五个维度聚合
--   （GET /admin/api/crm/attribution）。
-- ⑧ 任务日历：
--   crm_activities.owner   任务负责人（用户名，NULL = 未分配），
--                          日历视图 GET /admin/api/crm/calendar，
--                          日历同步 GET /admin/api/crm/calendar.ics（RFC 5545）。

ALTER TABLE crm_companies ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS idx_companies_source ON crm_companies(source);

-- 回填：id 形如 'c_<customers.id>' 的公司来自管线提升。
-- LIKE 里的 '_' 是单字符通配符（'c3b1…' 也会命中 'c_%'），必须转义。
UPDATE crm_companies SET source = 'promoted'
 WHERE source = 'unknown' AND id LIKE 'c\_%' ESCAPE '\';

ALTER TABLE crm_activities ADD COLUMN owner TEXT;
