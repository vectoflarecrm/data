-- Phase 4 Stage 42 — profile/strategy layer (research_profiles) + the
-- research_facts entity column (contact_id).
--
-- Part 1 (research_profiles, design §4.3): the company_profile /
-- outreach_context / solutions payloads lived ONLY in one-shot cache
-- columns on customers — overwritten per run, history destroyed (the 3b
-- review's documented outreach_profiles trigger). One profile row per
-- research run keeps every version. Grain: 1:1 with research runs — all
-- three payloads are written by the same call and read by the same
-- prompt, so splitting them would be grain-mixing without a consumer.
-- solutions arrive here as their own array (they are prompt material
-- read together with the strategy, not a query target — §4.2 kept them
-- out of research_personas for exactly this destination).
--
-- Write path (appendResearchProfile in src/research-run.ts) is APPEND +
-- supersede, identical to evidence v2 (0012) / sources (0020) / facts
-- (0022) / signals (0023) / personas (0024):
--
--   UPDATE research_profiles SET is_current = 0, valid_until = <now>
--     WHERE customer_id = ? AND is_current = 1;
--   INSERT INTO research_profiles (..., is_current = 1, valid_from = <now>);
--
-- — both inside one D1 batch. The row ALWAYS lands, even when all three
-- payloads are null: one run = one row is the grain, and a run that
-- produced nothing is still history. Writer-side bounds: solutions are
-- bounded like personas (≤ 10 per run, each field ≤ 200 chars, blank
-- names dropped); the opaque profile/strategy JSON strings are stored
-- as-is when they fit PROFILE_JSON_CAP chars, or dropped to NULL when
-- they exceed it (never truncated — a sliced JSON string would violate
-- the json_valid guard).
--
-- Column semantics:
--   research_run_id       soft reference into research_runs (null when the
--                         run row could not be created — fail-open)
--   customer_id           customers.company_id TEXT, same key style as
--                         every other provenance table
--   company_profile_json  the customers.company_profile payload snapshot
--                         (null when the analysis produced none)
--   strategy_json         the customers.outreach_context payload snapshot
--                         (null when the analysis produced none)
--   solutions_json        the solutions array from personas_and_solutions
--                         (always a JSON array, possibly [])
--   parser_version        'profiles-v1' (PROFILES_PARSER_VERSION)
--   created_at            when this run produced the profile
--   is_current            1 = current profile, 0 = superseded history
--   valid_from / valid_until   validity window of this row
--
-- Part 2 (research_facts.contact_id, design §4.4): light entity
-- resolution. A nullable column needs no table rebuild, so existing
-- databases take a single ALTER (applied by the dedicated CI step in
-- deploy-worker.yml, duplicate-column tolerant like every Stage 17+
-- ALTER); fresh installs get it inside the schema.sql CREATE directly.
-- When a run persists found_contacts, its own email/phone facts are
-- linked by value match (linkResearchFactsToContacts in
-- src/research-run.ts): fact → contact → run → sources answers §十四's
-- "这个邮箱是谁、什么时候、从哪个网页提取的" as one JOIN. Scoping is
-- strict: only THIS run's current facts, only contacts of the SAME
-- company, and never overwriting an existing link (contact_id IS NULL
-- guard). A null run id skips linkage entirely — an unscoped UPDATE
-- would reach other runs' orphan rows.
--
-- Deploy note: the CREATE is additive (schema.sql step on every deploy,
-- no CI DDL step, no backfill — rows accumulate from the next run
-- onward, exactly like facts in Stage 37); only the ALTER needs the CI
-- step. Customers researched before this stage keep unlinked facts
-- until their next research run.
-- Retention: Stage 31 policy extends with the same superseded-only
-- prune as evidence/sources/facts/signals/personas
-- (src/data-retention.ts). The customers cache columns stay the
-- "latest" snapshots (docs/phase4-ai-intelligence.md §3.4: caches stay
-- caches — no deprecation cutover scheduled).

CREATE TABLE IF NOT EXISTS research_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  research_run_id TEXT,
  customer_id TEXT NOT NULL,
  company_profile_json TEXT CHECK (company_profile_json IS NULL OR json_valid(company_profile_json)),
  strategy_json TEXT CHECK (strategy_json IS NULL OR json_valid(strategy_json)),
  solutions_json TEXT CHECK (solutions_json IS NULL OR json_valid(solutions_json)),
  parser_version TEXT,
  created_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,
  valid_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_research_profiles_customer ON research_profiles(customer_id, is_current);
CREATE INDEX IF NOT EXISTS idx_research_profiles_run ON research_profiles(research_run_id);

-- Existing databases: the entity column. Fresh installs already have it
-- from schema.sql — running this by hand is safe (duplicate column names
-- are an error, hence the CI step's tolerance wrapper).
ALTER TABLE research_facts ADD COLUMN contact_id TEXT;
