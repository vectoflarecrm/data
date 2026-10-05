-- Phase 3 Stage 36 — one-time backfill: every customer's existing
-- full_research_text blob becomes a synthetic research run + one
-- 'backfill' source row, so legacy raw snapshots join the append-only
-- history instead of remaining a single overwrite-prone copy.
--
-- Executed by the CI step "Backfill research_sources from
-- full_research_text (Phase 3 Stage 36)" AFTER the schema.sql step (the
-- table exists) and BEFORE the new worker deploys (no live writer can
-- race it on first run).
--
-- Idempotent — re-runs are no-ops on every interleaving:
--   * run ids are deterministic ('backfill-' || customers.id);
--   * the runs INSERT skips customers that already have a backfill run
--     (parser_version = 'backfill-v1') or ANY research_sources row
--     (a customer already researched by the post-Stage-36 code has real
--     per-run history — a synthetic snapshot would only pollute it);
--   * the sources INSERT skips runs that already have a source row.
--
-- Atomic — wrangler d1 execute --file wraps the whole file in one
-- implicit transaction (verified in the Stage 34 FK rebuild), so a
-- failure leaves no backfill runs without their source rows.
--
-- content_hash is NULL on purpose: the hash is computed by the writer
-- (WebCrypto in the Worker); legacy blobs enter unhashed, and the next
-- real research run supersedes them with properly hashed rows.
--
-- Rows: 2 per eligible customer (1 run + 1 source) — one-time cost inside
-- the free-plan rows_written budget; re-deploys insert nothing.

INSERT INTO research_runs (id, customer_id, status, started_at, completed_at, parser_version)
SELECT 'backfill-' || c.id, c.company_id, 'completed', DATETIME('now'), DATETIME('now'), 'backfill-v1'
FROM customers c
WHERE c.company_id IS NOT NULL
  AND c.full_research_text IS NOT NULL
  AND TRIM(c.full_research_text) <> ''
  AND NOT EXISTS (SELECT 1 FROM research_runs r WHERE r.customer_id = c.company_id AND r.parser_version = 'backfill-v1')
  AND NOT EXISTS (SELECT 1 FROM research_sources s WHERE s.customer_id = c.company_id);

INSERT INTO research_sources (research_run_id, customer_id, source_type, source_url, raw_text, content_hash, parser_version, fetched_at, is_current, valid_from)
SELECT r.id, r.customer_id, 'backfill', NULL, c.full_research_text, NULL, 'backfill-v1', DATETIME('now'), 1, DATETIME('now')
FROM customers c
JOIN research_runs r ON r.id = 'backfill-' || c.id
WHERE NOT EXISTS (SELECT 1 FROM research_sources s WHERE s.research_run_id = r.id);
