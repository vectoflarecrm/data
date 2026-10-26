-- 0032: CRM sales layer extension (gap analysis vs Atomic CRM / OpenCRM).
--
--   ① won deals flip the company into a paying customer (customer_since),
--     losses record a structured reason (lost_reason); won_at powers the
--     monthly won chart (panel 成交走势);
--   ② kanban order (position REAL — fractional so a drop between two cards
--     can always find a gap) + deal archive (archived_at).
--
-- schema.sql carries the same columns inline for fresh installs; this file
-- is for databases that already ran 0031.

ALTER TABLE crm_companies ADD COLUMN customer_since TEXT;

ALTER TABLE crm_deals ADD COLUMN lost_reason TEXT;
ALTER TABLE crm_deals ADD COLUMN won_at TEXT;
ALTER TABLE crm_deals ADD COLUMN position REAL;
ALTER TABLE crm_deals ADD COLUMN archived_at TEXT;

-- Backfill ①: pre-existing won deals already made these companies customers,
-- and the monthly chart should not start empty. won_at falls back to the row's
-- last update day; customer_since takes the earliest won deal per company.
UPDATE crm_deals
   SET won_at = substr(updated_at, 1, 10)
 WHERE stage = 'won' AND won_at IS NULL;

UPDATE crm_companies
   SET customer_since = (
     SELECT MIN(won_at) FROM crm_deals d
     WHERE d.company_id = crm_companies.id AND d.stage = 'won' AND d.won_at IS NOT NULL
   )
 WHERE customer_since IS NULL
   AND EXISTS (SELECT 1 FROM crm_deals d
               WHERE d.company_id = crm_companies.id AND d.stage = 'won');

-- Backfill ②: stable per-stage order (oldest first, id as the tiebreaker so
-- rows created in the same second still get distinct positions).
UPDATE crm_deals
   SET position = (
     SELECT COUNT(*) FROM crm_deals d2
     WHERE d2.stage = crm_deals.stage
       AND (d2.created_at < crm_deals.created_at
            OR (d2.created_at = crm_deals.created_at AND d2.id < crm_deals.id))
   ) + 1
 WHERE position IS NULL;
