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
  signature TEXT,
  enabled INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Brand sender identities and signatures are part of the base schema so a
-- fresh database can be initialized without follow-up migrations.

-- Outreach attachments (base64 in D1; small files like PDF catalogs)
CREATE TABLE IF NOT EXISTS outreach_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_name TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL,
  content_base64 TEXT NOT NULL,
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
