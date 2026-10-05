# Stage 31 — Business-data retention (post-V2)

Closes the original audit's "P2 research/contact data retention & bloat"
finding. Stage 25 bounded `audit_logs`; this stage bounds the remaining
unbounded tables.

## What grows and what was done

| Table | Growth | Reader today | Policy |
|---|---|---|---|
| `gmail_send_log` | 1 row per send attempt | today-scoped quota counts only | `DATA_RETENTION_DAYS` (default 180) |
| `research_runs` | 1 row per research run | **nothing in src** (pure bookkeeping; evidence carries its own `research_run_id`) | `DATA_RETENTION_DAYS` |
| `evidence` | append-only trail, top-30 shown per company in the modal | customer modal | **superseded-only**: `is_current = 0 AND COALESCE(valid_until, collected_at) < cutoff` — the live chain of every field survives forever |
| `customer_imports` | raw import layer, full `raw_json` per row (heaviest table), read by nothing today | — | `DATA_RETENTION_DAYS`; deleting old rows forfeits re-processing of imports older than the horizon — normalized customers always survive |
| `admin_login_attempts` | one throttle bucket per (scope, ident) — distinct hashed IPs churn | throttle code (lock window 900 s) | **fixed 30-day sweep**, not governed by the var |

Deliberately excluded (documented in `src/data-retention.ts`):
`contacts` / `outreach_emails` / `outreach_campaign_members` (live business
data, not time-series), `api_key_usage` (one tiny row per key per day; the
panel's 累计 stat sums the whole table — pruning would silently redefine the
displayed semantics), `rate_limit_windows` (rolls forward in place),
`campaign_locks` (rows reused/stolen per campaign), `gmail_send_reservations`
(release is a DELETE plus an expiry sweeper).

## Semantics

- `DATA_RETENTION_DAYS` — same policy shape as `AUDIT_RETENTION_DAYS`:
  unset/empty → 180; `"0"` → business-data pruning disabled; positive int →
  N days; garbage/negative → 180 with a warn (a typo must never prune MORE
  aggressively than the default).
- `"0"` still sweeps `admin_login_attempts` — that is hygiene, not business
  data, and the lock window is 900 s.
- Every non-empty prune writes a `DATA_PRUNE` audit row (actor `system`)
  with `{retention_days, gmail_send_log, research_runs, evidence_superseded,
  customer_imports}` — the trail records its own maintenance, so silent mass
  deletion is impossible (same stance as Stage 25's `AUDIT_PRUNE`).
- Fail-open: missing tables are silent 0s (pre-migration stance); other D1
  errors are caught in the cron envelope, logged, and the research tick
  continues.
- A `research_runs` row still marked `running` past the horizon is a crashed
  run — safe to drop (nothing joins on it).
- Format note: all five tables write `YYYY-MM-DD HH:MM:SS` UTC timestamps
  (`CURRENT_TIMESTAMP` default or the `sqlUtc`/`toSqlUtc` helpers), so the
  string comparison against the cutoff is exact — verified per write site
  before implementing.

## What shipped

- `src/data-retention.ts` — resolver + five prunes over one shared
  `pruneBefore` helper (missing-table tolerance, `meta.changes` counts).
- `src/index.ts` — `DATA_RETENTION_DAYS` on Env; two cron envelopes after
  the WebAuthn cleanup block (business-data prune + audit row; fixed
  login-attempt sweep).
- `wrangler.toml` — documented var block.
- No migration: all tables already exist; the prunes tolerate their absence.

## Verification

- `tests/data-retention.test.ts` — 19 tests: resolver matrix (4); per-table
  prune semantics — strict-`<` boundary, missing-table 0, error propagation,
  crashed-`running` runs, superseded-only evidence (live chains never cut,
  `valid_until` precedence, legacy `collected_at` fallback), fixed 30-day
  login sweep; cron integration — `DATA_RETENTION_DAYS="30"` prunes all four
  tables and writes the exact `DATA_PRUNE` metadata, `"0"` keeps business
  data but still sweeps login attempts with no audit row, and a throwing
  prune never breaks the tick.
- Full suite **661/661 (53 files)**, `tsc --noEmit` clean, dry-run
  530.25 KiB / gzip 130.59 KiB, 7 panels clean.
- Docs updated: `deployment-v2.md` (var table + gate numbers),
  `security-v2-final-report.md` (P2 row closed, Stage 31 bullet, counts).

## Operational notes

- Deploy is a plain worker update; behavior with the var unset: rows older
  than 180 days start disappearing on the next cron tick — set
  `DATA_RETENTION_DAYS` explicitly (e.g. `"365"`) before deploying if the
  operator wants a longer horizon, or `"0"` to opt out entirely.
- Evidence depth shown in the customer modal (top 30) shrinks only for
  history older than the horizon; current values are unaffected.
- Audit vocabulary added: `DATA_PRUNE {retention_days, gmail_send_log,
  research_runs, evidence_superseded, customer_imports}`.
