-- Security V2 Stage 14 (spec §15) — Evidence V2: research runs + append-only
-- evidence.
--
-- New table research_runs (spec §15.1, verbatim DDL): one row per research
-- attempt, status running → completed/failed, with parser/model provenance and
-- the failure reason. Evidence rows reference the run that produced them.
--
-- Existing evidence table gains provenance + validity columns. The write path
-- (src/research-run.ts) changes from DELETE-then-INSERT (which destroyed the
-- previous verification trail on every re-research) to APPEND + supersede:
--
--   UPDATE evidence SET is_current = 0, valid_until = <now>
--     WHERE company_id = ? AND field_name = ? AND is_current = 1;
--   INSERT INTO evidence (…, is_current = 1, valid_from = <now>) …;
--
-- — both inside one D1 batch, so supersede+append apply atomically. History
-- stays queryable; "current facts" are decided by is_current / valid_from /
-- valid_until (spec §15.2).
--
-- Column semantics:
--   research_run_id  FK-ish reference into research_runs
--   source_id        stable identity of the source document (hash of source_url)
--   source_hash      identity of what the source said (hash of quoted evidence)
--   content_hash     identity of the fact (hash of field_name + field_value)
--   parser_version   which evidence writer produced the row (evidence-v2)
--   model_name / model_version  which provider/model judged the fact
--   retrieved_at     when this pass collected the fact
--   is_current       1 = current fact, 0 = superseded history
--   valid_from / valid_until    validity window of this version
--
-- Deploy note: existing databases get the evidence columns via the per-statement
-- ALTER step in .github/workflows/deploy-worker.yml (ADD COLUMN is not
-- idempotent inside a D1 batch file); fresh databases get the full shape from
-- schema.sql. Existing rows are backfilled as is_current = 1 by the ALTER's
-- NOT NULL DEFAULT 1 — they WERE the current facts at migration time, and the
-- next research run supersedes them through the normal append path.

CREATE TABLE IF NOT EXISTS research_runs (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    parser_version TEXT,
    model_name TEXT,
    model_version TEXT,
    error TEXT
);

ALTER TABLE evidence ADD COLUMN research_run_id TEXT;
ALTER TABLE evidence ADD COLUMN source_id TEXT;
ALTER TABLE evidence ADD COLUMN source_hash TEXT;
ALTER TABLE evidence ADD COLUMN content_hash TEXT;
ALTER TABLE evidence ADD COLUMN parser_version TEXT;
ALTER TABLE evidence ADD COLUMN model_name TEXT;
ALTER TABLE evidence ADD COLUMN model_version TEXT;
ALTER TABLE evidence ADD COLUMN retrieved_at TEXT;
ALTER TABLE evidence ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1;
ALTER TABLE evidence ADD COLUMN valid_from TEXT;
ALTER TABLE evidence ADD COLUMN valid_until TEXT;
