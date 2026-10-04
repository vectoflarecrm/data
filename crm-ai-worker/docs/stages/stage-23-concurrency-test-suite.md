# Stage 23 — Concurrency Test Suite (spec §24)

## Scope

Spec §24 requires `tests/concurrency/` with five named files — `gmail-quota.test.ts`, `gmail-idempotency.test.ts`, `campaign-claim.test.ts`, `research-claim.test.ts`, `provider-rate-limit.test.ts` — each simulating at least 10 / 50 / 100 concurrent tasks against the concurrency primitives introduced in Stages 10-16.

## Concurrency model (and what it does / does not prove)

The suites run N parallel async tasks (`Promise.allSettled`) through the same FakeD1 shim (node:sqlite + `schema.sql`) used by the stage suites and `tests/security/`. node:sqlite is synchronous, so tasks interleave at `await` boundaries rather than on true parallel threads. That is exactly the property under test: every protected primitive is **one atomic SQL statement** (an `INSERT…SELECT` guard, an `ON CONFLICT … WHERE` upsert, an `UPDATE … RETURNING` claim), and D1 executes single statements atomically — so if the invariant holds under maximal interleaving of the async wrappers, it holds under real concurrent isolates. If a primitive ever regresses to read-then-write, these tests fail. They do not attempt to fake multi-isolate clock skew; the campaign-lock TTL steal is driven by seeding an expired row instead.

## Files

| File | Tests | Core invariant |
|---|---|---|
| `tests/concurrency/_helpers.ts` | — | `makeDb` (re-exported from `tests/security/_helpers.ts`), `d1env`, `runTasks`, `CONCURRENCY_LEVELS = [10, 50, 100]`, `sqlUtc`/`PAST` |
| `gmail-quota.test.ts` | 11 | `reserveQuota` (INSERT…SELECT + two count subqueries): a storm racing the last slots admits **exactly** `daily_limit` (10/50/100); same-email storms admit exactly one slot (UNIQUE `email:<id>` → 预留冲突); already-sent rows shrink the budget by exactly S; release returns the slot; the TTL reaper frees both slot and unique key |
| `gmail-idempotency.test.ts` | 10 | The production claim UPDATE (mirror of `src/outreach-send.ts:193-198`): exactly one worker flips a draft to `reserved` (`send_attempts` incremented once); the unique partial index `idx_outreach_idempotency` keeps exactly one row per logical message key under a stampede (the double-send guard); one reservation per outreach email; a lost claimant sees `changes=0`, never a second send |
| `campaign-claim.test.ts` | 11 | `acquireCampaignLock` (ON CONFLICT … WHERE expires_at <= now): N workers → exactly one lock, the rest `null`; an expired lock is stolen exactly once; 5 campaigns × N workers → exactly 5 locks, all released cleanly; release is token-guarded (a stale holder's release cannot delete a newer lock) |
| `research-claim.test.ts` | 10 | `claimCustomers` (atomic `UPDATE … WHERE id IN (SELECT … LIMIT 3) RETURNING` after stale recovery): N parallel claims over 3N pending rows are pairwise disjoint and drain the queue; over a shrinking queue the totals stay exact; stale `processing` rows are recovered and claimed at most once; empty queue returns empty batches, never errors |
| `provider-rate-limit.test.ts` | 17 | `D1RateLimiter` (atomic upsert + RETURNING count): one shared window admits exactly the limit (10/50/100), two keys stay independent, rejected attempts still count (attempt counter may exceed the limit); `providerRateLimiter()` (tiered local+D1) caps at the same limit; with the D1 window unavailable it **fails open to local-only limiting** (exactly the local cap, never unlimited, never a crash); window rollover resets the cap; `LocalRateLimiter` storm admits exactly the limit |

All five files drive their core invariant at N = 10, 50 and 100 (`CONCURRENCY_LEVELS`), per spec.

## Real defect found and fixed: schema drift on `gmail_send_log.sender_client_email`

The quota fixture seeds `gmail_send_log … (sender_client_email)` from `schema.sql` — and that INSERT failed: the column exists only in `migrations/0003` (the ALTER for the live database). `schema.sql`'s `CREATE TABLE gmail_send_log` never carried it, and no deploy-workflow step covered it. Consequence: a **fresh install** from schema.sql would make every `reserveQuota` fail closed ("no such column: sender_client_email" → a quota control must not degrade), i.e. a brand-new deployment could send zero email. The existing Stage 11 tests never caught it because they hand-created the table with the extra column.

Fixed in three coordinated places (baseline row #20):

1. `schema.sql` — `CREATE TABLE gmail_send_log` now includes `sender_client_email TEXT` (with a comment).
2. `.github/workflows/deploy-worker.yml` — new step "Migrate gmail_send_log sender column (Security V2 Stage 23)": idempotent per-statement ALTER with duplicate-column tolerance + `pragma_table_info` verification, same pattern as the Stage 10/17 column steps. Self-heals any database created from the old schema.sql; a no-op on the live database (0003 already ran).
3. `migrations/0016_gmail_send_log_sender.sql` — documents the drift and the fix.

## Code change outside tests

- `src/index.ts` — `claimCustomers` is now exported (one added `export { claimCustomers }` with a comment), following the existing "exported for unit tests" precedent at `src/index.ts:1830`. No behavior change.

## Verification

- `tsc --noEmit`: clean.
- Full suite: **534 passed / 534** (44 files) — 475 pre-existing + 59 new (the concurrency suite), zero regressions.
- `wrangler deploy --dry-run`: 439.10 KiB / gzip 111.86 KiB, exits clean.
- `node scripts/check-panel.mjs`: 4 panels clean.
- Expected stderr noise: the D1-unavailable rate-limiter cases log `[rate-limiter] D1 window unavailable … failing open` by design (that is the documented fail-open path under test).

## Test-writing learnings (fixture level, for future stages)

- Import depth: from `tests/concurrency/`, src is `../../src/` (not `../src/`) — the initial run failed collection on 4 files.
- node:sqlite enforces FKs by default: `outreach_emails.customer_id` fixtures need real `customers` rows (or NULL).
- `customers.updated_at` is `NOT NULL DEFAULT CURRENT_TIMESTAMP` — explicitly binding NULL defeats the DEFAULT and throws; bind a real timestamp.
- PowerShell 5.1 `Get-Content`/`Set-Content` round-trips corrupt UTF-8 (Chinese assertions became GBK mojibake): bulk text edits on files with non-ASCII content must go through the proper edit tooling, not the shell.

## Files changed

- `crm-ai-worker/schema.sql` (+6: the column + comment)
- `.github/workflows/deploy-worker.yml` (+10: the migration step)
- `crm-ai-worker/migrations/0016_gmail_send_log_sender.sql` (new, +11)
- `crm-ai-worker/src/index.ts` (+4: export claimCustomers)
- `crm-ai-worker/tests/concurrency/_helpers.ts` (new)
- `crm-ai-worker/tests/concurrency/{gmail-quota,gmail-idempotency,campaign-claim,research-claim,provider-rate-limit}.test.ts` (new, 59 tests)
- `crm-ai-worker/docs/security-v2-baseline.md` (row #20)
- `crm-ai-worker/docs/stages/stage-23-concurrency-test-suite.md` (this report)
