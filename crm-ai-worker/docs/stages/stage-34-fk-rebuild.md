# Stage 34 — outreach_emails FK rebuild (post-V2)

The last schema-shaped item on the deferred list: legacy databases run an
`outreach_emails` without the `FOREIGN KEY (customer_id) REFERENCES
customers(id)` declaration that `schema.sql` has carried since the
beginning. This stage closes that drift.

## Why this was the only table that needed it

- `schema.sql` declares exactly four FOREIGN KEYs: `outreach_emails` →
  `customers`, and the three WebAuthn/admin tables → `admin_users`.
- The WebAuthn tables are new (migration 0017, Stage 29) — every existing
  database created them **with** their FK declarations. No drift.
- `outreach_emails` predates the FK declaration in `schema.sql`, so
  databases initialized from an early schema run constraint-free. Drift.
- D1 enforces foreign keys by default in every transaction ("identical to
  `PRAGMA foreign_keys = on`" — D1 docs), so fresh installs were already
  living under the constraint while legacy databases were not. Same code,
  two different integrity postures — exactly the Stage 23 class of problem.

## Why a rebuild (and why now it is safe)

SQLite cannot `ALTER TABLE … ADD FOREIGN KEY`. The only way is the classic
rename-and-copy dance: create the new shape, `INSERT SELECT` the rows
(Explicit column names — physical column order in legacy tables differs
because the send-state and `request_id` columns arrived via `ALTER`), drop
the old table, rename, recreate the five indexes (`DROP TABLE` takes a
table's indexes with it).

What makes it safe here:

- **Single transaction**: wrangler `d1 execute --file` runs the whole file
  as one implicit transaction (the repo's "D1 fails a whole schema file"
  observation, used deliberately this time). Any statement failing rolls
  the entire rebuild back — the database never observes a half-migrated
  state.
- **Idempotent gate, not idempotent brute force**: the CI step checks
  `pragma_foreign_key_list('outreach_emails')` first and skips the rebuild
  entirely when the FK is present. The file itself is re-execution-safe
  (leading `DROP TABLE IF EXISTS`), but repeated data copying would burn
  D1's free-plan `rows_written` quota for nothing — the gate is the
  primary defense, the file is the secondary one.
- **Orphan gate with a name**: `customers` has no DELETE path anywhere in
  the codebase (structural orphan prevention, stage-17), so legacy data
  should be orphan-free — but the step still counts orphans before
  rebuilding and, if any exist, **fails the deploy with the exact cleanup
  SQL printed**, rather than letting the constraint failure be the
  operator's problem or silently dropping rows. Data surgery is never
  automatic.
- **Post-verification**: FK present (`pragma_foreign_key_list` = 1 row)
  and row count unchanged before/after — a deploy cannot succeed with a
  half-rebuilt table.
- **No behavior change**: same columns, same indexes, same AUTOINCREMENT
  sequence (explicit-id INSERTs carry `sqlite_sequence` over, pinned by
  test). Old code is indifferent to a constraint it never violated.

## The defer_foreign_keys finding

The migration deliberately does **not** use `PRAGMA defer_foreign_keys`
(the D1-documented pattern for schema changes that transiently violate
FKs). Two reasons:

1. It is unnecessary here: the parent table (`customers`) is untouched and
   the child copy inserts only existing-customer references (or NULL,
   which FKs permit) — nothing transiently violates anything.
2. It is actively dangerous in this shape: an empirical probe
   (node:sqlite's bundled SQLite) showed that setting
   `defer_foreign_keys = on` and then `= off` **before COMMIT silently
   clears the deferred-violation counter — the orphan row commits**.
   Leaving the pragma on until COMMIT does fail correctly, but the
   off-before-commit form (a natural "cleanup" instinct, and what the
   first draft of this migration did) is a trap. Immediate enforcement
   fails at the exact offending statement instead — stricter, clearer in
   CI logs, and engine-timing-independent.

The probe's one-line summary worth remembering: *deferred FK checks live
or die by what happens to the pragma before commit; immediate checks
don't.*

## Scope boundary

Only the drift repair — no new constraints. In particular:

- `contacts.company_id` / `evidence` references stay FK-less: their parent
  columns are not UNIQUE-keyed for constraint purposes, and Phase 3's
  table normalization (companies/people/facts) redesigns those tables
  anyway. Adding decorative FKs now would be churn Phase 3 immediately
  undoes (spec §35: no unmotivated refactors).
- `CHECK(enc:v1:)` on credential columns (audit P1, Remaining Risks #9)
  remains what it was — possible via this same rebuild pattern, worth
  doing only if the lazy-migration tolerance is ever retired. The pattern
  is now proven, which is what this stage contributes to that decision.

## Changes

- `migrations/0019_outreach_emails_fk_rebuild.sql` — the single-transaction
  rebuild (change record + directly executable by the CI step).
- `.github/workflows/deploy-worker.yml` — "Rebuild outreach_emails with FK
  (post-V2 Stage 34)" step: FK-presence gate → orphan gate → `--file`
  execution → FK + row-count verification. Ordered after the Stage 33
  `request_id` ALTER block (the rebuild's INSERT SELECT needs that
  column).
- `tests/fk-rebuild.test.ts` — 3 tests executing the real migration file
  against a legacy-shape database (original CREATE + historical ALTERs, so
  physical column order differs from the rebuilt table):
  1. rebuild preserves rows/indexes/AUTOINCREMENT sequence and the rebuilt
     table enforces the FK in both directions (orphan insert rejected,
     referenced-customer delete rejected, NULL still allowed);
  2. the file tolerates re-execution (no leftover temp table, data
     intact);
  3. an orphaned draft aborts the migration at the INSERT SELECT and the
     transaction rolls back completely (legacy table untouched, no
     `outreach_emails_new` leftover) — proving the CI orphan gate is a
     real defense line.

## Verification

- `npm test`: **682/682** (56 files; +3 vs Stage 33's 679/55).
- `tsc --noEmit`: clean.
- `wrangler deploy --dry-run`: 532.92 KiB / gzip 131.24 KiB (unchanged —
  migration, CI step and tests only; the worker bundle is untouched).
- `node scripts/check-panel.mjs`: 7 panels clean.
- Docs: final report (Stage 34 bullet, migration table, Remaining Risks #4
  resolved, deferred item struck, audit P1 CHECK note), deployment-v2.md
  (pipeline gate, migration-validation step, deployment notes).
