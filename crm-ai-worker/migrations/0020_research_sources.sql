-- Phase 3 Stage 36 — raw source registry (research_sources).
--
-- 建议 §十三/§十四: research_runs should keep the raw material they were
-- built from — which URL, fetched when, content hash, raw text, parser
-- version — and customers.full_research_text (a single concatenated blob,
-- overwritten on every fresh research pass) should not permanently be the
-- only raw record.
--
-- New table research_sources: one row per raw crawl segment per run
-- (source_type 'website' / 'social' / 'search' / 'additional'; legacy
-- snapshots enter as 'backfill' via 0021). Write path
-- (appendResearchSources in src/research-run.ts) is APPEND + supersede,
-- identical to evidence v2 (Stage 14 / 0012):
--
--   UPDATE research_sources SET is_current = 0, valid_until = <now>
--     WHERE customer_id = ? AND is_current = 1;
--   INSERT INTO research_sources (..., is_current = 1, valid_from = <now>);
--
-- — both inside one D1 batch. Total raw text per run is budget-capped to
-- the same 50 000 chars the blob always enforced, so per-run history never
-- stores more than the pipeline already saved.
--
-- Column semantics (mirror evidence where applicable):
--   research_run_id  soft reference into research_runs (null when the run
--                    row could not be created — fail-open, like evidence)
--   customer_id      customers.company_id TEXT, same key style as evidence
--   content_hash     sha256-16 of raw_text — detects raw drift between runs
--   parser_version   which writer produced the row ('sources-v1' live,
--                    'backfill-v1' legacy snapshots)
--   fetched_at       when this pass captured the segment
--   is_current       1 = current snapshot, 0 = superseded history
--   valid_from / valid_until   validity window of this snapshot
--
-- Deploy note: additive CREATE TABLE IF NOT EXISTS — existing databases
-- get the table from the schema.sql step that runs on every deploy; fresh
-- databases get it from schema.sql directly. No ALTER, no CI DDL step.
-- Existing blobs are backfilled by 0021_research_sources_backfill.sql.
-- Retention: the Stage 31 policy extends with the same superseded-only
-- prune as evidence (src/data-retention.ts).

CREATE TABLE IF NOT EXISTS research_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  research_run_id TEXT,
  customer_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  raw_text TEXT,
  content_hash TEXT,
  parser_version TEXT,
  fetched_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,
  valid_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_research_sources_customer ON research_sources(customer_id, is_current);
CREATE INDEX IF NOT EXISTS idx_research_sources_run ON research_sources(research_run_id);
