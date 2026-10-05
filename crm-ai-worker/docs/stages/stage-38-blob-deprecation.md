# Stage 38 — cutover + blob deprecation

Phase 3, final stage. Design: `docs/phase3-research-engine.md` (§Stage 38).
Stages 36 (`research_sources`) and 37 (`research_facts`) built the
substrate while the blob stayed authoritative; this stage flips the
readers and stops the writer.

## Problem

`customers.full_research_text` was a single per-company blob, overwritten
by every fresh run — raw research history did not survive re-research.
Stages 36/37 made `research_sources` the authoritative raw record, but the
reuse path still read the blob and the fresh path still overwrote it, so
the blob remained the de facto source of truth (and a stale-read hazard:
the last writer wins, everything before it is gone).

## Changes

| File | Change |
| --- | --- |
| `src/research-run.ts` | `SavedSourceRow`, `buildSavedResearchText` (pure reconstruction of the exact legacy blob format from a current source set), `readSavedResearchText` (sources-first read, blob fallback, fail-open on missing table / read error) |
| `src/index.ts` | reuse path reads `readSavedResearchText(env, company_id, blob)` instead of the raw column; fresh path stops writing the blob (the `UPDATE customers SET full_research_text` is deleted — `researchContext` stays in memory as the AI input and the source-writer input); `CustomerRow.full_research_text` and `claimCustomers` comments now mark the column as fallback-only |
| `src/admin.ts` | detail endpoint (`GET /admin/api/customers/:id`) serves the sources reconstruction over the stale blob; `AdminCustomer` gains the optional field; panel config marks 完整研究文本 `readonly`; readonly textareas render as `<pre>` (preserving the `===` header layout) instead of an unbounded text wall |
| `schema.sql` | deprecation comment on the column (kept as read-only fallback; no new writers) |
| `tests/research-text.test.ts` | new, 10 tests |
| `docs/phase3-research-engine.md` | Status → shipped; Stage 38 section records the manual-row amendment |

## Semantics pinned

- **Byte-compatible reconstruction**: `cleanResearchContextForAi` splits
  saved research on `=== ... ===` headers, so `buildSavedResearchText`
  must reproduce the historical format exactly:
  - website: gains `=== 主网站内容 ===\n`, or collapses to
    `=== 主网站无法访问 ===` when the crawl found nothing;
  - social: gains `\n\n=== 已验证社交媒体 ===\n` (stored rows keep only
    the rendered lines);
  - search/additional: carry their own `--- ... ---` segment headers
    verbatim (the writer stored them whole — no rebuilding);
  - rows arrive in append order (`ORDER BY id`), reproducing blob segment
    order.
- **Single-snapshot passthrough**: a lone `backfill` (0021) or `manual`
  row's `raw_text` IS the full legacy format — returned verbatim, no
  header surgery.
- **Sources-first, blob-fallback**: the fallback fires only when the
  current source set is empty or unreadable — i.e. pre-Stage-36 snapshots
  (no source rows were ever written for them) or a missing table. A
  Stage-36+ research always leaves a non-empty reconstruction (the
  website row alone yields at least the unreachable marker).
- **Fail-open everywhere**: a `research_sources` read problem degrades to
  the blob (`warnSkip`), never to a crash and never to paid re-research.
- **No `manual` rows needed**: the design's "panel edit writes a manual
  source row" concern dissolved during recon — `updateCustomer`'s
  editable whitelist never contained `full_research_text`, so panel edits
  of the blob have never persisted. The field is now honestly `readonly`
  in the panel; the reader still passes a single `manual` row through
  verbatim should that ever change.
- **Column kept, not dropped**: SQLite `DROP COLUMN` means rebuilding the
  customers table for zero functional gain. The blob stays as a
  read-only fallback cache; schema.sql documents it.

## Reuse-path equivalence

For any company, `readSavedResearchText` returns exactly what the blob
used to hold: fresh runs wrote sources from the same segments that formed
the blob (same budget), and reuse passes never rewrote the blob (the old
UPDATE lived in the fresh branch only) — so the current source set of the
last fresh run == the last-written blob. The ≥ 500 reuse threshold and
the `cleanResearchContextForAi` behavior are unchanged.

## Verification

- `tests/research-text.test.ts` (10): full four-segment byte-exact
  rebuild; unreachable marker; empty social omitted; backfill verbatim;
  empty rows → fallback; sources-first read; no-rows fallback;
  missing-table fail-open; admin detail serves reconstruction over stale
  blob; admin detail keeps blob for pre-36 snapshots.
- Full suite **745/745 (60 files)** — 735 prior + 10 new, zero edits to
  existing tests.
- `tsc --noEmit` clean.
- `wrangler deploy --dry-run`: 549.77 KiB / gzip 134.99 KiB (was
  548.22 / 134.43).

## Next

Phase 3 is complete. Follow-ups stay gated as documented: companies /
people normalization (audit §十三) needs its own operator design review;
Phase 4 (entity resolution on top of `research_facts`, persona → signals
→ strategy) is outlined in the design doc's outlook section.
