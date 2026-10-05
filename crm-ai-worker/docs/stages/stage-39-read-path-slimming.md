# Stage 39 — read-path slimming (Phase 3b)

Phase 3b, first and only scheduled stage. Design review:
`docs/phase3b-normalization-review.md` (operator-signed 2026-10-06).

## Problem

Every list, pre-filter sample and PATCH-RETURNING query shipped all 58
`customers` columns per row — including the deprecated
`full_research_text` blob (up to 50 000 chars) and ten columns no code
path has ever written (the embedded person block minus email/cellphone,
plus `social_accounts`). A 50-row list page could ship megabytes of
frozen blobs while the panel list renders 10 fields
(`admin.ts:3425`). The review's §4 verdicts rejected the physical table
splits as unmotivated; §5 scoped this stage as the one real fix.

## Changes

| File | Change |
| --- | --- |
| `src/admin.ts` | new `CUSTOMER_LIST_COLUMNS` (drops `full_research_text` + 10 dead columns; keeps `email`/`cellphone` for the list row fallback) used by `listCustomers` and the pre-filter sample; `CUSTOMER_COLUMNS` (full set) unchanged for the detail view and `updateCustomer` RETURNING |
| `schema.sql` | deprecation comments on the person block and `social_accounts` (same treatment the blob got in Stage 38: no new writers, no DROP without a forcing migration) |
| `tests/admin-list-shape.test.ts` | new, 3 tests |
| `docs/phase3b-normalization-review.md` | Status → signed off + implemented; checklist resolved |

## Semantics pinned

- **Detail response shape is the panel contract and does not change** —
  the modal renders every field, and the blob remains the Stage 38
  fallback source for `readSavedResearchText`. Only list/sample
  responses slim down.
- **List keeps `cellphone`**: never written, but the panel row falls back
  to it next to `email` (`c.email || c.cellphone`) — dropping it would
  change panel code for zero gain.
- **Dead columns are deprecated, not dropped**: SQLite DROP COLUMN
  rebuilds the table; out of the read paths they cost nothing.
- **No schema/data migration**: schema.sql comments only (additive, runs
  idempotently on every deploy).

## Verification

- `tests/admin-list-shape.test.ts` (3): list items exclude blob + dead
  columns and keep live fields; pre-filter sample same; detail keeps the
  full shape with the blob fallback intact.
- Full suite **748/748 (61 files)** — 745 prior + 3 new, zero edits to
  existing tests.
- `tsc --noEmit` clean.
- `wrangler deploy --dry-run`: 550.47 KiB / gzip 135.04 KiB (was
  549.77 / 134.99).

## Next

Phase 3b is complete per the signed review: no further split stages are
scheduled. Open item (decided at Phase 4 design time): whether per-run /
per-brand profile versioning pulls `outreach_profiles` forward.
