# Stage 37 — research_facts (typed substrate)

Phase 3, second stage. Design: `docs/phase3-research-engine.md`. Requirements:
建议 §二十一 (Fact Extraction layer), §十三/§十四 (per-run structured
history). Stage 36 delivered the raw layer (`research_sources`); this stage
delivers the fact layer on top of it.

## Problem

Rule-mined contact observations (emails, phones, WhatsApp links, social
links) existed only inside the raw blob / prompt facts block — never as
rows. Phase 4 (entity resolution → persona → signals → strategy) would have
to re-grep raw prose with regexes, with no per-run history, no provenance,
no queryability.

## Changes

| File | Change |
| --- | --- |
| `schema.sql` | new `research_facts` table (13 cols: `fact_type`/`fact_value`/`source_type`/`occurrence_count`/`confidence` + the evidence-style provenance and validity set) + `idx_research_facts_customer(customer_id, is_current)`, `idx_research_facts_run(research_run_id)` |
| `migrations/0022_research_facts.sql` | change record (additive `CREATE TABLE IF NOT EXISTS`; schema.sql applies it on every deploy — no ALTER, no CI step, no data backfill) |
| `src/research-run.ts` | `FACTS_PARSER_VERSION`, `ResearchFactEntry`, writer-side bounds (`FACTS_PER_RUN_CAP = 100`, `FACT_VALUE_CAP = 500`), `appendResearchFacts` (append + supersede in ONE D1 batch, fail-open), `hasCurrentResearchFacts` (reuse-path gap-fill gate, fail-open) |
| `src/index.ts` | shared `WHATSAPP_LINK_REGEX` / `SOCIAL_LINK_REGEX` (dedup of the reuse path's inline literals), exported `mineResearchFacts` (one entry per distinct `(fact_type, fact_value)`, first-seen segment as `source_type`, repeats aggregate into `occurrence_count`), fresh-path wiring (mines the SAME budget-capped segments saved to research_sources), reuse-path gap-fill (pre-37 customers get facts from their saved text on the next retry, `source_type = 'backfill'`), cron prune block gains `research_facts_superseded` |
| `src/data-retention.ts` | `pruneSupersededResearchFacts` — superseded-only, same horizon/fallback as evidence/sources |
| `tests/research-facts.test.ts` | new, 14 tests |
| `tests/data-retention.test.ts` | cron-prune test extended to six tables |

## Semantics pinned

- **Grain**: one row per distinct `(customer_id, run, fact_type,
  fact_value)`. Repeats across the run's segments aggregate into
  `occurrence_count`; the first segment containing the value is its
  `source_type` (same vocabulary as `research_sources`).
- **Facts ↔ sources consistency**: the fresh path mines the SAME
  budget-capped segments that land in `research_sources`, so every fact's
  supporting text stays queryable (a fact never references text that was
  not saved).
- **As-mined values, no normalization**: emails lowercased by the miner;
  phones/URLs kept exactly as matched. Normalization is Phase 4 entity
  resolution's job. Known overlap kept deliberately: digit runs inside
  wa.me links surface as phone observations (the reuse-path facts block
  has always had the same overlap — same regexes, same text).
- **Writer-side bounds** (defensive, like the Stage 36 budget): ≤ 100
  rows/run, value ≤ 500 chars, `occurrence_count` floored at 1,
  `confidence` defaults to 1 (deterministic observation).
- **Gap-fill instead of backfill**: no one-time migration — customers
  researched before this stage get facts lazily on their next reuse pass
  (`source_type = 'backfill'`, run id = the reuse attempt's run, honest
  "observed during this run" semantics). The gate `hasCurrentResearchFacts`
  ensures customers with current facts are never churned.
- **Append + supersede, fail-open** — identical to evidence/sources.

## Design-doc amendment

The Stage 37 section of `docs/phase3-research-engine.md` originally included
"the reuse path re-mines from research_sources instead of the blob". That
switch moved to **Stage 38**: the reuse path and the panel edit handler are
coupled (a manual `full_research_text` edit must not be silently shadowed by
stale source rows), so the whole cutover — reuse path reads sources, panel
edit writes sources, blob write stops — lands as one stage instead of being
split across two. Documented in the design doc.

## Gates

- `vitest run`: **735/735 (59 files)** — 14 new (writer 6, miner 4,
  gap-fill gate 2, retention 2), data-retention extended to six tables.
- `tsc --noEmit`: 0 errors.
- `wrangler deploy --dry-run`: 548.22 KiB / gzip 134.43 KiB (was 543.91 /
  133.64 — miner + writer + wiring).
- Panel: untouched this stage (raw view cutover is Stage 38).

## Stage 38 preview (not started)

Full cutover: reuse path reads `research_sources` (blob fallback), panel
edit handler supersedes + appends a `manual` source row alongside the blob
edit, blob write stops, panel raw view reads sources; blob column retained
as documented deprecated cache.
