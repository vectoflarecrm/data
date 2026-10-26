-- 0036 邮箱/域名检测（CRM/email/emailcheck.txt + 筛查.txt + throwaway DoH 思路）：
-- 新增/修改的公司域名与联系人邮箱自动触发检测（状态回 'pending'，cron
-- 空闲 tick 用 Cloudflare DoH 查 A/MX/TXT(SPF)，识别邮局服务商、免费邮箱、
-- 一次性邮箱，结论 valid/free_email/no_mx/dead_domain/disposable）。
--   domain_dns_checks                     按域名去重的检测缓存（DoH 结果共享）
--   crm_companies.domain_email_status     公司域名检测结论（含历史数据回补）
--   crm_contacts.email_check_status       联系人邮箱域名检测结论
CREATE TABLE IF NOT EXISTS domain_dns_checks (
  domain TEXT PRIMARY KEY,
  has_a_record INTEGER NOT NULL DEFAULT 0,
  has_mx_record INTEGER NOT NULL DEFAULT 0,
  has_spf_record INTEGER NOT NULL DEFAULT 0,
  mx_provider TEXT,
  mx_records_json TEXT,
  is_free INTEGER NOT NULL DEFAULT 0,
  is_disposable INTEGER NOT NULL DEFAULT 0,
  email_verdict TEXT NOT NULL DEFAULT 'pending',
  feedback_notes TEXT,
  last_checked_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_domain_dns_verdict ON domain_dns_checks(email_verdict);

-- 现有公司/联系人一律回补为 'pending'：首个 tick 即完成存量邮箱体检。
ALTER TABLE crm_companies ADD COLUMN domain_email_status TEXT NOT NULL DEFAULT 'pending';
CREATE INDEX IF NOT EXISTS idx_companies_domain_email ON crm_companies(domain_email_status);

ALTER TABLE crm_contacts ADD COLUMN email_check_status TEXT NOT NULL DEFAULT 'pending';
CREATE INDEX IF NOT EXISTS idx_contacts_email_check ON crm_contacts(email_check_status);
