-- 触达质量闭环（审查建议 P0-2 + P1-6）：
-- crm_contacts   email_status（unknown/valid/invalid/risky）、email_verified_at、
--                unsubscribed_at（退订即永久抑制）、do_not_contact（禁止联系）
-- crm_companies  do_not_contact（公司级一键抑制：所有营销发送前拦截）
-- 配合 src/contactability.ts 的发送前统一策略检查与 Gmail 入站回复分类。
ALTER TABLE crm_contacts ADD COLUMN email_status TEXT DEFAULT 'unknown';
ALTER TABLE crm_contacts ADD COLUMN email_verified_at TEXT;
ALTER TABLE crm_contacts ADD COLUMN unsubscribed_at TEXT;
ALTER TABLE crm_contacts ADD COLUMN do_not_contact INTEGER DEFAULT 0;

ALTER TABLE crm_companies ADD COLUMN do_not_contact INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_contacts_email_status ON crm_contacts(email_status);
