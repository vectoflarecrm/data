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
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_company_id ON customers(company_id);

-- Outreach email settings
CREATE TABLE IF NOT EXISTS outreach_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_name TEXT NOT NULL UNIQUE,
  product_category TEXT NOT NULL,
  company_intro TEXT,
  enabled INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
