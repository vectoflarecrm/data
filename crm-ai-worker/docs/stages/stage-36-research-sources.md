# Stage 36 — research_sources (raw layer)

Phase 3, first stage. Design: `docs/phase3-research-engine.md` (§3 target
model, §4 staged plan). Requirements: 建议 §十三/§十四/§二十.

## Problem

Raw crawl material lived only in `customers.full_research_text` — a single
concatenated blob, **overwritten on every fresh research pass**. The raw
pages behind previously extracted facts were unrecoverable (evidence keeps
the extracted facts, not the pages), and there was no per-source registry
(which URL, fetched when, hash of what exactly).

## Changes

| File | Change |
| --- | --- |
| `schema.sql` | new `research_sources` table (11 cols, mirrors evidence: `research_run_id` soft ref, `content_hash`, `parser_version`, `fetched_at`, `is_current`, `valid_from`/`valid_until`) + `idx_research_sources_customer(customer_id, is_current)`, `idx_research_sources_run(research_run_id)` |
| `migrations/0020_research_sources.sql` | change record (additive `CREATE TABLE IF NOT EXISTS` — schema.sql applies it on every deploy; no ALTER, no CI DDL step) |
| `migrations/0021_research_sources_backfill.sql` | one-time backfill: each legacy blob → synthetic run (`backfill-<id>`, `parser_version='backfill-v1'`) + one `backfill` source row. Idempotent (deterministic ids + NOT EXISTS guards incl. "customer already has real sources"), atomic (`--file` = one transaction) |
| `src/research-run.ts` | `SOURCES_PARSER_VERSION`, `RESEARCH_SOURCE_TOTAL_CAP` (50 000 — same as the blob cap), `capResearchSourcesToBudget` (blob-order walk; empty-text+URL entries survive as "crawled, got nothing" markers), `appendResearchSources` (append + supersede in ONE D1 batch, fail-open like `appendFieldEvidence`) |
| `src/index.ts` | `processCustomer` fresh path registers its four segments (website / social / search / additional) after the blob write — **dual-write transition**: blob stays authoritative for the reuse path and panel until Stage 38. Cron prune block gains `research_sources_superseded` in the DATA_PRUNE audit metadata |
| `src/data-retention.ts` | `pruneSupersededResearchSources` — superseded-only (`is_current = 0`), same horizon and fallback timestamp as evidence; current snapshots survive forever |
| `.github/workflows/deploy-worker.yml` | CI step "Backfill research_sources from full_research_text (Phase 3 Stage 36)" after the Stage 34 block: `--file` execution + exact numeric run/source count match (a mismatch blocks the deploy) |
| `tests/research-sources.test.ts` | new, 13 tests |
| `tests/data-retention.test.ts` | cron-prune test extended to five tables (seeded superseded source pruned, current snapshot kept, `"0"` keeps superseded sources) |

## Semantics pinned

- **Append + supersede, never delete** — identical to evidence v2: a fresh
  run flips the previous set to `is_current = 0` and appends its own rows
  in one batch; per-company scope (other companies untouched).
- **Budget cap enforced in the writer** (not the caller): total raw text
  per run ≤ 50 000 chars, walked in blob order — per-run history never
  stores more than the pipeline already saved in the blob.
- **Fail-open**: provenance is an auditability layer; a source write can
  never fail research that already spent search credits. Null run id still
  records sources.
- **Backfill never pollutes real history**: a customer with any
  post-Stage-36 source rows is skipped (the new writer's rows are the
  truth; a synthetic snapshot would only add noise). Runs insert before
  sources within one atomic file, so interrupted states self-heal on the
  next run.
- **content_hash NULL on backfill rows** (hash is WebCrypto-side); the
  next real run supersedes them with properly hashed rows.

## Gates

- `vitest run`: **721/721 (58 files)** — 13 new (writer 5, budget 4,
  backfill 2, retention 2), data-retention extended, rest untouched.
  Note: `provider-rate-limit` "window rollover" was observed flaky once in
  a full run, green standalone and in the final full run — time-dependent,
  unrelated to this stage.
- `tsc --noEmit`: 0 errors.
- `wrangler deploy --dry-run`: 543.91 KiB / gzip 133.64 KiB (was 541.05 /
  133.16 — the new writer + wiring).
- Panel: untouched (no admin field changes; blob remains the panel's raw
  view until Stage 37/38 cutover).

## Stage 37 preview (not started)

`research_facts` — rule-mined contact facts become typed rows linked to
their sources; reuse path re-mines from `research_sources`; panel raw view
cutover decision.
