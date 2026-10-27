-- 0042 电话三列拆分 + 公司信息对齐 /admin 客户字段（齐全）。
-- 背景（用户需求）：
--   1) 合并联系人时电话/WhatsApp 只保一个号 → crm_contacts 拆成
--      tel / cellphone / whatsapp 三列独立保存（同 /admin 联系人格式），
--      合并时三列各自 COALESCE 保全，不再互抢。
--   2) crm 公司信息必须参考 /admin 下公司信息格式且必须齐全 →
--      crm_companies 补齐 /admin customers 的全部手工字段（~24 列），
--      含公司级 tel / whatsapp。
-- 兼容：旧列 whatsapp_or_phone 回填进 whatsapp 后保留为遗留列（停写）；
-- 新列全部可空，回滚安全（还原代码即可，列留在库里无副作用）。

-- ── crm_contacts：电话三列（同 /admin 联系人 tel/cellphone/whatsapp）──
ALTER TABLE crm_contacts ADD COLUMN tel TEXT;
ALTER TABLE crm_contacts ADD COLUMN cellphone TEXT;
ALTER TABLE crm_contacts ADD COLUMN whatsapp TEXT;
-- 旧单列回填进 whatsapp（业务以 WhatsApp 为主要联系方式）；
-- whatsapp_or_phone 保留为遗留列、此后停写（老代码仍可读）。
UPDATE crm_contacts SET whatsapp = whatsapp_or_phone
 WHERE (whatsapp IS NULL OR whatsapp = '') AND whatsapp_or_phone IS NOT NULL;

-- ── crm_companies：对齐 /admin 客户信息的手工字段 ──
ALTER TABLE crm_companies ADD COLUMN legal_name TEXT;         -- 法定名称
ALTER TABLE crm_companies ADD COLUMN trading_name TEXT;       -- 交易名称
ALTER TABLE crm_companies ADD COLUMN zip_city TEXT;           -- 邮编城市
ALTER TABLE crm_companies ADD COLUMN city TEXT;               -- 城市
ALTER TABLE crm_companies ADD COLUMN region TEXT;             -- 地区
ALTER TABLE crm_companies ADD COLUMN postal_code TEXT;        -- 邮编
ALTER TABLE crm_companies ADD COLUMN country_code TEXT;       -- 国家代码
ALTER TABLE crm_companies ADD COLUMN tel TEXT;                -- 公司电话
ALTER TABLE crm_companies ADD COLUMN whatsapp TEXT;           -- 公司 WhatsApp
ALTER TABLE crm_companies ADD COLUMN products_services TEXT;  -- 产品与服务
ALTER TABLE crm_companies ADD COLUMN business_tag TEXT;       -- 业务标签
ALTER TABLE crm_companies ADD COLUMN company_type TEXT;       -- 公司类型
ALTER TABLE crm_companies ADD COLUMN business_model TEXT;     -- 商业模式
ALTER TABLE crm_companies ADD COLUMN founded_year TEXT;       -- 成立年份（TEXT 容纳 "1990s"）
ALTER TABLE crm_companies ADD COLUMN employee_range TEXT;     -- 员工规模
ALTER TABLE crm_companies ADD COLUMN description TEXT;        -- 公司描述
ALTER TABLE crm_companies ADD COLUMN target_markets TEXT;     -- 目标市场
ALTER TABLE crm_companies ADD COLUMN customer_segment TEXT;   -- 客户细分
ALTER TABLE crm_companies ADD COLUMN product_categories TEXT; -- 产品类别
ALTER TABLE crm_companies ADD COLUMN company_size TEXT;       -- 公司规模
ALTER TABLE crm_companies ADD COLUMN geographic_coverage TEXT; -- 地理覆盖
ALTER TABLE crm_companies ADD COLUMN is_manufacturer INTEGER DEFAULT 0;
ALTER TABLE crm_companies ADD COLUMN is_importer INTEGER DEFAULT 0;
ALTER TABLE crm_companies ADD COLUMN is_distributor INTEGER DEFAULT 0;
ALTER TABLE crm_companies ADD COLUMN is_wholesaler INTEGER DEFAULT 0;
ALTER TABLE crm_companies ADD COLUMN is_retailer INTEGER DEFAULT 0;
ALTER TABLE crm_companies ADD COLUMN is_ecommerce INTEGER DEFAULT 0;
ALTER TABLE crm_companies ADD COLUMN is_rental INTEGER DEFAULT 0;
ALTER TABLE crm_companies ADD COLUMN is_oem INTEGER DEFAULT 0;
