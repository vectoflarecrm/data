-- Security V2 Stage 12 (spec §13) — campaign execution lock.
--
-- One row per campaign while a worker executes it (generate or send step).
-- The claim itself is a single atomic upsert in src/campaign-lock.ts:
--
--   INSERT INTO campaign_locks …
--   ON CONFLICT(campaign_id) DO UPDATE SET …
--   WHERE campaign_locks.expires_at <= <now>
--
-- so a fresh INSERT lands when no row exists, an EXPIRED lock is stolen in
-- place, and a LIVE lock yields zero changes → "campaign busy" (HTTP 409).
-- Release is DELETE … WHERE campaign_id = ? AND lock_token = ?, token-guarded
-- so a worker that lost its lock to TTL expiry can never delete the new
-- holder's row.
--
-- The lock is single-flight DEFENSE IN DEPTH on top of Stage 10 (per-email
-- atomic claims) and Stage 11 (per-slot quota reservations): without it, two
-- workers on the same campaign would not double-send, but they would
-- double-spend AI tokens in the generate step and burn quota on members the
-- other worker already owns. A migration-pending database (this table absent)
-- fails OPEN — see src/campaign-lock.ts for the rationale.
--
-- No data backfill needed; no deploy-workflow step needed (new table:
-- schema.sql creates it via IF NOT EXISTS before the new code runs).

CREATE TABLE IF NOT EXISTS campaign_locks (
  campaign_id INTEGER PRIMARY KEY,
  lock_token TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
