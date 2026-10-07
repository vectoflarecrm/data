-- Phase 4 Stage 41 — buyer-persona layer (research_personas).
--
-- 建议 §二十一 pipeline: Raw Evidence → Fact Extraction → Entity
-- Resolution → Company Profile → Buyer Persona → Buying Signal → Lead
-- Score → Outreach Strategy → Email. This table is the Buyer Persona
-- layer. Until now personas lived ONLY in the
-- customers.personas_and_solutions JSON cache — overwritten per run and
-- consumed solely by the panel's field renderer; the outreach prompt
-- never saw them (no persona grounding in buildOutreachPrompt). Typed
-- rows give the layer history (re-research no longer destroys it) and a
-- query surface: the outreach prompt reads the current set (angle per
-- persona), the panel renders it (with JSON-column fallback).
--
-- Grain: one row per persona per run (dedup by persona_name within the
-- run, AI order preserved). needs/pain_points are stored as JSON string
-- arrays (json_valid-guarded); solutions stay in the profile payload
-- (phase4 §4.2: they are prompt material, not a query target — Stage 42
-- carries them in research_profiles).
--
-- Write path (appendResearchPersonas in src/research-run.ts) is APPEND +
-- supersede, identical to evidence v2 (0012) / sources (0020) / facts
-- (0022) / signals (0023):
--
--   UPDATE research_personas SET is_current = 0, valid_until = <now>
--     WHERE customer_id = ? AND is_current = 1;
--   INSERT INTO research_personas (..., is_current = 1, valid_from = <now>);
--
-- — both inside one D1 batch. Like the signals writer, the supersede
-- runs even when the run found ZERO personas: the current set must
-- always mirror the latest run's judgment, exactly like the cache
-- column (which always stores the full personas_and_solutions object,
-- empty arrays included). Writer-side bounds: at most 10 personas per
-- run, name/role capped at 120 chars, at most 6 needs/pain points per
-- persona, each capped at 200 chars.
--
-- Column semantics:
--   research_run_id  soft reference into research_runs (null when the run
--                    row could not be created — fail-open, like evidence)
--   customer_id      customers.company_id TEXT, same key style as evidence
--   persona_name     the persona archetype, as returned by the AI
--   persona_role     the matching job title, when the AI provided one
--   needs_json       string array — what this persona cares about
--   pain_points_json string array — what this persona struggles with
--   parser_version   'personas-v1' (PERSONAS_PARSER_VERSION)
--   created_at       when this run observed the persona
--   is_current       1 = current persona set, 0 = superseded history
--   valid_from / valid_until   validity window of this set
--
-- Deploy note: additive CREATE TABLE IF NOT EXISTS — existing databases
-- get the table from the schema.sql step that runs on every deploy; no
-- ALTER, no CI DDL step, no data backfill. Customers researched before
-- this stage have no persona rows (the outreach prompt falls back to
-- their cache column, the panel to its JSON renderer) until their next
-- research run.
-- Retention: Stage 31 policy extends with the same superseded-only
-- prune as evidence/sources/facts/signals (src/data-retention.ts).
-- The customers.personas_and_solutions JSON column stays as the
-- "latest" cache (docs/phase4-ai-intelligence.md §3.4: caches stay
-- caches — no deprecation cutover scheduled).

CREATE TABLE IF NOT EXISTS research_personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  research_run_id TEXT,
  customer_id TEXT NOT NULL,
  persona_name TEXT NOT NULL,
  persona_role TEXT,
  needs_json TEXT CHECK (needs_json IS NULL OR json_valid(needs_json)),
  pain_points_json TEXT CHECK (pain_points_json IS NULL OR json_valid(pain_points_json)),
  parser_version TEXT,
  created_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,
  valid_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_research_personas_customer ON research_personas(customer_id, is_current);
CREATE INDEX IF NOT EXISTS idx_research_personas_run ON research_personas(research_run_id);
