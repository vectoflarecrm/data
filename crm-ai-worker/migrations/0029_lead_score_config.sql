-- Phase 10 Stage 55 — lead_score_config (建议 §十八 deferred item, design
-- docs/phase10-lead-score-config.md §2).
--
-- The six lead-score dimension weights become operator-tunable without a
-- code deploy. Single global profile: CHECK(id = 1) is the enforced
-- invariant, not a convention — the config is one row, and a second row is
-- a schema violation rather than an ambiguity.
--
-- weights_json is written ONLY through the validated PUT
-- /admin/api/lead-score/config path: exactly the six dimension keys
-- (icp_fit/product_fit/buyer_role/buying_signal/reachability/
-- strategic_value), each an integer 0-100, summing to EXACTLY 100 — the
-- frozen 0-100 total contract of docs/phase5-lead-score-v2.md §3.2/§4.
-- No column CHECK: the guard is the single validated writer, the same
-- stance as migration 0026's breakdown cache (writer-side guarantees over
-- retro-unapplicable SQLite constraints).
--
-- Missing table/row fails open to the code defaults (LEAD_SCORE_WEIGHTS in
-- src/lead-score-dims.ts): research and scoring behave exactly as
-- pre-Stage-55 during the migration-pending window, and fresh installs
-- score with defaults until the operator tunes. A stored-but-invalid row
-- (hand-edited, corrupt JSON) also fails open to defaults — loud in the
-- structured log, never a scoring outage.
--
-- Paths writing it:
--   PUT config (validated)  upsert row id=1: weights_json + updated_at/by
--   Stage 57 rescore sweep  reads weights, writes customers.lead_score* —
--                           this table itself is read-only there
--
-- Existing databases: CREATE TABLE IF NOT EXISTS only, additive, no data
-- movement. Fresh installs get the same shape inside schema.sql.

CREATE TABLE IF NOT EXISTS lead_score_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  weights_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
