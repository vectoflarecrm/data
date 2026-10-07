-- Phase 4 Stage 40 — buying-signal layer (research_signals).
--
-- 建议 §二十一 pipeline: Raw Evidence → Fact Extraction → Entity
-- Resolution → Company Profile → Buyer Persona → Buying Signal → Lead
-- Score → Outreach Strategy → Email. research_sources (Stage 36) is the
-- raw layer, research_facts (Stage 37) the fact layer; this table is the
-- Buying Signal layer. Until now signals lived ONLY in the
-- customers.buying_signals JSON cache — overwritten per run and read by
-- nothing (no panel section, no campaign filter, no prompt input). Typed
-- rows give the layer history (re-research no longer destroys it) and a
-- query surface for the panel now and campaign targeting later.
--
-- Grain: one row per distinct signal string per run (dedup within the
-- run, AI order preserved).
--
-- Write path (appendResearchSignals in src/research-run.ts) is APPEND +
-- supersede, identical to evidence v2 (0012) / sources (0020) / facts
-- (0022):
--
--   UPDATE research_signals SET is_current = 0, valid_until = <now>
--     WHERE customer_id = ? AND is_current = 1;
--   INSERT INTO research_signals (..., is_current = 1, valid_from = <now>);
--
-- — both inside one D1 batch. Unlike the facts writer, the supersede
-- runs even when the run found ZERO signals: the current set must always
-- mirror the latest run's judgment, exactly like the cache column (which
-- gets NULL when the analysis returns an empty array). Writer-side
-- bounds: at most 20 rows per run, signal_text capped at 500 chars.
--
-- Column semantics:
--   research_run_id  soft reference into research_runs (null when the run
--                    row could not be created — fail-open, like evidence)
--   customer_id      customers.company_id TEXT, same key style as evidence
--   signal_text      one concrete purchase signal, as returned by the AI
--   parser_version   'signals-v1' (SIGNALS_PARSER_VERSION)
--   created_at       when this run observed the signal
--   is_current       1 = current signal set, 0 = superseded history
--   valid_from / valid_until   validity window of this set
--
-- Deploy note: additive CREATE TABLE IF NOT EXISTS — existing databases
-- get the table from the schema.sql step that runs on every deploy; no
-- ALTER, no CI DDL step, no data backfill. Customers researched before
-- this stage have no signal rows (their cache column is the only record)
-- until their next research run.
-- Retention: Stage 31 policy extends with the same superseded-only prune
-- as evidence/sources/facts (src/data-retention.ts).
-- The customers.buying_signals JSON column stays as the "latest" cache
-- (docs/phase4-ai-intelligence.md §3.4: caches stay caches — no
-- deprecation cutover scheduled).

CREATE TABLE IF NOT EXISTS research_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  research_run_id TEXT,
  customer_id TEXT NOT NULL,
  signal_text TEXT NOT NULL,
  parser_version TEXT,
  created_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,
  valid_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_research_signals_customer ON research_signals(customer_id, is_current);
CREATE INDEX IF NOT EXISTS idx_research_signals_run ON research_signals(research_run_id);
