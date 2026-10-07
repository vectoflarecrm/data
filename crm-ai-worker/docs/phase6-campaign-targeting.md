# Phase 6 — Campaign targeting over the intelligence layers: design

Status: shipped in full — stages 45/46 done (targeting engine + panel wiring;
no schema change; both dimensions default OFF, so existing payloads behave
identically until an operator opts in).

Source requirements: the Phase 4 stage reports' deferred follow-up ("campaign
targeting over research_signals"), 建议.txt §二十一's layer pipeline (the
signal/persona/score layers exist so downstream consumers can act on them),
and the Phase 5 reports' "per-dimension campaign filters over json_extract
(Phase 6 targeting material)".

## 1. What exists (HEAD 5324656)

The targeting pipeline is a three-entry-point funnel over ONE shared SQL
builder (`buildSegmentWhere`, campaigns.ts:133):

```
/admin pre-filter (海选)  ── query params → parseSegmentFilters ─┐
campaign preview          ── JSON body  → parseSegmentFilters ───┼→ buildSegmentWhere → SQL
campaign create (members) ── JSON body  → parseSegmentFilters ──┘   (snapshot ids at create)
```

Current filter dimensions: countries / segments / products / keywords /
`min_lead_score` / `has_email` / `exclude_sent` / `customer_ids`. Stored as
JSON on `outreach_groups.filters` and `outreach_campaigns.filters`
(serialize/deserialize round-trip; corrupt JSON fails open to EMPTY).

What the intelligence layers added and no campaign surface consumes yet:
`research_signals` (Stage 40 — current buying signals per company) and
`customers.lead_score_breakdown` (Stage 43 — six-dimension decomposition).

## 2. Target model — two new filter dimensions

### 2.1 `has_buying_signal` (default false)

```
EXISTS (SELECT 1 FROM research_signals rs
        WHERE rs.customer_id = <outer>.company_id AND rs.is_current = 1)
```

"Only companies whose CURRENT research run produced buying signals."
`is_current = 1` matches the panel reader's semantics — superseded signal
history never counts. Wire shape: `has_buying_signal` truthy-style like
`has_email` (absent → false, `false`/`0` → false, else true).

**The correlation trap, pinned**: `buildSegmentWhere` runs in two modes —
bare (`FROM customers`, pre-filter) and aliased (`FROM customers c`,
preview/create). Inside the EXISTS, an unqualified `customer_id` resolves to
the INNER table (`research_signals.customer_id`), making the predicate
`rs.customer_id = rs.customer_id` — always true, matching any company as
soon as ANY signal row exists. The outer reference must be explicitly
qualified: `customers.company_id` when bare (the original table name is
valid because there is no alias), `c.company_id` when aliased (SQLite
forbids the original name once aliased). Both forms are regression-tested.

### 2.2 `dimension_floors` (default {})

```
COALESCE(CAST(json_extract(<t>lead_score_breakdown, '$.<dim>') AS INTEGER), 0) >= ?
```

Per-dimension minimums over the six Phase 5 dimensions — e.g.
`{"icp_fit": 25}` = "only dealer/OEM/wholesaler tier or better";
`{"reachability": 15}` = "only email-reachable" (a stricter, scored cousin
of `has_email`). Wire shape: one JSON object; keys validated against the six
known dimensions (unknown keys rejected — typo protection), values integer
0..dimension max (the Phase 5 weights), zero values dropped (no-op).
Emitted in the pinned dimension order so the SQL shape is deterministic.

**Unknown ≠ pass**: `COALESCE(..., 0)` reads a NULL breakdown (pre-Stage-43
rows, precheck skips) as 0 — a floor asserts knowledge, so unscored rows
are excluded whenever a floor is set. Pinned deliberately; no silent
fallthrough to the total.

Both filters are OFF by default: every stored group/campaign and every
existing test keeps its exact current behavior.

## 3. Pinned principles

1. **One builder, three entry points** (existing architecture): the filters
   land in `SegmentFilters` + `buildSegmentWhere`, so pre-filter, preview,
   create-campaign, group save and group reuse inherit them without
   per-endpoint SQL. No second WHERE builder may appear.
2. **Snapshot semantics unchanged**: createCampaign still snapshots matched
   ids into members; the stored filters JSON is display/replay material.
3. **Weights have one server-side home**: `LEAD_SCORE_WEIGHTS` moves to a
   leaf module (`src/lead-score-dims.ts`) because campaigns.ts cannot
   import the worker entry (index → admin → campaigns would cycle);
   index.ts re-exports it so existing imports (tests, engine) are
   untouched. The panel keeps its documented JS mirror (Stage 44 trade-off).
4. **No schema change**: both filters read existing tables/columns
   (`research_signals` since Stage 40, `lead_score_breakdown` since
   Stage 43). The CI schema step already guarantees both before any worker
   that can emit the new SQL. Bare fixtures that never set the new filters
   never generate the new SQL.
5. **Old stored JSON keeps working**: deserialize of a pre-Phase-6 filters
   JSON yields the new defaults (`hasBuyingSignal: false`,
   `dimensionFloors: {}`).
6. **Out of scope**: persona-targeted per-person campaigns (the phase4
   §4.4 contact-merge trigger stays armed), signal-text search, signal
   counts (boolean is the honest first cut), outreach prompt changes
   (persona-aware since Stage 41), per-dimension UI beyond ICP fit.

## 4. API surfaces

| Surface | Gains | How |
| --- | --- | --- |
| `POST /admin/api/.../campaigns` + preview + groups | `has_buying_signal`, `dimension_floors` | JSON body → parseSegmentFilters (automatic) |
| `GET /admin/api/customers/pre-filter` | `has_buying_signal=1` | query param passthrough (floors stay campaign-side precision) |
| Panel pre-filter form (Stage 46) | 仅含采购信号 checkbox | pfParams |
| Panel campaign form (Stage 46) | signal checkbox + ICP 门槛 select (不限/≥25/≥30 → `dimension_floors.icp_fit`) | cgParams; the API accepts all six, the UI exposes what has a workflow today |

## 5. Staged plan

**Stage 45 — filters + builder.** `src/lead-score-dims.ts` (dims, weights,
dimension type; index.ts imports/re-exports — tests untouched);
`SegmentFilters.hasBuyingSignal` + `dimensionFloors` + parse (validation,
error style matching `min_lead_score`)/serialize/builder changes
(correlation-safe EXISTS, COALESCE floors); pre-filter `has_buying_signal=1`
param; `tests/campaign-targeting.test.ts`: parse/round-trip/old-JSON units,
builder shape (bare + aliased), and SQL-level proofs on node:sqlite
(current-vs-superseded signals, cross-company correlation — the shadowing
regression, floor matches/excludes/NULL-breakdown, previewSegment chain).

**Stage 46 — panel + endpoint tests.** Pre-filter form checkbox; campaign
form checkbox + ICP select; pre-filter endpoint test through
`handleAdminRequest` (has_buying_signal narrows the count; absent param =
old behavior); stage report + phase status.

Each stage: full suite green, `tsc` clean, dry-run size recorded, stage
report in `docs/stages/`, commit `phase6: stage NN - ...`.
