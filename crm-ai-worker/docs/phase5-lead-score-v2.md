# Phase 5 — Lead Score V2: design

Status: design committed — stages 43/44 pending.

Source requirements: 建议.txt §十八 (the six-dimension lead score), signed by
the operator as the Phase 5 direction after Phases 1–4 shipped in full.

## 1. What §十八 asks for

```
lead_score
├── ICP fit
├── product fit
├── buyer role
├── buying signal
├── reachability
└── strategic value
```

The OTHER half of §十八 — `data_quality_score` (identity/domain/contacts/
email/social/evidence/freshness) — already shipped as Security V2 Stage 15's
`computeCompletenessScore` (10 × 10 points, `score-separation.test.ts`). What
remains is the lead half: today `computeLeadScore` (index.ts:2004) flattens
nine hardcoded rules into one opaque 0–100 number with no recorded
decomposition. Phase 5 makes the six dimensions first-class: same total
contract, inspectable parts.

## 2. Current state (HEAD 9b59d1e)

| §十八 dimension | V1 proxy rules (computeLeadScore) | Max |
| --- | --- | --- |
| ICP fit | segment tiering distributor/dealer/oem/wholesaler/e-commerce/retailer/user | 30 |
| product fit | product_categories non-信息不足 → flat | 20 |
| buyer role | any named contact → flat | 10 |
| buying signal | buying_signals.length > 0 → flat | 10 |
| reachability | email → 20, else any contact → 10 | 20 |
| strategic value | company_size +5, geographic_coverage +5 | 10 |

Consumers of the total (all keep working unchanged): campaigns
`min_lead_score` filter + `ORDER BY lead_score DESC NULLS LAST`
(campaigns.ts:169/321/481), admin list column + histogram buckets
s80/s60/s40/s0 (admin.ts:1088/2483), panel color coding, the irrelevant path
writing `lead_score = 0` (index.ts:2265). No consumer reads a decomposition
today because none exists.

Existing pinned behavior (score-separation.test.ts, must stay green):
`不相关` → 0; fit-only record (distributor + products + 1 signal, nothing
else) → lead ≥ 60 while completeness = 30; evidence rows never move the lead
score.

## 3. Pinned principles

1. **Deterministic, zero extra cost.** The engine is pure over the
   `CustomerAnalysis` object that already sits in memory at scoring time
   (index.ts:2281) — no AI calls, no DB reads, no async. Same discipline as
   V1/Stage 15.
2. **The total contract is frozen.** `customers.lead_score` stays INTEGER
   0–100; `computeLeadScore(a): number` keeps its signature and returns the
   V2 total. Campaigns, histogram, list ordering, color coding: untouched.
3. **The decomposition is a cache column, not a new table.** Scores are
   100 % derivable from the run's stored layers (signals/personas/facts are
   already versioned per run since Phase 4); a `lead_scores` history table
   (建议 §十三's future shape) would duplicate derivable state. The
   breakdown rides the same UPDATE as the total — one writer, no drift
   window. Deferred with trigger: per-run score history, when a score-trend
   view or dimension-level campaign filters actually want history.
4. **No backfill.** Old rows keep their V1 total with a NULL breakdown; the
   panel degrades to total-only display. Rows pick up the breakdown from the
   next research run, exactly like Phase 4 layers accumulated.
5. **Completeness axis untouched.** §十八's data_quality half stays Stage
   15's formula; V2 changes only the lead half.
6. **No prompt change.** The research AI call's JSON contract is stable; V2
   reads fields the analysis already returns.

## 4. Target model — six dimensions, weights summing to 100

Engine: `computeLeadScoreV2(a: CustomerAnalysis): LeadScoreBreakdown` in
index.ts beside V1 (same home as every scoring function since Stage 15;
`computeLeadScore` delegates to it for the total).

| Dimension | Key | Max | Rule (deterministic, tiered like V1) |
| --- | --- | --- | --- |
| ICP fit | `icp_fit` | 30 | segment contains distributor → 30; dealer/oem/wholesaler → 25; e-commerce → 15; retailer → 10; user/service → 5; else 0 |
| product fit | `product_fit` | 20 | product_categories non-empty and not 信息不足 → 20; else 0 |
| buyer role | `buyer_role` | 10 | ≥1 contact with first_name/last_name → 10; else ≥1 persona with a role → 5; else 0 |
| buying signal | `buying_signal` | 15 | buying_signals.length ≥ 1 → 15; else 0 |
| reachability | `reachability` | 15 | any contact email → 15; else cellphone/whatsapp → 8; else any contact → 4; else 0 |
| strategic value | `strategic_value` | 10 | company_size non-信息不足 → +5; geographic_coverage non-信息不足 → +5 |

`不相关` short-circuit: segment contains 不相关 → all six 0, total 0
(the V1 rule, preserved verbatim). Total = `min(100, sum)` (sum of maxes is
exactly 100; the clamp is belt-and-braces).

Cross-check against pinned tests: fit-only record → 30+20+15 = 65 ≥ 60 ✓;
irrelevant → 0 ✓; evidence is not an input ✓. Full-fit distributor (V1 = 100)
maps to 30+20+10+15+15+10 = 100 ✓ — the top of the scale is unchanged.

### 4.1 Storage — `customers.lead_score_breakdown`

```
lead_score_breakdown TEXT      -- NULL or json_valid; latest-snapshot cache
```

JSON shape (written by the engine, fixed shape, < 200 chars — no writer cap
needed, unlike admin-editable JSON columns):

```json
{ "version": "lead-score-v2", "icp_fit": 30, "product_fit": 20,
  "buyer_role": 10, "buying_signal": 15, "reachability": 15,
  "strategic_value": 10 }
```

No `total` inside the JSON — `lead_score` stays the single writer of the
total (one source per fact, Stage 42 twin discipline). Dual-write: the
completed-path UPDATE binds breakdown JSON next to the total (index.ts:2407);
the irrelevant path sets `lead_score = 0, lead_score_breakdown = NULL`
(index.ts:2265). Future per-dimension SQL (Phase 6 targeting) reads it via
`json_extract(lead_score_breakdown, '$.reachability')` — D1 ships json1.

### 4.2 Reader — admin detail, fail-open

`getCustomerLeadScoreBreakdown(env, id)` mirrors `getCustomerCompleteness`
(admin.ts:2437): separate SELECT, try/catch → null on migration-pending
databases (the score-separation bare-fixture test pattern). Detail response
gains `lead_score_breakdown`; the panel renders six labeled bars
(ICP 契合 30 / 产品匹配 20 / 决策人 10 / 采购信号 15 / 可触达 15 / 战略价值 10)
next to the existing score axes, hidden when null.

## 5. Migration strategy

Additive, Stage 42 pattern: schema.sql CREATE gains the column (plain TEXT,
JSON guarded writer-side like every engine-written JSON column); CI ALTER
step "Migrate customers lead_score_breakdown (Phase 5 Stage 43)" after the
Stage 42 step and before Typecheck (single ALTER, duplicate-column
tolerance, pragma verify); `migrations/0026_lead_score_breakdown.sql` change
record. The CI step precedes the new worker version — the same guarantee
Stage 15 relied on for `data_completeness_score`.

## 6. Staged plan

**Stage 43 — V2 engine + breakdown storage.** `computeLeadScoreV2` +
`LeadScoreBreakdown` type in index.ts; `computeLeadScore` delegates (total);
schema column + CI ALTER + 0026 record; both processCustomer UPDATEs wired;
new tests/lead-score-v2.test.ts (weight sum 100, 不相关 zeroing, per-dimension
tiering, independence, fit-only compat); score-separation stays green
untouched.

**Stage 44 — panel reader.** Detail API `lead_score_breakdown` (fail-open
reader); panel detail renders the six bars (weights shown, NULL → section
hidden); tests for present/absent-column detail responses.

Each stage: full suite green, `tsc` clean, dry-run size recorded, stage
report in `docs/stages/`, commit `phase5: stage NN - ...`.

## 7. Explicitly not in Phase 5

- No per-run score history table (§3.3 trigger: score-trend view or
  dimension-level targeting wanting history).
- No campaign/consumer changes — `min_lead_score` keeps meaning the V2 total.
- No completeness-formula change (§十八's data half is Stage 15's, done).
- No research-prompt or AI-contract change (§3.6).
- No V1 rewrite/backfill of existing rows (§3.4).
