# Stage 14 Report — Evidence V2: Research Runs + Append-Only Evidence

Branch: `feature/security-v2` · Follows: Stage 13 (prompt injection)

## Goal (spec §15)
Re-researching a company used to `DELETE FROM evidence WHERE company_id = ?`
and re-insert — every new crawl destroyed the previous verification trail, so
a wrong judgement could never be compared against the facts it replaced.
Stage 15… §15 requirements: keep the existing evidence system, add
`research_runs` (§15.1 verbatim DDL), add provenance columns to `evidence`,
make the trail append-only (§15.2: no UPDATE/DELETE of old rows — append, then
decide current facts via `is_current` / `valid_from` / `valid_until`), and test
old-evidence-preserved / new-evidence-appended / source hash / content hash /
research-run relation (§15.3).

## Changes

### `src/research-run.ts` (new)
- **`startResearchRun`** — inserts a `research_runs` row (status `running`,
  `started_at`) per attempt, returns the id.
- **`completeResearchRun`** — closes a run: `completed` (with
  `parser_version` / `model_name` / `model_version` stamped from the
  provenance) or `failed` (with the error text). No-op for a null run id.
- **`appendFieldEvidence`** — replaces the DELETE-then-INSERT: one D1 **batch**
  that (a) supersedes prior current rows per re-asserted field
  (`is_current = 0`, `valid_until = now`) and (b) appends the new rows with
  `is_current = 1`, `valid_from = now` and the full provenance set. Atomic:
  no partial supersede-without-append state can appear.
- **Hash semantics** (sha256, 16-hex prefix, verified against the documented
  inputs in tests):
  - `source_id` — stable identity of the source document (hash of
    `source_url`; `"ai-analysis"` for model-judged fields without a URL);
  - `source_hash` — identity of what the source said (hash of the quoted
    `evidence_text`) — detects source drift between runs;
  - `content_hash` — identity of the fact (hash of `field_name +
    NUL + field_value`) — the same fact re-observed yields the same hash.
- `EVIDENCE_PARSER_VERSION = "evidence-v2"` stamped on runs and rows so a
  future parser change can distinguish which code produced which facts.
- **Failure policy — fail-open**: provenance is an auditability layer, not a
  safety control (the pipeline's hard guarantees live in Stages 10-12). A
  write that cannot complete (migration-pending table/column, transient D1
  error) is skipped with a `console.warn`; research that already spent search
  credits and AI tokens is never failed by its own audit trail. The
  fail-open path can never degrade into the old DELETE behavior — the legacy
  fixture test proves old rows stay intact.

### `src/index.ts` — pipeline wiring
- **Provider provenance**: each of the 9 `analyzeWithX` functions takes an
  `AnalysisProvenance` out-object and stamps `{provider, model}` at its single
  success return point (the exact key/model that produced the analysis —
  key-rotation and model-fallback choices stay visible);
  `analyzeCustomer` threads it through and `processCustomer` owns it.
- **Run lifecycle in `processCustomer`** — three exits, all closed:
  - success: run closed `completed` with the analysis provenance;
  - relevance-precheck skip: run closed `completed` naming the actual judge
    (`workers-ai` + `RELEVANCE_MODEL`) — honest provenance, no paid analysis
    happened;
  - failure (`catch`): run closed `failed` with the reason (retry and failed
    alike — the attempt did fail; provider/model stay null when the failure
    preceded any analysis).
- **Evidence block**: `DELETE` + re-INSERT replaced by one
  `appendFieldEvidence` call carrying the run id and provenance.

### `src/admin.ts` — read side
- `getCustomerEvidence` (now exported for tests): orders `is_current DESC`
  ahead of the existing confidence/age ordering, so the panel's 30-row view
  leads with current facts even when superseded history rows have higher
  confidence. Degrades to the legacy query on `no such column` while the
  migration is pending. `EvidenceRow` gains optional `is_current`.

### Migration / deploy
- `schema.sql`: `evidence` CREATE TABLE carries the full Stage 14 shape for
  fresh installs; `research_runs` added (§15.1 DDL verbatim).
- `migrations/0012_research_runs_evidence_v2.sql`: `research_runs` + the 11
  `evidence` ALTERs, with the semantics documented per column. Existing rows
  backfill `is_current = 1` (they WERE the current facts at migration time);
  the next research run supersedes them through the normal append path.
  Verified against a real SQLite: 21 columns, backfill correct, duplicate
  ALTER rejected (hence the workflow's per-statement tolerance).
- `.github/workflows/deploy-worker.yml`: new step
  `Migrate research runs + evidence provenance (Security V2 Stage 14)` —
  same per-statement ALTER pattern as Stage 10, with pragma verification
  (n = 11 columns) and a research_runs existence check.

## Tests (+10 → 343 total)
`tests/evidence-v2.test.ts` (§15.3 list mapped in the header):
- run lifecycle: running → completed with parser/model provenance; failed
  variant keeps the error text and null model; distinct ids per attempt;
- **old evidence preserved / new evidence appended**: run 2 re-asserts one
  field → all 3 rows exist, run 1's row `is_current = 0` + `valid_until` set
  with the replaced fact still readable, run 2's row current; field
  isolation — a field NOT re-asserted stays current;
- **content hash**: verified against the documented input
  (`field_name\0field_value`); same fact re-observed across runs → identical
  hash; changed fact → different hash; all versions coexist with exactly one
  current row;
- **source hash / source_id**: same URL → same `source_id` across runs; same
  quote → same `source_hash`; changed quote (source drift) → different
  `source_hash`; model-judged fields share the `ai-analysis` document
  identity;
- **research run relation**: every evidence row joins an existing run with
  the matching customer; a completed run keeps its status while a later run
  appends more;
- fail-open: missing `research_runs` → `startResearchRun` null +
  `completeResearchRun(null)` no-op; legacy `evidence` (no new columns) →
  append skipped, the single legacy row untouched;
- admin read side: current row leads the view even below a superseded row's
  confidence; legacy table falls back to the original query.

## Verification
- `npx tsc --noEmit`: pass
- `npm test`: **343/343 pass** (was 333, +10; 23 files)
- `node scripts/check-panel.mjs`: 4 panels clean
- `npx wrangler deploy --dry-run` (offline): pass
- migration 0012 exercised on a real `node:sqlite` legacy schema: columns,
  backfill, idempotency-guard behavior all as designed

## Security Risks Fixed
- Baseline **#15 (P2)**: evidence overwritten in place. The verification
  trail is now append-only with per-run provenance — a wrong AI judgement can
  be traced to the exact run, provider, model and quoted source, compared
  against the facts it replaced, and re-verified; history is never destroyed
  by the next research pass.

## Notes and boundaries
- `retrieved_at` is the run's collection time. On research-reuse retries
  (Stage's existing `canReuseResearch` path) the underlying research text
  predates the run; the run still reflects when THIS pipeline observed and
  asserted the facts, which is the audit question the column answers.
- `model_name` = provider (`groq`), `model_version` = the exact model id sent
  to the API (`llama-3.3-70b-versatile`) — for LLM APIs the model id is the
  version.
- `contacts` (in the spec's suggested structure) already never overwrites
  history — fingerprint dedup appends only — so no change was needed there.
- The `is_current` ordering is display-level; correctness consumers (future
  completeness scoring, Stage 15) should filter `is_current = 1` themselves.
