# Stage 42 — research_profiles + fact→contact linkage (Phase 4)

Phase 4, third stage. Design: `docs/phase4-ai-intelligence.md`
(§4.3, §4.4, §5, §6 Stage 42).

## Problem

The outreach payloads — `company_profile`, `outreach_context`, the
`solutions` array — lived only in one-shot cache columns on
`customers`, overwritten per run: **re-research destroyed every
version** (the 3b review's documented `outreach_profiles` trigger).
And the typed fact substrate (Stage 37) had no entity dimension: an
email fact could not answer §十四's "这个邮箱是谁、什么时候、从哪个
网页提取的" without re-grepping raw prose.

## Changes

| File | Change |
| --- | --- |
| `schema.sql` | `research_profiles` table (1:1 per run: `company_profile_json`/`strategy_json`/`solutions_json`, all json_valid-guarded) + `idx_research_profiles_customer (customer_id, is_current)` + `idx_research_profiles_run`; `research_facts` CREATE gains `contact_id TEXT` (fresh installs) |
| `migrations/0025_research_profiles_and_fact_contacts.sql` | change record: the profiles CREATE (additive, no backfill) + the `research_facts` ALTER semantics (nullable column, no table rebuild) |
| `.github/workflows/deploy-worker.yml` | new CI step "Migrate research_facts contact_id (Phase 4 Stage 42)" — single duplicate-column-tolerant ALTER (Stage 17+ pattern) + pragma verification, before Typecheck |
| `src/research-run.ts` | `appendResearchProfile` + `PROFILES_PARSER_VERSION` ('profiles-v1') + solutions caps `SOLUTIONS_PER_RUN_CAP = 10` / `SOLUTION_FIELD_CAP = 200` (dedup by name, first-occurrence-wins, AI order preserved) + `PROFILE_JSON_CAP = 20_000` (oversized opaque JSON drops to NULL, never sliced — json_valid survives); `linkResearchFactsToContacts` (email: case/trim-insensitive; phone: separators stripped via nested `REPLACE` — SQLite's `TRANSLATE` is 3.47+ and absent from node:sqlite, so it cannot gate the linkage) |
| `src/index.ts` | `extractSolutionEntries` (safe extraction from the `unknown` payload, beside `extractPersonaEntries`); profile wiring after `appendResearchPersonas` (dual-write: cache columns untouched); `linkResearchFactsToContacts` call after the contacts persist block (facts pre-AI, contacts post-AI — the linkage is the bridge); cron prune block gains `pruneSupersededResearchProfiles` + `DATA_PRUNE` key `research_profiles_superseded` |
| `src/data-retention.ts` | `pruneSupersededResearchProfiles` (superseded-only, `COALESCE(valid_until, created_at)`) |
| `src/admin.ts` | detail endpoint serves `linked_facts` (current facts with `contact_id IS NOT NULL`, LEFT JOIN `contacts` for name/title, fail-open to `[]`); panel gains `renderLinkedFacts` (联系方式归属 section) right after the evidence section |
| `tests/research-profiles.test.ts` | new, 20 tests |
| `tests/data-retention.test.ts` | cron test extended eight → nine tables |

## Semantics pinned

- **One run = one row, always** (§4.3): the profile row lands even when
  all three payloads are empty — a run that produced nothing is still
  history, and the current row always mirrors the latest run (the
  cache-column twin). Supersede + append in one D1 batch, like every
  provenance layer.
- **Byte-identical cache twin**: `company_profile_json` /
  `strategy_json` store the exact serialized strings the
  `customers` UPDATE binds — the current row can never disagree with
  the cache columns. `solutions_json` is the standalone solutions
  array (§4.2's destination), always valid JSON, possibly `[]`.
- **Linkage is strictly scoped** (§4.4): only THIS run's current facts
  (`research_run_id`), only contacts of the same company (correlated
  subquery on `customer_id`), never overwriting an existing link
  (`contact_id IS NULL` guard), and a null run id is a no-op — an
  unscoped UPDATE would reach other runs' orphan rows. Old-run facts
  are never retroactively rewritten: rows accumulate from the next
  run onward, exactly like facts in Stage 37.
- **The ALTER is CI-only for existing databases** (§5): fresh installs
  get `contact_id` from the schema.sql CREATE; the deploy step applies
  the ALTER with Stage 17's duplicate-column tolerance and verifies
  convergence via `pragma_table_info`. No backfill: unlinked historical
  facts stay unlinked until their company's next research run.
- **Contact MERGE stays deferred** (§4.4): same person + new channel
  needs dedup keys, merge semantics and a panel UI with no consumer
  today; the trigger (persona-targeted campaigns needing per-person
  dedup counts) is unchanged.
- **Fail-open everywhere**: profile writer, linkage, retention and the
  detail reader survive missing tables/columns.

## Verification

- `tests/research-profiles.test.ts` (20): profile writer (one row with
  all payloads + parser version + run link; same-batch supersede;
  all-empty row still lands; solutions 10×200 caps + name dedup +
  blank drops; oversized JSON → NULL not sliced; per-company
  isolation; fail-open; null run id) + linkage (email case/trim match;
  phone separator-insensitive match; this-run-only scoping; existing
  link never overwritten; superseded/non-matching/social skipped;
  cross-company isolation; null run id no-op; missing table fail-open)
  + prune (superseded-only, current immortal, missing table) + admin
  detail (linked facts with contact name, unlinked and superseded
  excluded; missing table fails open).
- `tests/data-retention.test.ts`: cron DATA_PRUNE metadata carries
  `research_profiles_superseded`; `"0"` keeps superseded profiles.
- Full suite **804/804 (65 files)** — 784 prior + 20 new, zero edits to
  existing assertions.
- `tsc --noEmit` clean.
- `wrangler deploy --dry-run`: 566.92 KiB / gzip 138.37 KiB (was
  560.67 / 137.16).

## Next

Phase 4 shipped in full (§6: stages 40–42 done). Follow-ups remain
gated on their design triggers: contact merge (§4.4, deferred),
campaign targeting over `research_signals`, cache-column deprecation
(§3.4 — never scheduled without an operator decision).
