# Stage 56 — Engine ratios × weight + consumers

Phase 10 (docs/phase10-lead-score-config.md §3). Committed: `phase10:
stage 56`.

## What shipped

- **index.ts — computeLeadScoreV2(a, weights = LEAD_SCORE_WEIGHTS)**: the
  hardcoded absolute tiers became RATIOS of the configured weight —
  `Math.round(ratio × weight)`: icp_fit distributor 1.0 / dealer|oem|
  wholesaler 5/6 / e-commerce ½ / retailer ⅓ / user|service ⅙; product_fit
  and buying_signal full-weight-or-zero; buyer_role named 1.0 / role-only
  persona ½; reachability email 1.0 / phone-whatsapp 8/15 / bare contact
  4/15; strategic_value ½ per verified field. Under the default weights
  every ratio resolves to the Phase 5 integers exactly — the golden
  suite (tests/lead-score-v2.test.ts) passes unchanged, byte-identical.
- **Strategic round choice**: the two strategic components share ONE
  round of the combined ratio instead of rounding each ½ separately —
  rounding halves apart could push an odd weight past its own maximum
  (Math.round(½·15)×2 = 16 > 15); one round keeps every dimension ≤ its
  configured weight, and is byte-identical under the defaults (5/10).
- **computeLeadScore(a, weights = …)** threads through; the 0–100 cap
  stays (weights sum to exactly 100; the clamp is belt-and-braces).
- **Pipeline**: the scheduled tick loads the effective weights ONCE per
  tick via loadLeadScoreWeights (fail-open to the code defaults) and
  flows them through processCustomer into the lead_score +
  lead_score_breakdown writes — one config SELECT per tick, not per
  customer; a mid-tick retune waits for the next tick instead of
  splitting one batch across two weight generations.
- **campaigns.ts**: sanitizeDimensionFloors clamps against the passed
  weights; parseSegmentFilters / deserializeFilters grew an optional
  `weights` parameter defaulting to the code defaults — every existing
  call site and test keeps its exact behavior. createGroup / updateGroup
  load the tuned weights from the database (fail-open pre-tune and
  pre-migration) so a group saved now carries no floor the current
  config can never produce.
- **admin.ts**: segment-preview and campaign create (both the stored
  group path and the fresh-body path) load the effective weights and
  pass them in — the campaign's segment is built NOW, so its floors
  clamp against the config effective at this moment.

## Tests (+11)

- tests/lead-score-v2.test.ts, appended "Phase 10: configurable
  weights" (7): omitted-weights ≡ defaults (byte-identity); icp tier
  rescaling under a 60-weight (60/50/30/20/10/0); ½-tier rounding
  half-up (role-only persona under a 9-weight → 5); reachability
  rescaling (phone 3, bare 1 under a 5-weight); the shared strategic
  round (odd 9-weight → 9, single field → 5, never 10); full-fit under
  TUNED hits every custom max with total exactly 100; 不相关 ignores
  custom weights entirely.
- tests/campaign-targeting.test.ts, appended "Phase 10: dimension
  floors clamp against the effective weights" (4): floor 40 valid under
  a tuned 60-weight / 61 rejected with "0-60"; the omitted-weights path
  keeps the 0-30 clamp; deserializeFilters threads weights (valid floor
  passes, out-of-range stored floors degrade to EMPTY_FILTERS —
  deserializeFilters is fail-open by design, the first run's wrong
  toThrow assertion caught and corrected); createGroup/updateGroup
  against real sqlite — pre-migration (no table) and pre-tune (no row)
  fail open to the 0-30 clamp, tuned row accepts 40, updateGroup
  rejects 61 and persists 55.

## Gates

- vitest 959/959 (74 files; +11 over Stage 55's 948)
- tsc --noEmit: 0
- wrangler dry-run: 610.54 KiB / gzip 148.61 KiB
- check-panel: not required (no panel template change in this stage);
  Stage 57 re-runs it as a hard gate.

## Notes

- deserializeFilters stays fail-open: a stored group's out-of-range
  floors (e.g. saved under a bigger icp_fit weight, then retuned down)
  degrade to EMPTY_FILTERS at campaign-create time rather than throwing
  — stored JSON never breaks a build; the live preview/create body path
  is where the operator gets the 400 with the reason.
- The research pipeline writes under the tick's weights; rows scored
  under an older profile keep their stored values until the Stage 57
  re-score sweep regenerates them.

## Phase 10 status

Stages 55 (config store + API) + 56 (engine + consumers) complete.
Remaining: Stage 57 (panel weights editor + de-mirrored breakdown
renderer + chunked rescore sweep + check-panel hard gate), then the
README Phase 10 section + wrap-up.
