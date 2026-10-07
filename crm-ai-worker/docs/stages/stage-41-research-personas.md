# Stage 41 — research_personas: persona-aware outreach (Phase 4)

Phase 4, second stage. Design: `docs/phase4-ai-intelligence.md`
(§4.2, §6 Stage 41).

## Problem

Buyer personas lived only in `customers.personas_and_solutions` (JSON,
overwritten per run) and were consumed solely by the panel's field
renderer — **the outreach prompt never saw them** (§2: the email pitched
blind; `OUTREACH_CUSTOMER_COLUMNS` didn't even select the column). No
history: re-research destroyed the previous persona set.

## Changes

| File | Change |
| --- | --- |
| `schema.sql` | `research_personas` table (evidence pattern + `persona_name`/`persona_role`/`needs_json`/`pain_points_json`, json_valid-guarded) + `idx_research_personas_customer (customer_id, is_current)` + `idx_research_personas_run` |
| `migrations/0024_research_personas.sql` | change record (additive: no CI step, no backfill — rows accumulate from the next run, same as signals in Stage 40) |
| `src/research-run.ts` | `appendResearchPersonas` + `PERSONAS_PARSER_VERSION` ('personas-v1') + caps `PERSONAS_PER_RUN_CAP = 10` / `PERSONA_NAME_CAP = 120` / `PERSONA_LIST_CAP = 6` / `PERSONA_ITEM_CAP = 200`; blank names/items dropped, dedup by `persona_name` first-occurrence-wins, AI order preserved |
| `src/index.ts` | `extractPersonaEntries` (safe extraction from the `unknown` payload) + fresh-path wiring after `appendResearchSignals` (dual-write: cache column untouched); cron prune block gains `pruneSupersededResearchPersonas` + `DATA_PRUNE` key `research_personas_superseded` |
| `src/data-retention.ts` | `pruneSupersededResearchPersonas` (superseded-only, `COALESCE(valid_until, created_at)`) |
| `src/outreach.ts` | **persona-aware prompt**: `buildOutreachPrompt` gains an optional `personas` param and a 关键决策人画像 section (angle per persona, ≤ 5 personas); `loadPersonasForOutreach` reads current rows first, falls back to the cache column (§3.4); `OutreachCustomer`/`OUTREACH_CUSTOMER_COLUMNS` gain `personas_and_solutions`; `generateDraftForCustomer` wires the loader in (one extra indexed read per draft, fail-open) |
| `src/admin.ts` | detail endpoint serves `personas` (current set, fail-open to `[]`); panel's 客户画像 section prefers typed rows (role + 需求/痛点 lines) with the JSON-column renderer as fallback |
| `tests/research-personas.test.ts` | new, 14 tests |
| `tests/outreach-personas.test.ts` | new, 8 tests |
| `tests/data-retention.test.ts` | cron test extended seven → eight tables |

## Semantics pinned

- **Supersede runs even for an empty input** — like signals, unlike
  facts: the cache column always stores the full
  `personas_and_solutions` object (empty arrays included), so the
  current rows mirror the latest run's judgment the same way.
- **Rows first, cache-column fallback** (§3.4, the Stage 38 pattern):
  the prompt and the panel read current `research_personas` rows; the
  JSON column serves customers researched before this stage and stays
  the "latest" fast path. No deprecation cutover.
- **The prompt shape is backward-compatible**: no persona data → no
  section, exactly the pre-Stage-41 prompt (two-argument callers
  unchanged). The persona section is UNTRUSTED DATA like every crawled
  field — the §14 boundary line and injection tests cover it.
- **Solutions stay in the profile payload** (§4.2): they are prompt
  material, not a query target — Stage 42 carries them in
  `research_profiles.solutions_json`.
- **Fail-open everywhere**: writer, loader, retention and both readers
  survive a missing table.

## Verification

- `tests/research-personas.test.ts` (14): writer (append + parser
  version + run link + JSON lists; same-batch supersede; empty
  supersede; name dedup first-wins; 10/120/6×200 caps; blank drops;
  per-company isolation; fail-open; null run id) + prune
  (superseded-only, current immortal, missing table) + admin detail
  (current set order; empty after superseding run; missing table fails
  open).
- `tests/outreach-personas.test.ts` (8): prompt section content
  (role/needs/pain_points + angle instruction), §14 untrusted framing,
  no-data → pre-Stage-41 shape (2-arg call identical),
  `PERSONAS_PROMPT_CAP = 5`; loader rows-first, cache fallback
  (superseded-only set and missing table), garbage column → [].
- `tests/data-retention.test.ts`: cron DATA_PRUNE metadata carries
  `research_personas_superseded`; `"0"` keeps superseded personas.
- Full suite **784/784 (64 files)** — 762 prior + 22 new, zero edits to
  existing assertions (both prompt-injection suites green unchanged).
- `tsc --noEmit` clean.
- `wrangler deploy --dry-run`: 560.67 KiB / gzip 137.16 KiB (was
  553.13 / 135.46).

## Next

Stage 42 — `research_profiles` (company_profile + outreach_context +
solutions, 1:1 per run) + `research_facts.contact_id` light entity
resolution (§6).
