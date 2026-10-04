-- Security V2 Stage 17 (spec §18) — database integrity.
--
-- Three fixes ship together:
--
-- 1. contacts table: read and written by the research pipeline (index.ts
--    save-contacts step, INSERT OR IGNORE) and the admin detail view
--    (getCustomerContacts) since the beginning, but never defined by this
--    repo — fresh databases failed with "no such table: contacts" while
--    production carried a manually created table of unknown shape. Now
--    defined in schema.sql + the CI step (belt-and-suspenders, research_runs
--    precedent).
--
-- 2. customers.display_id: existed only in production (the admin panel's
--    CUSTOMER_COLUMNS selects it), missing from schema.sql's CREATE —
--    fresh installs 500'd on any customer query. Added to the CREATE and
--    to the CI step via the duplicate-column-tolerant ALTER.
--
-- 3. §18.1 UNIQUE indexes (partial, per-item rationale):
--    - idx_customers_domain ON customers(domain) WHERE domain != ''
--      Import inserts '' when a CSV row has no usable domain, and the
--      app-level import dedup (normalized_domain/domain LIKE match) is
--      TOCTOU-racy across concurrent imports — the index is the race
--      backstop. The PATCH handler maps the violation to a 409.
--    - idx_api_configs_fingerprint ON api_configs(provider, key_fingerprint)
--      WHERE key_fingerprint IS NOT NULL
--      Per-provider, matching the documented bulk-import dedup semantics
--      ("duplicates within the paste AND keys already stored for the
--      provider are skipped"); the single-key POST now enforces the same
--      rule up front (409). NULL fingerprints (pre-Stage-4 rows) are
--      excluded — they cannot be compared.
--    - idx_contacts_contact_id / idx_contacts_seq
--      The research save uses INSERT OR IGNORE keyed on contact_id, and
--      seq is the per-company sequence contact_id derives from.
--
-- All four are created by the CI step with || true tolerance (Stage 10
-- idempotency-index precedent): a live table that already holds duplicates
-- skips creation with a visible WARNING instead of blocking the deploy —
-- the enforcement then stays app-level until the operator cleans the data,
-- and the CI step's verification query reports which indexes exist.
--
-- FK / NOT NULL / CHECK on pre-existing tables: SQLite cannot add these to
-- an existing table without a full table rebuild, and a rebuild against
-- unknown production data could fail a deploy mid-flight. §18's intent is
-- met where it is enforceable: outreach_emails.customer_id carries a real
-- FK (D1 enforces FKs by default), every §18.1 duplicate class now has a
-- DB-level unique index, and the orphan classes are prevented by
-- construction (deleteCampaign deletes members before the campaign row;
-- no code path deletes customers, so evidence/contacts/emails cannot be
-- orphaned). The per-table audit matrix is in
-- docs/stages/stage-17-database-integrity.md.

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  contact_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  first_name TEXT,
  last_name TEXT,
  full_name TEXT,
  title TEXT,
  department TEXT,
  email TEXT,
  cellphone TEXT,
  tel TEXT,
  whatsapp TEXT,
  linkedin_url TEXT,
  social_accounts TEXT
);

ALTER TABLE customers ADD COLUMN display_id TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_research_runs_customer ON research_runs(customer_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_domain
ON customers(domain) WHERE domain != '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_configs_fingerprint
ON api_configs(provider, key_fingerprint) WHERE key_fingerprint IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_contact_id ON contacts(contact_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_seq ON contacts(company_id, seq);
