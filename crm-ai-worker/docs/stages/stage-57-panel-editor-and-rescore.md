# Stage 57 — Panel editor + de-mirrored renderer + rescore sweep

Phase 10 (docs/phase10-lead-score-config.md §4). Committed: `phase10:
stage 57`.

## What shipped

- **src/lead-score-engine.ts (new leaf)**: `computeLeadScoreV2` +
  `extractPersonaEntries` + the `LeadScoreBreakdown` type moved out of
  index.ts. The rescore endpoint lives in admin.ts, which cannot import
  the worker entry (index → admin cycle) — the engine is now a leaf
  depending only on lead-score-dims + a type from research-run, the same
  pattern as lead-score-dims (Stage 45) and lead-score-config (Stage 55).
  New `LeadScoreInputs` is the NARROW structural slice of
  CustomerAnalysis the six rules actually read (the full analysis
  satisfies it structurally, no cast) — the rescore path builds it
  straight from stored rows, so scores follow a retune without
  re-running research. index.ts re-exports the engine, so
  tests/lead-score-v2.test.ts keeps importing from ../src/index
  unchanged; `computeLeadScore` (the 0–100 total wrapper) stays in index.
- **POST /admin/api/lead-score/rescore** (admin.ts, scores.write in
  rbac.ts since Stage 55): walks completed rows with a segment in id-
  cursor chunks of 100 (D1 parameter caps), rebuilds the engine inputs
  from the stored analysis columns + the LIVE contacts table (merge-
  visibility: a Phase 7 merge or panel contact add since the analysis
  counts for buyer_role/reachability like a found one), recomputes under
  the weights loaded ONCE per sweep via loadLeadScoreWeights (fail-open
  to the code defaults — no config row sweeps under defaults), and
  writes lead_score + lead_score_breakdown. 不相关 rows re-zero (score 0,
  all-zero v2 breakdown); pending/processing/failed rows and
  data_completeness_score are untouched (separate axis — the sweep never
  re-runs research). Audited `RESCORE_LEADS` with scanned/rescored/zeroed
  counts + the applied weights (shallow copy — the Stage 55 cycle-guard
  lesson applied defensively).
- **Panel weights editor** (ADMIN_PANEL_HTML, new section between the
  pre-filter and the customer list): six number inputs (`.s-mw64`, a new
  additive utility class — `.toolbar input`'s 240px min-width would stack
  them) + live 合计 readout with the save button disabled unless the sum
  is exactly 100; 恢复默认 (code defaults from GET config), 保存权重
  (PUT, fail-loud reasons surfaced), 重算存量评分 (confirm dialog → POST
  rescore → counts toast + list/histogram reload). lsMeta shows
  last-updated vs 未调整.
- **Renderer de-mirrored**: `renderLeadScoreBreakdown` no longer carries
  the Stage 44 JS mirror `[30,20,10,15,15,10]` — dimension maxes come
  from `LS_DIMS_MAX`, filled by the same lsLoad() fetch of
  /admin/api/lead-score/config (one fetch per panel load, shared with the
  editor). The literals survive only as the fail-open fallback for a
  fetch failure (pre-migration), and LS_DIMS is the single key/label
  source for both editor and renderer.

## Tests (+4)

tests/lead-score-rescore.test.ts (new, real sqlite via makeDb/makeEnv):

- tuned-weights sweep (full scenario): completed distributor re-tiered
  30/20/10/15/15/10 → 60/10/10/10/5/5 with the breakdown equal to
  computeLeadScoreV2 over the same inputs; 不相关 re-zeroed (all-zero v2
  breakdown); pending row untouched; completed-but-never-analyzed row
  (segment NULL) out of scope; completeness column untouched; response
  {ok, scanned:2, rescored:1, zeroed:1}; audit RESCORE_LEADS metadata
  carries the counts + TUNED weights.
- merge-visibility + fail-open: no lead_score_config row → the sweep
  applies the code defaults; a named contact with email added to the
  contacts table AFTER the analysis (stored breakdown said 0) moves
  buyer_role/reachability to the full weights; audit records the code
  defaults.
- RBAC: readonly session → 403 (nothing ran — lead_score stays NULL);
  operator session → 200.
- chunking: 105 completed minimal rows across two id-cursor chunks →
  scanned 105, rescored 105 (用户 tiers to 5 under defaults).

First run caught a test-side seeding bug (the "pending" row was missing
`status: "pending"` and defaulted to completed → scanned=3); fixed before
landing — no production change.

## Gates

- vitest 963/963 (75 files; +4 over Stage 56's 959)
- tsc --noEmit: 0
- check-panel (REQUIRED — admin.ts touched): 7 panels clean; main panel
  script parses OK (31,248 chars), 46 static ids, no duplicates, no
  dangling getElementById.
- wrangler dry-run: 618.49 KiB / gzip 151.07 KiB

## Notes

- The sweep's contacts source is the LIVE table, not the analysis
  snapshot — deliberate (design §4): scores track current data, same as
  the next research run would see; a merge since the analysis is a
  feature, not drift.
- stored-group floors (campaigns) are NOT swept: deserializeFilters
  degrades out-of-range stored floors fail-open at campaign-create time
  (Stage 56); the operator re-saves the group to re-clamp.
- Panel ids are ls-prefixed (lsInputs/lsMeta/lsSum/lsDefaultsBtn/
  lsSaveBtn/lsRescoreBtn/lsMsg); the six per-dimension inputs are built
  in a loop (dynamic ids, excluded from check-panel's static-id scan by
  construction).

## Phase 10 status

Stages 55 (config store + API) + 56 (engine ratios + consumers) + 57
(panel editor + de-mirrored renderer + chunked rescore sweep) complete.
Remaining: README Phase 10 section sync + wrap-up pass (Status → shipped
in full).
