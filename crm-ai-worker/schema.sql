CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  company_id TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  company_name TEXT,
  legal_name TEXT,
  trading_name TEXT,
  normalized_domain TEXT,
  first_name TEXT,
  last_name TEXT,
  full_name TEXT,
  title TEXT,
  department TEXT,
  linkedin_url TEXT,
  street_address TEXT,
  zip_city TEXT,
  country TEXT,
  country_code TEXT,
  region TEXT,
  city TEXT,
  postal_code TEXT,
  tel TEXT,
  email TEXT,
  cellphone TEXT,
  whatsapp TEXT,
  products_services TEXT,
  business_tag TEXT,
  industry TEXT,
  company_type TEXT,
  business_model TEXT,
  founded_year INTEGER,
  employee_range TEXT,
  description TEXT,
  target_markets TEXT,
  is_manufacturer INTEGER DEFAULT 0,
  is_importer INTEGER DEFAULT 0,
  is_distributor INTEGER DEFAULT 0,
  is_wholesaler INTEGER DEFAULT 0,
  is_retailer INTEGER DEFAULT 0,
  is_ecommerce INTEGER DEFAULT 0,
  is_rental INTEGER DEFAULT 0,
  is_oem INTEGER DEFAULT 0,
  social_accounts TEXT,
  full_research_text TEXT,
  social_accounts_verified TEXT,
  customer_segment TEXT,
  product_categories TEXT,
  company_size TEXT,
  geographic_coverage TEXT,
  personas_and_solutions TEXT CHECK (personas_and_solutions IS NULL OR json_valid(personas_and_solutions)),
  remarks TEXT,
  -- Structured company profile distilled by AI from full_research_text:
  -- background, main products, target customers, selling points. Kept separate
  -- from the raw research text so cold-email generation reads a short,
  -- high-signal JSON instead of re-parsing raw page dumps.
  company_profile TEXT CHECK (company_profile IS NULL OR json_valid(company_profile)),
  -- AI-recommended outreach angle + evidence lines, also JSON. Consumed by the
  -- outreach prompt builder for second-pass personalization.
  outreach_context TEXT CHECK (outreach_context IS NULL OR json_valid(outreach_context)),
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Idempotent migration for rows created before the profile columns existed.
-- (D1 fails the whole file on a duplicate-column error, so these are applied
-- by the CI migration step below instead of unconditional ALTERs.)

CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_company_id ON customers(company_id);

-- Outreach email settings
CREATE TABLE IF NOT EXISTS outreach_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_name TEXT NOT NULL UNIQUE,
  product_category TEXT NOT NULL,
  company_intro TEXT,
  sender_email TEXT,
  sender_name TEXT,
  -- Legal entity name used as the sending identity in the email body
  -- (e.g. "SUP DIVISION OF QINGDAO VATRAD GROUP CO., LTD"); NULL = use brand_name.
  company_entity TEXT,
  signature TEXT,
  -- Optional gmail_accounts.client_email binding; NULL = auto-pick from pool.
  -- For oauth_refresh accounts this is also the From mailbox.
  gmail_account TEXT,
  enabled INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Brand sender identities and signatures are part of the base schema so a
-- fresh database can be initialized without follow-up migrations.

-- Outreach attachments (base64 in D1; small files like PDF catalogs).
-- language: ISO 639-1 code (es/de/fr/...) of the catalog version, or "all"
-- for universal attachments sent to every recipient regardless of language.
CREATE TABLE IF NOT EXISTS outreach_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_name TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL,
  content_base64 TEXT NOT NULL,
  language TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Generated outreach emails
CREATE TABLE IF NOT EXISTS outreach_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER,
  company_id TEXT,
  display_id TEXT,
  company_name TEXT,
  email_to TEXT,
  product_category TEXT,
  brand_name TEXT,
  subject TEXT,
  body TEXT,
  status TEXT DEFAULT 'draft',
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE INDEX IF NOT EXISTS idx_outreach_customer_id ON outreach_emails(customer_id);
CREATE INDEX IF NOT EXISTS idx_outreach_status ON outreach_emails(status);
CREATE INDEX IF NOT EXISTS idx_outreach_product ON outreach_emails(product_category);

-- API key health tracking (anti-ban: a key that returns 429/quota-exhausted is
-- disabled until its cooldown expires, so we never hammer an exhausted key)
CREATE TABLE IF NOT EXISTS api_key_health (
  provider TEXT NOT NULL,
  key_index INTEGER NOT NULL,
  exhausted_until TIMESTAMP,
  last_error TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (provider, key_index)
);

-- Per-key success counters (panel 📊 本月用量 card). key_index holds the
-- health name "<provider>:<keyId>"; day is a UTC date. Idempotent table so
-- CI can re-run schema.sql on every deploy.
CREATE TABLE IF NOT EXISTS api_key_usage (
  provider TEXT NOT NULL,
  key_index TEXT NOT NULL,
  day TEXT NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, key_index, day)
);

-- Dynamic provider configuration (方案B): keys/models/RPM managed from the
-- admin panel at runtime — no redeploy needed. D1 is the source of truth;
-- env secrets remain a fallback/bootstrap source (see src/provider-keys.ts).
CREATE TABLE IF NOT EXISTS api_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,             -- gemini | groq | cerebras | zhipu | nvidia | mistral | deepseek | openrouter | tavily | exa | brave | searlo
  label TEXT,
  api_key TEXT NOT NULL,
  rpm_limit INTEGER,                  -- NULL = use default per-key RPM
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  model TEXT,                         -- optional per-key model override
  last_error TEXT,
  last_used_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_api_configs_provider ON api_configs(provider, is_active);

-- Provider-level settings (default model, total RPM override, enabled flag)
CREATE TABLE IF NOT EXISTS provider_settings (
  provider TEXT PRIMARY KEY,
  default_model TEXT,
  rpm_total INTEGER,                  -- NULL = derive from per-key RPM x key count
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Gmail sender account pool: multiple Google identities that can send via the
-- Gmail API. Two credential kinds:
--   credential_type = 'service_account' — service-account PEM + domain-wide
--       delegation (client_email = …@….iam.gserviceaccount.com, private_key = PEM);
--   credential_type = 'oauth_refresh' — per-mailbox OAuth2 refresh token
--       (client_email = the From mailbox, private_key = the refresh token),
--       the no-key alternative for orgs whose policy blocks service-account keys.
-- Emails pick one account (per-brand binding first, then least-used healthy
-- account) so the daily send quota scales linearly with the account count.
CREATE TABLE IF NOT EXISTS gmail_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT,
  credential_type TEXT NOT NULL DEFAULT 'service_account' CHECK (credential_type IN ('service_account', 'oauth_refresh')),
  client_email TEXT NOT NULL UNIQUE,  -- service account email, or the From mailbox for oauth_refresh
  private_key TEXT NOT NULL,          -- PEM (service_account) or refresh token (oauth_refresh)
  delegated_domain TEXT,              -- workspace domain for quick reference
  daily_limit INTEGER,                -- NULL = global GMAIL_DAILY_LIMIT (default 400)
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_error TEXT,
  cooldown_until TIMESTAMP,           -- set when Google rejects the account
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Gmail send log (daily quota tracking + delivery audit for outreach emails)
CREATE TABLE IF NOT EXISTS gmail_send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outreach_email_id INTEGER,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
  detail TEXT,
  sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gmail_send_log_date ON gmail_send_log(date(sent_at));
CREATE INDEX IF NOT EXISTS idx_gmail_send_log_email ON gmail_send_log(outreach_email_id);

-- Field-level evidence trail (docx 建议七): every AI-judged fact keeps its
-- source URL, quoted evidence text and confidence, so a wrong judgement can be
-- traced and re-processed instead of silently overwriting the record.
CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL,
  contact_id TEXT,
  field_name TEXT NOT NULL,
  field_value TEXT,
  source_url TEXT,
  source_type TEXT,
  evidence_text TEXT,
  confidence REAL,
  collected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_evidence_company ON evidence(company_id, field_name);

-- Raw import layer (docx 建议三): original uploaded rows are immutable; the
-- normalized/enriched customer rows reference back to them. Re-importing the
-- same file never destroys original data.
CREATE TABLE IF NOT EXISTS customer_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id TEXT NOT NULL,
  file_name TEXT,
  row_number INTEGER,
  raw_json TEXT NOT NULL CHECK (raw_json IS NULL OR json_valid(raw_json)),
  mapped_company_id TEXT,
  dedup_status TEXT NOT NULL DEFAULT 'pending' CHECK (dedup_status IN ('pending','matched','inserted','skipped')),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customer_imports_batch ON customer_imports(import_id);

-- Lead scoring (docx 建议/九): SQL-first targeting so only high-value customers
-- consume crawl + AI budget. Recomputed after each successful analysis.
-- Columns lead_score / buying_signals / source_import_id are added by the CI
-- migration step (per-statement ALTER with duplicate-column tolerance), since
-- D1 fails a whole schema file on any duplicate ALTER.

-- Saved customer groups (定向群发/客群): a reusable 海选 filter set so a
-- segment ("西班牙经销商") can be re-targeted later without retyping criteria.
-- The same filter JSON drives both the preview and campaign creation, so what
-- the operator counted is exactly what gets emailed.
CREATE TABLE IF NOT EXISTS outreach_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  filters TEXT NOT NULL CHECK (filters IS NULL OR json_valid(filters)),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A campaign is a resumable send task over a SNAPSHOT of customer ids taken at
-- creation time. Snapshotting (rather than re-running the filter on every step)
-- keeps membership stable while the pipeline keeps researching customers, and
-- makes the progress counters exact.
CREATE TABLE IF NOT EXISTS outreach_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand_name TEXT NOT NULL,
  group_id INTEGER,                    -- NULL = one-off campaign, not saved
  filters TEXT CHECK (filters IS NULL OR json_valid(filters)),
  total INTEGER NOT NULL DEFAULT 0,
  -- draft | paused | done
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'paused', 'done')),
  last_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaigns_brand ON outreach_campaigns(brand_name, status);

-- Per-customer progress. status is the resume cursor: 'pending' needs a draft,
-- 'generated' holds a draft id waiting to be sent, 'sent'/'failed' are
-- terminal. outreach_email_id lets the send step go straight to the draft
-- without re-deriving which email belongs to this campaign.
CREATE TABLE IF NOT EXISTS outreach_campaign_members (
  campaign_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  -- pending | generated | sent | skipped | failed
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'generated', 'sent', 'skipped', 'failed')),
  outreach_email_id INTEGER,
  error TEXT,
  PRIMARY KEY (campaign_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_campaign_members_queue ON outreach_campaign_members(campaign_id, status);

-- Login brute-force throttling for /admin/login.
--
-- 'ip' throttles a single caller; 'global' is the floor that a distributed
-- spray still hits, since a per-IP-only limit is defeated by rotating source
-- addresses. The repo is public and the endpoint is trivially discoverable,
-- so the token is the only thing between a stranger and every API key in D1.
--
-- Rows are keyed by (scope, ident) and pruned during a check rather than by a
-- cron, so the table stays small without another scheduled job. 'ident' is
-- validated to be an IP literal before it is ever written — an unvalidated
-- header would let a caller mint unbounded rows.
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  scope TEXT NOT NULL CHECK (scope IN ('ip', 'global')),
  ident TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (scope, ident)
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_updated ON admin_login_attempts(updated_at);
