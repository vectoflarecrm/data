# Stage 43 — Lead Score V2 engine + breakdown storage (Phase 5)

Phase 5, first stage. Design: `docs/phase5-lead-score-v2.md` (§3, §4, §5, §6
Stage 43). Operator-signed direction: 建议.txt §十八's six-dimension lead
score, after Phases 1–4 shipped in full.

## Problem

`computeLeadScore` (index.ts) flattened nine hardcoded rules into one opaque
0–100 number: the panel could show "75" but not *why* — no ICP fit, no
reachability, nothing a human could inspect or a future campaign could
filter on. §十八's other half (data quality dimensions) already shipped as
Stage 15's completeness axis; the lead half had no decomposition at all.

## Changes

| File | Change |
| --- | --- |
| `src/index.ts` | `LeadScoreBreakdown` interface + `LEAD_SCORE_WEIGHTS` (30/20/10/15/15/10, sum exactly 100) + `computeLeadScoreV2` — six deterministic dimensions, pure over the analysis object (no AI calls, no DB reads); `computeLeadScore` keeps its signature and returns the dimension sum (total contract frozen); completed-path UPDATE dual-writes `lead_score_breakdown` JSON beside the total; irrelevant path writes `lead_score = 0, lead_score_breakdown = NULL`; export-block comment lists `tests/lead-score-v2.test.ts` |
| `schema.sql` | `customers` CREATE gains `lead_score_breakdown TEXT` (fresh installs) with the §十八 comment |
| `migrations/0026_lead_score_breakdown.sql` | change record: cache-not-history rationale (§3.3 — scores derive from already-versioned layers; the `lead_scores` history table stays deferred with its trigger), write paths, no-backfill semantics |
| `.github/workflows/deploy-worker.yml` | new CI step "Migrate customers lead_score_breakdown (Phase 5 Stage 43)" — single duplicate-column-tolerant ALTER + pragma verification, after the Stage 42 step, before Typecheck (the Stage 15 guarantee: the column exists before the new worker version) |
| `tests/lead-score-v2.test.ts` | new, 13 tests |

## Dimension rules (§4 table, now code)

| Dimension | Key | Max | Rule |
| --- | --- | --- | --- |
| ICP fit | `icp_fit` | 30 | distributor 30 / dealer·oem·wholesaler 25 / e-commerce 15 / retailer 10 / user·service 5 / else 0 |
| product fit | `product_fit` | 20 | categories non-empty, non-信息不足 |
| buyer role | `buyer_role` | 10 | named contact 10 / else role-bearing persona 5 / else 0 |
| buying signal | `buying_signal` | 15 | any signal |
| reachability | `reachability` | 15 | email 15 / else phone·WhatsApp 8 / else bare contact 4 / else 0 |
| strategic value | `strategic_value` | 10 | size +5, geographic +5 |

## Semantics pinned

- **The total contract is frozen** (§3.2): `customers.lead_score` stays
  INTEGER 0–100; campaigns `min_lead_score`, the histogram buckets, list
  ordering and panel color coding read the same column with the same
  meaning. `computeLeadScore(a): number` is unchanged signature-wise and
  now returns the V2 dimension sum (clamp kept belt-and-braces).
- **No total inside the JSON** (§4.1): one writer per fact — the integer
  column is the total's only home, the JSON carries the decomposition.
  Both are bound in the same UPDATE, so no drift window exists.
- **Cache column, not a history table** (§3.3): scores are 100 % derivable
  from layers already versioned per run (signals/personas/facts since
  Phase 4); 建议 §十三's `lead_scores` table stays deferred with its
  trigger (score-trend view or dimension-level targeting wanting history).
- **No backfill** (§3.4): pre-stage rows keep their V1 total with a NULL
  breakdown; the panel will degrade to total-only display (Stage 44).
  Breakdowns accumulate from the next research run, the Stage 37
  precedent.
- **不相关 short-circuit preserved verbatim**: every dimension zero, total
  0 — the precheck path also NULLs the breakdown (a precheck verdict has
  no dimensions).
- **Completeness axis untouched** (§3.5): `computeCompletenessScore` and
  its ten §16.2 dimensions are byte-identical; evidence rows remain a
  completeness input the lead dimensions never read (pinned by test).
- **Plain TEXT, no table CHECK**: SQLite never retro-applies CREATE
  constraints to ALTERed-in columns, and the only writer is the
  engine — JSON validity is structural (fixed shape, < 200 chars, no
  admin-editable path).

## Verification

- `tests/lead-score-v2.test.ts` (13): weight sum 100 + exact weight map;
  不相关 zeroing; per-dimension tiering (9 ICP tiers, 信息不足-as-absence
  for product/strategic, named-contact-beats-role-persona, email > phone
  > bare contact, signal presence); total = dimension sum; full-fit
  distributor = 100 with every dimension at max; the score-separation
  fit-only compat record = 65 ≥ 60; JSON shape (7 keys, version
  `lead-score-v2`, no total); evidence rows move nothing.
- `tests/score-separation.test.ts` untouched and green — the V1 separation
  semantics survive the engine swap (irrelevant → 0; fit-only ≥ 60;
  high-lead/low-completeness and the mirror; no auto-overwrite either
  direction).
- Full suite **817/817 (66 files)** — 804 prior + 13 new, zero edits to
  existing assertions.
- `tsc --noEmit` clean.
- `wrangler deploy --dry-run`: 568.25 KiB / gzip 138.74 KiB (was
  566.92 / 138.37).

## Next

Stage 44 (design §6): the reader — `getCustomerLeadScoreBreakdown`
fail-open detail reader + panel six-bar rendering (weights shown, NULL →
section hidden) + detail-API tests. Consumers of the total stay untouched
by design (§7).
