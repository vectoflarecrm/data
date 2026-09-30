-- 2026-09: Helen 新签名 + 附件语言标记（es 西语画册）
-- 适用：已存在的线上 D1 数据库（全新数据库直接执行 schema.sql 即可，无需本文件）
-- 执行：npx wrangler d1 execute crm-ai-db --remote --file=./migrations/0002_helen_signature_and_attachment_language.sql
-- 注意：worker 代码里有运行时兜底（ensureAttachmentLanguageColumn），本文件与其幂等；
--       language 列已存在时第 1 条会报错，可跳过。

-- 1) 附件表新增「语言」列（es/de/fr/… 或 all=通用；NULL 视为通用）
ALTER TABLE outreach_attachments ADD COLUMN language TEXT;

-- 2) Afarer（SUP 客户）签名更新为 Helen 新版签名（与 boot/sign.txt 一致）
UPDATE outreach_settings
SET signature = 'Helen Li
Director
helen@isupfactory.com
Whatsapp: 86 13305324192
iSupfactory/Qingdao Vatrad Group Co., Ltd
No.40 Yantai Road, Laixi, Qingdao, CHINA 266600',
    updated_at = CURRENT_TIMESTAMP
WHERE brand_name = 'Afarer';

-- 3) 西班牙语画册请通过面板 /admin/outreach 上传（选择「西班牙语」语言标签），
--    或使用 scripts/upload-attachment.mjs 上传。画册为 1.2MB 二进制 PDF，
--    不便直接写在 SQL 里，故此处不包含 INSERT 语句。
