# Stage 40 — research_signals: the buying-signal layer (Phase 4)

Phase 4, first stage. Design: `docs/phase4-ai-intelligence.md`
(§4.1, §6 Stage 40).

## Problem

Buying signals lived only in `customers.buying_signals` (JSON array,
overwritten per run) — and **nothing ever read them**: selected in both
admin column lists, never rendered in the panel, never consumed by
outreach or campaigns. The weakest layer in the §2 survey: written,
never read, no history.

## Changes

| File | Change |
| --- | --- |
| `schema.sql` | `research_signals` table (evidence pattern: `research_run_id` soft ref, `signal_text`, `parser_version`, `is_current`/`valid_from`/`valid_until`) + `idx_research_signals_customer (customer_id, is_current)` + `idx_research_signals_run` |
| `migrations/0023_research_signals.sql` | change record (additive: no CI step, no backfill — rows accumulate from the next run, same as facts in Stage 37) |
| `src/research-run.ts` | `appendResearchSignals` + `SIGNALS_PARSER_VERSION` ('signals-v1') + caps `SIGNALS_PER_RUN_CAP = 20` / `SIGNAL_TEXT_CAP = 500`; blanks dropped before caps, dedup first-occurrence-wins preserving AI order |
| `src/index.ts` | fresh-path wiring after `appendFieldEvidence`, before `completeResearchRun` (dual-write: cache column untouched); cron prune block gains `pruneSupersededResearchSignals` + `DATA_PRUNE` key `research_signals_superseded` |
| `src/data-retention.ts` | `pruneSupersededResearchSignals` (superseded-only, `COALESCE(valid_until, created_at)` — same policy as evidence/sources/facts) |
| `src/admin.ts` | detail endpoint serves `signals` (current set, fail-open to `[]`); panel gains `renderSignals` — 🚨 采购信号 (Buying Signals) section, evidence-card styling, rendered before the evidence chain |
| `tests/research-signals.test.ts` | new, 14 tests |
| `tests/data-retention.test.ts` | cron test extended six → seven tables (insert + survival + metadata key; `"0"` opt-out keeps superseded signals) |

## Semantics pinned

- **Supersede runs even for an empty input** — unlike
  `appendResearchFacts` (gap-fill). The current set must always mirror
  the latest run's judgment exactly like the cache column (NULL when
  the analysis found nothing); otherwise stale signals from an older
  run would render as if this run had confirmed them.
- **Append + supersede, never delete**, in one D1 batch (atomic);
  `valid_until` stamps the flip. The current set of every company
  survives retention forever, like evidence/sources/facts.
- **Cache column stays** (§3.4): small, 1:1-hot, still the "latest"
  fast path for future consumers. No 36→38 replay.
- **Fail-open everywhere**: writer, retention and the detail reader all
  survive a missing table (pre-migration window, bare fixtures).

## Verification

- `tests/research-signals.test.ts` (14): writer (append + parser
  version + run link; same-batch supersede keeps history; empty
  supersede; dedup + AI order; 20/500 caps; blank drop; per-company
  isolation; fail-open; null run id) + prune (superseded-only, current
  immortal, missing table no-op) + admin detail (current set in order;
  empty after superseding run; missing table fails open).
- `tests/data-retention.test.ts`: cron DATA_PRUNE metadata now carries
  `research_signals_superseded`; `"0"` keeps superseded signals.
- Full suite **762/762 (62 files)** — 748 prior + 14 new, zero edits to
  existing assertions.
- `tsc --noEmit` clean.
- `wrangler deploy --dry-run`: 553.13 KiB / gzip 135.46 KiB (was
  550.47 / 135.04).

## Next

Stage 41 — `research_personas` + persona-aware outreach prompt (§6).
Campaign targeting on signals stays open until a campaign consumer
exists.
