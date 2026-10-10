# Stage 55 — Lead-score config store + API

Phase 10 (docs/phase10-lead-score-config.md §2). Committed: `phase10:
stage 55`.

## What shipped

- **migration 0029 + schema.sql** — single-row `lead_score_config` table
  (`CHECK (id = 1)` is the enforced invariant, not a convention;
  weights_json is written only by the validated PUT). Additive and
  idempotent: existing databases get the CREATE via 0029, fresh installs
  via schema.sql — shape parity pinned by test (PRAGMA table_info both
  ways) plus an idempotent re-exec and the CHECK living in the DDL.
- **src/lead-score-config.ts** (new) — `parseLeadScoreWeights`
  (discriminated `{ok:true,weights}|{ok:false,error}` result; exactly the
  six dimension keys, integer 0–100, sum EXACTLY 100; typeof checked
  first so booleans die — the Stage 53 contactsPerCompany lesson),
  `loadLeadScoreConfig` / `loadLeadScoreWeights` (fail-open to
  `LEAD_SCORE_WEIGHTS` on missing table / missing row / corrupt JSON /
  hand-edited invalid rows; "no such table" stays quiet, other failures
  `safeLog`), `saveLeadScoreWeights` (upsert id=1 via ON CONFLICT,
  returns the updated_at; fail-loud on a missing table — a config write
  that pretended to save would be a lie).
- **src/lead-score-dims.ts** — `LeadScoreWeights` type
  (`Record<LeadScoreDimension, number>`): the shared vocabulary for the
  store, the API, the engine (Stage 56) and the panel (Stage 57).
- **rbac.ts** — new permission `scores.write`, granted to super_admin +
  operator (weight tuning is business/research semantics, not credential
  management); `/admin/api/lead-score/*` maps GET→customers.read,
  else→scores.write. The existing customers/lead-score-histogram
  endpoint is untouched (it lives under the customers segment).
- **admin.ts (handleAdminApi)** — GET/PUT
  `/admin/api/lead-score/config`: GET answers the effective weights, the
  code defaults and updated_at (fail-open, always answerable
  pre-migration); PUT validates (400 carrying the reason), saves, and
  audits `UPDATE_SCORE_CONFIG` with old→new weights in metadata.

## Found during the stage: the sanitizer shared-reference trap

The first run failed the pre-tune GET: `defaults` came back
"[REDACTED]". Root cause: pre-tune both `weights` and `defaults` are the
same module-level `LEAD_SCORE_WEIGHTS` reference, and sanitizeResponse's
cycle guard (one shared WeakSet across the payload, redaction.ts)
redacts any value it has already walked — a legitimate shared reference
is indistinguishable from a cycle to it. Fix: the endpoint serves
`defaults` as a shallow copy, and the test pins the full response shape
so a regression answers "[REDACTED]" loudly instead of silently. Note
carried to Stage 57's renderer work: never put the same object reference
under two response keys.

## Tests — tests/lead-score-config.test.ts (18)

- Parse matrix: valid custom + the defaults; array/null/number/string;
  missing key (named in the reason); unknown key (a typo'd future
  dimension is an error, not a silent ignore); 1.5 / "30" / true / false
  (integer rejection); −1 / 101 (range); sum 99 / 101 with the actual
  sum in the reason.
- Store roundtrip (real node:sqlite): 0029-vs-schema shape parity +
  idempotent re-exec + CHECK in the DDL; fresh table → defaults + null
  updated_at; save→load roundtrip (SQL-UTC timestamp format, updated_by,
  single row on re-save); missing table fails open; corrupt +
  hand-edited-invalid rows fail open (not a throw); save on a missing
  table rejects "no such table" — the fail-loud writer pinned.
- API surface (real handleAdminRequest + schema.sql): GET pre-tune
  defaults; PUT roundtrips through GET with the audit row
  (`UPDATE_SCORE_CONFIG`, old_weights/new_weights, super_admin bearer);
  seven invalid PUTs → 400 + reason with nothing stored; unauthenticated
  PUT → 401; RBAC matrix (operator PUT 200, researcher/sender/readonly
  403; GET 200 for every role).

## Gates

- vitest 948/948 (74 files; +18 new over Stage 54's 930)
- tsc --noEmit: 0
- wrangler dry-run: 609.71 KiB / gzip 148.42 KiB
- check-panel: not required (no panel template change in this stage);
  Stage 57 re-runs it as a hard gate.

## Phase 10 status

Stage 55 (config store + API) complete. Remaining: Stage 56 (engine
ratios × weight; pipeline per-tick load; campaigns.ts effective-max
clamp), Stage 57 (panel weights editor + de-mirrored breakdown renderer
+ chunked rescore sweep), then the README Phase 10 section + wrap-up.
