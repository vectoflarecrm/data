# Stage 45 — Campaign targeting: `has_buying_signal` + `dimension_floors` (engine)

**Phase 6** · docs/phase6-campaign-targeting.md §2/§3/§4 · 建议 §十八/§二十一
Commit: `phase6: stage 45 - campaign targeting engine`

## What

Two additive targeting dimensions on the frozen Phase 5 contract, both
**default OFF** so every stored filter payload and every existing screen
behaves byte-identically until an operator opts in:

1. **`has_buying_signal`** (§2.1) — only companies whose CURRENT research
   run produced buying signals: `EXISTS (SELECT 1 FROM research_signals rs
   WHERE rs.customer_id = <outer> AND rs.is_current = 1)`.
2. **`dimension_floors`** (§2.2) — per-dimension minimums over the six
   Phase 5 dimensions: `COALESCE(CAST(json_extract(<t>lead_score_breakdown,
   '$.<dim>') AS INTEGER), 0) >= ?` per dimension, emitted in the pinned
   `LEAD_SCORE_DIMENSIONS` order (deterministic SQL shape).

## Files

- `src/lead-score-dims.ts` (new, leaf module) — `LEAD_SCORE_DIMENSIONS`
  (ordered tuple), `LeadScoreDimension`, `LEAD_SCORE_WEIGHTS`. Extracted
  from index.ts: campaigns.ts needs the weights to validate floors but
  cannot import the worker entry (`index → admin → campaigns` cycle).
- `src/index.ts` — imports the weights from the leaf module for the engine
  and re-exports `LEAD_SCORE_WEIGHTS`; tests/lead-score-v2.test.ts keeps
  importing from index unchanged.
- `src/campaigns.ts` — `SegmentFilters.hasBuyingSignal`/`.dimensionFloors`
  (+ `EMPTY_FILTERS`), `sanitizeDimensionFloors` (unknown key = typo →
  rejected; integer 0..weight per dimension, zero floors dropped;
  `dimension_floors 必须是 JSON 对象` otherwise), parse/serialize in the
  snake_case wire shape, `buildSegmentWhere` extensions.
- `src/admin.ts` — pre-filter (`/admin/api/customers/pre-filter`) accepts
  `has_buying_signal=1`; floors stay campaign-side (§4).
- `tests/campaign-targeting.test.ts` (new) — 22 tests.

## The correlation trap (why the outer reference is hand-qualified)

Inside the EXISTS an unqualified `customer_id` resolves to the **inner**
research_signals column — `rs.customer_id = rs.customer_id` is always true,
so every company would match as soon as ANY signal row existed anywhere in
the table. The builder therefore emits `customers.company_id` in bare mode
(no alias to shadow it) and `c.company_id` under an alias (SQLite forbids
the original name once aliased). Both forms are unit-pinned and SQL-proven
(a signal-less company must not leak in — the regression test).

## Semantics pinned

- Truthy parse for `has_buying_signal` matches `has_email`/`exclude_sent`
  (`true`/`1`/`"1"` on; `false`/`0`/absent off, default **false**).
- A floor asserts knowledge: NULL breakdown (pre-Stage-43 rows, precheck
  skips) and dimensions missing from the stored JSON both read as 0, so any
  positive floor excludes unscored rows — never silently passes them.
- Legacy stored JSON (pre-Phase-6 shape) parses to both dimensions OFF.
- `createGroup`/campaign create/preview/groups inherit the new fields
  automatically through parse/serialize (shared code path, no per-endpoint
  wiring).
- No schema change: reads existing `research_signals` +
  `customers.lead_score_breakdown` (Phase 5 Stage 43). No CI migration.

## Evidence

- `vitest run` → **842 passed / 842 (67 files)**, was 820/66; +22 in
  tests/campaign-targeting.test.ts (parse defaults/truthy, floor validation,
  round-trip + legacy JSON, builder bare/aliased forms, pinned order,
  SQL-level proofs: current-vs-superseded, cross-company correlation
  regression, NULL/dim-less breakdown floors, signal ∧ floor intersection,
  previewSegment end-to-end via FakeD1).
- `tsc --noEmit` → 0 errors.
- `wrangler deploy --dry-run` → Total Upload 572.52 KiB / gzip 140.06 KiB
  (was 570.46/139.43).

## Not done here (deliberate)

- Panel UI (海选 checkbox, campaign-form signal checkbox + ICP 门槛 select)
  → Stage 46.
- Per-dimension UI beyond ICP fit; signal-text search; signal counts;
  outreach prompt changes — out of scope per design §6.
