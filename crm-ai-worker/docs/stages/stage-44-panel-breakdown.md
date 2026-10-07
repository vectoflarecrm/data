# Stage 44 — panel breakdown reader (Phase 5)

Phase 5, second stage. Design: `docs/phase5-lead-score-v2.md` (§4.2, §6
Stage 44). The engine and the cache column landed in Stage 43; this stage
gives them their reader.

## Problem

Stage 43 wrote the six-dimension decomposition to
`customers.lead_score_breakdown` — but nobody read it. The detail view
showed the total ("65") and the completeness axis, with no way to see the
*why*: ICP fit 30, buying signal 15, reachability 0.

## Changes

| File | Change |
| --- | --- |
| `src/admin.ts` | `getCustomerLeadScoreBreakdown` (fail-open reader, `getCustomerCompleteness` pattern: separate SELECT, `no such column` → null); detail response gains `lead_score_breakdown` (raw JSON passthrough — the panel parses, the API does not interpret); panel `renderLeadScoreBreakdown` (🎯 线索评分维度 section: six labeled bars reusing the histogram's `s-bge2e8f0-br4-h8-ovh` track + `score-fill`/`data-w` widget, `sf-hi`/`sf-mid`/`sf-low`/`sf-none` fill by ratio ≥80/≥40/>0/0), wired after `buildModal` and before the signals section; `openDetail` sets the fill widths after `innerHTML` (the established histogram pattern) |
| `tests/lead-score-v2.test.ts` | +3 tests: column present → raw JSON beside the total; migration-pending (column missing) → null, `lead_score` unaffected; pre-stage row (breakdown NULL) → null |

## Semantics pinned

- **Fail-open, three ways** (§4.2): migration-pending database (column
  missing), pre-Stage-43 rows (NULL breakdown) and precheck-skipped rows
  (NULL by Stage 43's irrelevant path) all degrade identically — the
  section hides, the total and the completeness axis above it keep
  rendering. An invalid JSON string hides the section too (parse guarded,
  `version !== 'lead-score-v2'` guard).
- **The API serves raw JSON** — no server-side interpretation, no schema
  drift between engine and reader; the panel is the single consumer of the
  decomposition today.
- **Real CSS only**: the bars reuse the histogram's existing
  `score-fill`/`sf-*` classes; no new stylesheet entries, no reliance on
  the legacy mangled class strings.
- **Dimension maxes mirrored in the panel JS** (30/20/10/15/15/10): the
  panel is a static string, so the weights are duplicated there — same
  trade-off as the histogram's hardcoded bucket thresholds; the API's raw
  JSON keeps the server authoritative.
- **Consumers of the total stay untouched** (§7): list ordering, color
  coding, histogram buckets, campaign `min_lead_score` — all still read the
  integer column.

## Verification

- `tests/lead-score-v2.test.ts` now 16: the 3 new detail tests cover the
  full fail-open matrix; `tests/score-separation.test.ts` untouched and
  green (its bare fixture has no `lead_score_breakdown` column — the new
  reader fails open, its assertions unchanged).
- Full suite **820/820 (66 files)** — 817 prior + 3 new, zero edits to
  existing assertions.
- `tsc --noEmit` clean.
- `wrangler deploy --dry-run`: 570.46 KiB / gzip 139.43 KiB (was
  568.25 / 138.74).

## Next

Phase 5 shipped in full (§6: stages 43–44 done). Follow-ups stay gated on
their design triggers: the `lead_scores` per-run history table (§3.3 —
score-trend view or dimension-level campaign targeting wanting history),
per-dimension campaign filters over `json_extract` (Phase 6 targeting
material), contact merge (phase4 §4.4), cache-column deprecation
(phase4 §3.4).
