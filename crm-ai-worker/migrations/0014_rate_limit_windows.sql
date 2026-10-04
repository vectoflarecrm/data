-- Security V2 Stage 16 (spec §17) — distributed provider RPM limiter.
--
-- rate_limit_windows backs the D1RateLimiter in src/rate-limiter.ts: the
-- authoritative GLOBAL fixed-window counter that caps the aggregate provider
-- RPM across Cloudflare isolates and worker instances (the in-memory window
-- in rate-limit.ts only bounds one isolate and remains the local fast
-- limiter, tried first).
--
-- One row per key; the whole claim is a single atomic upsert:
--
--   INSERT INTO rate_limit_windows (key, window_start, count)
--   VALUES (?, ?, 1)
--   ON CONFLICT(key) DO UPDATE SET
--     count = CASE WHEN rate_limit_windows.window_start = excluded.window_start
--                  THEN rate_limit_windows.count + 1
--                  ELSE 1 END,
--     window_start = excluded.window_start
--   RETURNING count
--
-- so concurrent isolates can never overshoot the cap (same atomicity
-- argument as the Stage 12 campaign lock). The stored count records
-- ATTEMPTS in the current window — a rejected attempt still increments it
-- (the atomic increment IS the claim attempt), and admission is
-- `count <= limit`, so once over the cap every further attempt this window
-- is rejected until the CASE resets the counter on rollover.
-- A fixed window admits at most 2x the cap across a boundary — acceptable,
-- because the reactive layer (upstream 429 capture + api_key_health
-- cooldown) remains the safety net.
--
-- window_start rolls forward IN PLACE on each window change, so the table
-- holds at most one row per key ever used and never needs cleanup.
--
-- Failure policy: FAIL OPEN. Rate limiting is a protective optimization,
-- not a correctness control — a migration-pending or degraded D1 degrades
-- to exactly the pre-Stage-16 behavior (per-isolate limiting only), and
-- D1RateLimiter logs a warning instead of blocking research.
--
-- No data backfill needed; no deploy-workflow step needed (new table:
-- schema.sql creates it via IF NOT EXISTS before the new code runs).

CREATE TABLE IF NOT EXISTS rate_limit_windows (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1
);
