-- Migration 0031: CRM sales layer (CRM/合并.txt — open-crm D1 model as base).
--
-- Four new tables: crm_companies / crm_contacts / crm_deals / crm_activities.
-- Purely additive (CREATE IF NOT EXISTS + new indexes) — no existing table is
-- touched, so the statement is idempotent and safe to re-run.
--
-- The deploy workflow applies schema.sql (which carries the same CREATEs)
-- atomically on every deploy; this file exists for manual runs and for the
-- conventional record (see migration 0004).

CREATE TABLE IF NOT EXISTS crm_companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT UNIQUE,
  industry TEXT,
  country TEXT,
  tier TEXT DEFAULT 'unqualified',
  lead_status TEXT DEFAULT 'new',
  merged_from_ids TEXT,
  chinese_remarks TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_companies_domain ON crm_companies(domain);
CREATE INDEX IF NOT EXISTS idx_companies_lead_status ON crm_companies(lead_status);

CREATE TABLE IF NOT EXISTS crm_contacts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  job_title TEXT,
  email TEXT,
  whatsapp_or_phone TEXT,
  linkedin_url TEXT,
  is_primary INTEGER DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contacts_company_id ON crm_contacts(company_id);

CREATE TABLE IF NOT EXISTS crm_deals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  stage TEXT DEFAULT 'inquiry',
  amount REAL,
  incoterms TEXT,
  expected_close_date TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_deals_company_id ON crm_deals(company_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON crm_deals(stage);

CREATE TABLE IF NOT EXISTS crm_activities (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
  deal_id TEXT,
  type TEXT DEFAULT 'manual_note',
  summary TEXT NOT NULL,
  due_date TEXT,
  is_completed INTEGER DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activities_company_id ON crm_activities(company_id);
CREATE INDEX IF NOT EXISTS idx_activities_open_tasks ON crm_activities(is_completed, due_date);
