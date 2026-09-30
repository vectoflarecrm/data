-- SUP 开发信改以 Vatrad 集团 SUP 事业部名义发送
-- 适用：已存在的线上 D1 数据库（全新数据库直接执行 schema.sql 即可，无需本文件）
-- 执行：npx wrangler d1 execute crm-ai-db --remote --file=./migrations/0001_add_company_entity_and_vatrad_sender.sql
-- 说明：company_entity 列已在线上生效（运行时兜底 ALTER 已自动添加），本文件只包含
--       数据 UPDATE，全部带 WHERE 条件、可重复执行。

-- 1) Afarer（SUPs）品牌改用 Vatrad SUP 事业部名义发信
--    （2026-09-30 确认：发件邮箱与签名块统一为 helen@isupfactory.com）
UPDATE outreach_settings
SET sender_email   = 'helen@isupfactory.com',
    sender_name    = 'Helen | Vatrad SUP Division',
    company_entity = 'SUP DIVISION OF QINGDAO VATRAD GROUP CO., LTD',
    updated_at     = CURRENT_TIMESTAMP
WHERE brand_name = 'Afarer';

-- 2) Afarer 的公司简介改为 Vatrad SUP 事业部简介（基于 afarer.com/en/factory 公开事实；
--    仅当仍是占位符时更新，已有正式简介则跳过）
UPDATE outreach_settings
SET company_intro = 'SUP DIVISION OF QINGDAO VATRAD GROUP CO., LTD（青岛Vatrad集团SUP事业部）位于青岛经济开发区，是集团旗下专注充气式站立桨板（iSUP）的自有工厂事业部。工厂面积12,000平方米，拥有200余名熟练工人，年产桨板15,000片以上，客户覆盖50多个国家的品牌商、进口商与经销商。事业部集设计、工程、打样、制造与测试于一体，自有多条产线：CNC drop-stitch裁切、RF/热合焊接、数码与丝网印刷、FRP模具车间及独立质检实验室（ISO 9001认证，产品通过CE、BSCI、REACH），每片桨板出厂前100%进行保压与接缝剥离测试。标准起订量每型号5-10片，交期30-45天，支持OEM/ODM贴牌定制，可按FOB青岛/CIF/DDP条款发货。',
    updated_at = CURRENT_TIMESTAMP
WHERE brand_name = 'Afarer' AND company_intro LIKE '[%';
