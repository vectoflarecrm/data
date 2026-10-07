# Stage 47 — Contact merge, part 1: write-time dedup planner

**Phase 7** · docs/phase7-contact-merge.md §2/§3/§4 · phase4 §4.4 deferred
Commit: `phase7: stage 47 - write-time contact merge`

## What

Stop MAKING new duplicate contacts. The old Step 5 (index.ts) only skipped
exact-fingerprint repeats, so the same person found again with a NEW
channel (an email added, a phone found later) landed as a second row —
phase4's documented gap. The new planner keeps the skip verbatim and adds
a deliberately conservative same-person rule (design §2):

- **same channel identity** — normalized email, cellphone or whatsapp
  (trim + lowercase; phones also strip separators, the Stage 42 linkage's
  exact semantics) — **AND compatible names** (equal, or at least one side
  unnamed)
- → **merge**: one `UPDATE … SET field = COALESCE(field, ?) …` — SQL
  itself enforces fill-NULL-only, nothing non-null is ever overwritten
- channel match with CONFLICTING names (a shared `info@` mailbox can front
  two people) and name-only matches never merge automatically — those stay
  for Stage 48's manual merge.

## Files

- `src/contact-merge.ts` (new, leaf module — imports nothing from
  admin/index, same rationale as lead-score-dims): normalization helpers,
  the pure planner `planContactPersist` and the `{sql, binds}` statement
  list. In-memory view stays current after every merge (later contacts
  match the enriched row); a merge into a row the SAME batch will insert
  folds into that INSERT's values (no UPDATE against a missing row);
  existing rows win over provisional ones when both match (stable
  identity). Admission guard and fingerprint are byte-identical to the old
  code.
- `src/index.ts` — Step 5 now loads the company's existing rows (full
  merge-relevant columns), calls the planner, executes one batch. The
  INSERT column list (incl. `source → department`) and the
  `<display_id>_<seq pad3>` contact_id pattern are unchanged.
- `tests/contact-merge.test.ts` (new) — 15 tests.

## Semantics pinned

- Exact-fingerprint skip is untouched (retry-safety); a re-run that finds
  the same person with the same five fields still produces zero statements.
- Provisional rows number after the company's `MAX(seq)`; the freed-seq
  question does not arise here (Stage 47 never deletes).
- Complementary channels with NO shared value (email-only + phone-only,
  same name) are name-only matches → separate rows by design (§2).
- No schema change, no migration, no CI step; one batch, one AI call — the
  pipeline's shape is unchanged.

## Evidence

- `vitest run` → **858 passed / 858 (68 files)**, was 843/67; +15 in
  tests/contact-merge.test.ts (normalizePhone parity; skip semantics;
  merge by email/cellphone/whatsapp; conflicting-name and name-only
  refusals; in-memory enrichment; in-batch folding; existing-over-
  provisional determinism; seq numbering; SQL-level COALESCE proof on
  node:sqlite incl. sequential-merge accumulation).
- `tsc --noEmit` → 0 errors.
- `wrangler deploy --dry-run` → Total Upload 577.04 KiB / gzip 141.25 KiB
  (was 573.55/140.32).

## Not done here (deliberate)

- Manual merge endpoint + panel UI (fixing EXISTING duplicates) →
  Stage 48.
- Automatic backfill of existing dups — out of scope per design §5
  (merging is an operator judgement call).
