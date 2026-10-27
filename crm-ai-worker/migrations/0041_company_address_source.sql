-- 0041 公司扩展属性：地址 / 外部编号 / 经销代理品牌。
-- 背景：Puerto Rico.xlsx 手工导入反馈「company ID / Street address / from」
-- 三列未识别被忽略 —— CRM 缺少对应字段。本迁移为 crm_companies 补三列：
--   address       — 街道地址（Street address / 地址）
--   external_id   — 外部系统编号（company ID / 公司编号）
--   dealer_brands — 经销/代理品牌（from 列：该公司是这些品牌的
--                   dealer/distributor，值常为逗号分隔品牌列表）
-- 重复导入只回填空值（导入逻辑用 NULLIF+COALESCE 条件更新），不覆盖人工修改。

ALTER TABLE crm_companies ADD COLUMN address TEXT;
ALTER TABLE crm_companies ADD COLUMN external_id TEXT;
ALTER TABLE crm_companies ADD COLUMN dealer_brands TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_external_id ON crm_companies(external_id);
