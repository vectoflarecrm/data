# Phase 10 — Lead-score weight configuration

Status: in progress (design signed off 2026-10-10: rescore sweep included,
RBAC super_admin + operator; Stage 55 shipped, Stages 56–57 remaining)

## 0. Trigger

The original audit's only still-open item (建议 §十八, tracked in
docs/security-v2-final-report.md appendix): "P2 hardcoded lead-score rules
— partially implemented; making weights configurable deferred". Stage 15
separated `lead_score` from `completeness_score`; Stage 43/44 (Phase 5)
froze the V2 six-dimension decomposition with hardcoded weights
(30/20/10/15/15/10). As brands and product lines grow, retuning the
weighting should not require a code deploy.

## 1. Scope summary

| Item | Mechanism | Stage |
| --- | --- | --- |
| Config store | migration 0029: single-row `lead_score_config` table, weights JSON | 55 |
| Config API | GET/PUT `/admin/api/lead-score/config`, validation, RBAC, audit | 55 |
| Engine consumes config | `computeLeadScoreV2(a, weights?)` — tier RATIOS × weight; defaults reproduce current scores exactly | 56 |
| Consumers follow | research pipeline loads config per tick (fail-open); campaigns.ts floor clamp uses effective weights | 56 |
| Panel editor + rescore | weights editor in /admin; breakdown renderer uses served weights (kills the Stage 44 JS mirror); chunked re-score sweep | 57 |

Out of scope: completeness-score weights (a separate quality axis, not a
targeting signal — stays deterministic code), per-brand weight profiles
(single global profile), AI-suggested weights.

## 2. Config store + API (Stage 55)

Migration `0029_lead_score_config.sql` (idempotent, schema.sql updated):

```sql
CREATE TABLE IF NOT EXISTS lead_score_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  weights_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
```

Single row by CHECK — the config is one global profile; `id=1` is the
enforced invariant, not a convention.

`src/lead-score-config.ts`:

- `parseLeadScoreWeights(raw: unknown): { ok: true, weights } | { ok: false,
  error }` — exactly the six dimension keys, each an integer 0–100, **sum
  exactly 100** (the pinned §4 invariant; keeps the frozen 0–100 total
  contract). Anything else → `{ ok: false, error }` → 400 carrying the
  reason. No partial application, no silent clamping.
- `loadLeadScoreConfig(env)` / `loadLeadScoreWeights(env)` — SELECT the
  row; missing table, missing row, corrupt or hand-edited-invalid stored
  JSON → `LEAD_SCORE_WEIGHTS` (fail-open, the migration-pending pattern
  used everywhere; a scoring outage must never block research — the
  non-migration failures log via safeLog).
- `saveLeadScoreWeights(env, weights, updatedBy)` — INSERT … ON
  CONFLICT(id) DO UPDATE, single row; fail-loud on a missing table (a
  config write that pretended to save would be a lie).

API (admin.ts `handleAdminApi`):

- `GET /admin/api/lead-score/config` → `{ weights, defaults, updated_at }`
  (effective config, always answerable even pre-migration).
- `PUT /admin/api/lead-score/config` → validate → save → audit
  `UPDATE_SCORE_CONFIG` (old→new weights in metadata, actor + request_id).

RBAC: new permission `scores.write`; granted to **super_admin and
operator** (weight tuning is business/research semantics, not credential
management — matches the operator role's customers/research/campaigns
scope). Read side: `customers.read` (the score already shows under it).
`requiredPermission` maps `/admin/api/lead-score/*` GET→customers.read,
PUT→scores.write.

## 3. Engine: tier ratios × weight (Stage 56)

Today's tiers are absolute values that are exact fractions of the default
weights: icp_fit 25 = 25/30·30, e-commerce 15 = 15/30·30, retailer 10,
user/service 5; buyer_role role-persona 5 = ½·10; reachability phone 8 =
8/15·15, bare 4; strategic 5+5 = ½+½ of 10. The engine is refactored to
compute `Math.round(ratio × weight)` with ratios fixed in code:

```
icp_fit:         distributor 1.0 | dealer/oem/wholesaler 5/6 | e-commerce 1/2 | retailer 1/3 | user/service 1/6 | else 0
product_fit:     real categories 1.0 | 信息不足/empty 0
buyer_role:      named contact 1.0 | role-only persona 1/2 | 0
buying_signal:   any signal 1.0 | 0
reachability:    email 1.0 | cellphone/whatsapp 8/15 | bare contact 4/15 | 0
strategic_value: size 1/2 + coverage 1/2 (信息不足 = absence)
```

With the default weights every output is **byte-identical to today**
(all ratios resolve to the current integers) — the entire
lead-score-v2.test.ts golden suite passes unchanged; custom-weight tests
are additive. `不相关` keeps its zero-everything short-circuit; the total
stays the frozen 0–100 dimension sum.

Signature: `computeLeadScoreV2(a: CustomerAnalysis, weights = LEAD_SCORE_WEIGHTS)`.
Callers:

- Research pipeline (`processCustomer`): the scheduled tick loads the
  config once and passes it through (one fail-open SELECT per tick, not
  per customer).
- `campaigns.ts` dimension-floor validation (`const max =
  LEAD_SCORE_WEIGHTS[dim]`): floors are compared against stored breakdown
  values, so the clamp must use the **effective** weights, loaded with
  the same fail-open helper at segment build time.

## 4. Panel + re-score sweep (Stage 57)

- **Weights editor** in `/admin` beside the score distribution card: six
  number inputs + live "合计" readout, save disabled unless the sum is
  exactly 100; shows defaults and last-updated; PUT → toast + audit.
- **Breakdown renderer de-mirrored**: `renderLeadScoreBreakdown`'s
  hardcoded `[30,20,10,15,15,10]` becomes weights fetched from the config
  endpoint (fetched once per panel load; fail-open to defaults). This
  closes Stage 44's documented JS-mirror tech debt.
- **Re-score sweep** `POST /admin/api/lead-score/rescore` (scores.write):
  after a weight change, stored `lead_score`/`lead_score_breakdown` rows
  are stale — the histogram and dimension floors would otherwise mix
  weight generations. The sweep recomputes from **stored** inputs
  (customer_segment, product_categories, company_size,
  geographic_coverage, personas_and_solutions, buying_signals columns +
  the live contacts table), chunked like every batch path, updating
  `lead_score` + `lead_score_breakdown` per row. Scope: rows with a
  completed analysis (segment not NULL); 不相关 rows re-zero; pending
  rows untouched. Completeness score is NOT recomputed (separate axis,
  different inputs). Audited as `RESCORE_LEADS` with counts.
  Reconstructed-input note: contacts come from the live table, so a
  Phase 7 merge since the original analysis is reflected — a feature,
  not drift (scores track current data, same as the next research run
  would see).

## 5. Invariants preserved

- Total contract 0–100 frozen (weights sum to exactly 100, enforced at
  write AND asserted on load).
- Deterministic, AI-free scoring — config changes which facts count how
  much, never what the facts are.
- Default config = today's behavior byte-for-byte (golden suite
  unchanged).
- Fail-open everywhere the config layer can be absent (migration-pending
  database researches/scores exactly as today).
- Breakdown JSON contract (version key + six dimensions) unchanged;
  consumers (json_extract floors, panel renderer) unaffected.

## 6. Stage plan

- **Stage 55 — config store + API.** migration 0029 + schema.sql;
  lead-score-config.ts (parse/load/save); GET/PUT endpoints; RBAC
  `scores.write`; audit rows; tests: parse validation (six keys / int /
  0–100 / sum 100 / rejects booleans), fail-open on missing table+row,
  roundtrip via API, RBAC matrix, audit written.
- **Stage 56 — engine + consumers.** ratio refactor of
  `computeLeadScoreV2` (+ optional weights param); golden equivalence
  under defaults; custom-weight pins; pipeline per-tick load;
  campaigns.ts effective-max clamp + fail-open; tests for each.
- **Stage 57 — panel + rescore.** editor UI; de-mirrored renderer;
  rescore endpoint (chunked, audited, contacts-backed); tests: rescore
  correctness (weights change → rows move, 不相关 re-zero, pending
  untouched, completeness untouched), merge-visibility; check-panel is a
  REQUIRED gate (admin.ts touched).

Gates per stage: vitest full green → tsc 0 → wrangler dry-run → stage
report (docs/stages/) → commit `phase10: stage NN - …`.
