-- Phase 3 Stage 37 — typed fact substrate (research_facts).
--
-- 建议 §二十一 pipeline: Raw Evidence → Fact Extraction → Entity
-- Resolution → Company Profile → Buyer Persona → Buying Signal → Lead
-- Score → Outreach Strategy → Email. research_sources (Stage 36) is the
-- raw layer; this table is the Fact Extraction layer: every rule-mined
-- contact observation (email / phone / whatsapp link / social link) from
-- a research run becomes ONE typed row, so Phase 4 consumers resolve
-- entities and build personas from structured rows instead of re-grepping
-- raw prose with regexes.
--
-- Grain: one row per distinct (customer_id, run, fact_type, fact_value).
-- Repeats across the run's crawl segments aggregate into occurrence_count;
-- the first segment containing the value is its source_type (same
-- vocabulary as research_sources: 'website' / 'social' / 'search' /
-- 'additional' / 'backfill').
--
-- Write path (appendResearchFacts in src/research-run.ts) is APPEND +
-- supersede, identical to evidence v2 (0012) and research_sources (0020):
--
--   UPDATE research_facts SET is_current = 0, valid_until = <now>
--     WHERE customer_id = ? AND is_current = 1;
--   INSERT INTO research_facts (..., is_current = 1, valid_from = <now>);
--
-- — both inside one D1 batch. Writer-side bounds: at most 100 rows per
-- run, fact_value capped at 500 chars.
--
-- Column semantics:
--   research_run_id  soft reference into research_runs (null when the run
--                    row could not be created — fail-open, like evidence)
--   customer_id      customers.company_id TEXT, same key style as evidence
--   fact_type        'email' | 'phone' | 'whatsapp' | 'social'
--   fact_value       the observed string (emails lowercased by the miner;
--                    phones/urls kept as matched — normalization is Phase
--                    4 entity resolution's job, not the miner's)
--   source_type      crawl segment the value was first found in
--   occurrence_count how many segments of the run contained the value
--   confidence       defaults to 1 — a rule-mined row is a deterministic
--                    observation ("the saved text contains this string")
--   parser_version   'facts-v1' (FACTS_PARSER_VERSION)
--   fetched_at       when this pass observed the fact
--   is_current       1 = current fact set, 0 = superseded history
--   valid_from / valid_until   validity window of this set
--
-- Deploy note: additive CREATE TABLE IF NOT EXISTS — existing databases
-- get the table from the schema.sql step that runs on every deploy; no
-- ALTER, no CI DDL step, no data backfill. Customers researched before
-- this stage are gap-filled lazily: their next reuse pass writes facts
-- from the saved text (source_type 'backfill'), so the substrate
-- converges without a heavy one-time migration.
-- Retention: Stage 31 policy extends with the same superseded-only prune
-- as evidence/sources (src/data-retention.ts).

CREATE TABLE IF NOT EXISTS research_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  research_run_id TEXT,
  customer_id TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  source_type TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  confidence REAL,
  parser_version TEXT,
  fetched_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,
  valid_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_research_facts_customer ON research_facts(customer_id, is_current);
CREATE INDEX IF NOT EXISTS idx_research_facts_run ON research_facts(research_run_id);
