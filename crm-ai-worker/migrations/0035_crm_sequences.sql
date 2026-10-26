-- 0035 多步销售序列（更新.txt 第 3 项 / 审查报告 P0-3）：
-- 把「群发自动推进」升级为时间驱动、行为终止的销售序列引擎。
--   crm_sequences            序列定义（名称 + 品牌）
--   crm_sequence_steps       步骤模板（day_offset 天后发送，占位符渲染）
--   crm_sequence_enrollments 入册（公司+联系人邮箱），active/paused/
--                            completed/stopped 状态机；回复、退订、退信、
--                            连续发送失败自动终止；UNIQUE(sequence, email)
--                            防重复入册。
CREATE TABLE IF NOT EXISTS crm_sequences (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_sequence_steps (
  id TEXT PRIMARY KEY,
  sequence_id TEXT NOT NULL REFERENCES crm_sequences(id) ON DELETE CASCADE,
  step_no INTEGER NOT NULL,
  day_offset INTEGER NOT NULL DEFAULT 0,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  UNIQUE(sequence_id, step_no)
);

CREATE TABLE IF NOT EXISTS crm_sequence_enrollments (
  id TEXT PRIMARY KEY,
  sequence_id TEXT NOT NULL REFERENCES crm_sequences(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
  contact_email TEXT NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 0,
  next_due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','stopped')),
  stop_reason TEXT,
  send_failures INTEGER NOT NULL DEFAULT 0,
  enrolled_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(sequence_id, contact_email)
);

CREATE INDEX IF NOT EXISTS idx_seq_enrollments_due
  ON crm_sequence_enrollments(status, next_due_at);
