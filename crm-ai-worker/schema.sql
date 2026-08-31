CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  company_id TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  customer_segment TEXT,
  personas_and_solutions TEXT CHECK (personas_and_solutions IS NULL OR json_valid(personas_and_solutions)),
  remarks TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_company_id ON customers(company_id);
