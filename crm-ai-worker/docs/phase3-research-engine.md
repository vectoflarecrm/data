# Phase 3 — Research Engine: design

Status: Phase 3 shipped — Stage 36 (`research_sources`,
docs/stages/stage-36-research-sources.md), Stage 37 (`research_facts`,
docs/stages/stage-37-research-facts.md) and Stage 38 (cutover + blob
deprecation, docs/stages/stage-38-blob-deprecation.md) implemented. Same
rules as Security V2 (additive migrations, fail-open provenance, every
stage green on the full suite before commit).

Source requirements: 建议.txt §十三 (P2 schema), §十四 (evidence upgrade),
§二十 (Phase 3 — Research Engine), §二十一 (Phase 4 outlook), §二十二
(staged, never wholesale). What §十四 asked for is already live — Security V2
Stage 14 (evidence v2: `research_runs` + versioned `evidence` with
`research_run_id`/`source_id`/`source_hash`/`content_hash`/`parser_version`/
`model_name`/`model_version`, append-with-supersede) and Stage 15 (score
separation). This design covers what actually remains.

## 1. Current state (precise)

```
customers (wide table, 60+ columns)
  ├── identity + person contact + AI profile + outreach + scoring
  └── full_research_text          ← RAW crawl blob, ≤ 50 000 chars, concatenated
                                     as "=== 主网站内容 === / === 搜索结果 === / …",
                                     OVERWRITTEN on every fresh research pass

research_runs   (Stage 14)  one row per attempt: id, customer_id(company_id),
                            status, started_at/completed_at, parser_version,
                            model_name, model_version, error
evidence        (Stage 14)  versioned field-level facts: field_name/field_value/
                            source_url/source_type/evidence_text/confidence +
                            full provenance + is_current supersede chain
contacts        (Stage 17)  deduped person rows per company
```

Write path (cron-only `processCustomer`, `src/index.ts`): `startResearchRun`
→ fetch main site (Firecrawl fallback) → verify socials → search
(Tavily→Exa→Searlo→DDG) → fetch additional sources → **three text segments
exist as separate variables here** (`pageText`, `googleResults`,
`additionalText`) → concatenated into `researchContext` → single
`UPDATE customers SET full_research_text` → clean → AI analysis → analysis
fields to `customers` + `appendFieldEvidence` (atomic supersede+insert).

Reuse path: `claimCustomers` returns `full_research_text`; a retry with
≥ 500 saved chars skips the paid steps (search credits are the scarcest
resource) and re-mines facts from the saved text.

Panel: customer detail exposes `full_research_text` as an editable textarea
(`admin.ts` field config `完整研究文本`).

Retention (Stage 31): `research_runs` pruned beyond `DATA_RETENTION_DAYS`;
`evidence` pruned **superseded half only** (`is_current = 0`); live chains
survive forever.

## 2. The gaps this phase closes

1. **Raw sources are not preserved per-source.** One blob, overwritten per
   fresh pass: the previous crawl's raw text is lost (evidence keeps the
   extracted facts, not the raw pages), and there is no per-source registry
   (which URL, fetched when, content hash of what exactly). Audit §十三:
   research_runs → source / fetched_at / content_hash / raw_text /
   parser_version; §十四: answer "this email was extracted when, from which
   page".
2. **`full_research_text` lives in `customers`** (§十三: should not
   permanently live there) — 50 KB blobs inside the table every admin query
   touches, and re-research overwrites history.
3. **Rule-mined contact facts bypass evidence.** `extractContactEvidence`
   emails/phones/socials (deterministic, pre-AI) never become evidence/fact
   rows — they exist only inside the blob and the facts block fed to the
   prompt. For Phase 4 (fact extraction → entity resolution → persona →
   signals → strategy) there is no uniform facts substrate.

## 3. Target model

```sql
-- Per-run raw source registry. Same key style and supersede pattern as
-- evidence (customer_id = customers.company_id TEXT; is_current flips to 0
-- when a newer run writes its sources; atomic batch per write).
CREATE TABLE IF NOT EXISTS research_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  research_run_id TEXT,          -- null when the run row could not be created (fail-open)
  customer_id TEXT NOT NULL,
  source_type TEXT NOT NULL,     -- 'website' | 'search' | 'additional' | 'backfill'
  source_url TEXT,               -- main-site URL for 'website'; null for aggregate segments
  raw_text TEXT,                 -- per-segment cap (see §5)
  content_hash TEXT,             -- sha256-16 of raw_text, same helper as evidence
  parser_version TEXT,
  fetched_at TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1,
  valid_until TEXT
);
CREATE INDEX IF NOT EXISTS idx_research_sources_customer ON research_sources(customer_id, is_current);
CREATE INDEX IF NOT EXISTS idx_research_sources_run ON research_sources(research_run_id);
```

Stage 37 adds `research_facts` (typed fact rows for the Phase 4 substrate —
rule-mined contact facts first, linked to the evidence rows that cite
them). Its grain and promotion rules get their own section in the Stage 37
report; deliberately not fixed here to avoid over-designing ahead of the
first consumer.

`customers.full_research_text` is **not dropped** (SQLite DROP COLUMN on a
legacy table = another rebuild; the blob stays as a deprecated cache):
Stage 36 keeps dual-writing it, Stage 38 stops writing it, and the panel
switches to the sources view. Values already stored stay for rollback until
an explicit cleanup decision later.

## 4. Staged plan

**Stage 36 — `research_sources` (raw layer).**
- New table (schema.sql + `migrations/0020_research_sources.sql` change
  record; fresh installs get it from schema.sql, no CI ALTER needed).
- `src/research-run.ts`: `appendResearchSources(env, { companyId, runId,
  provenance, sources, now })` — same fail-open + atomic-batch pattern as
  `appendFieldEvidence` (supersede UPDATE + INSERTs in one D1 batch).
- `processCustomer`: capture the three segments before concatenation and
  write them as source rows. **Dual-write**: the existing
  `full_research_text` UPDATE stays (reuse path and panel unchanged →
  zero-risk additive stage).
- Backfill (CI step, idempotent pure SQL): for every customer with a
  non-empty `full_research_text` and no backfill run, synthesize
  `research_runs` row (deterministic id `backfill-<customer.id>`,
  `parser_version = 'backfill-v1'`) + one `research_sources` row
  (`source_type = 'backfill'`). Deterministic ids make re-runs no-ops;
  ~2 rows per customer stays inside the free-plan `rows_written` budget.
- Retention: `src/data-retention.ts` extends the Stage 31 policy —
  superseded sources (`is_current = 0`) prune on the same
  `DATA_RETENTION_DAYS` horizon; live sources survive like live evidence.
- Tests: append/supersede atomicity (real node:sqlite + D1 batch), reuse
  path unaffected, backfill SQL idempotence (run twice → same rows),
  retention horizon, fail-open on missing table.

**Stage 37 — `research_facts` (substrate).** Implemented as designed minus
one move (below): rule-mined contact facts (email/phone/whatsapp/social)
become typed rows — one per distinct `(fact_type, fact_value)` per run,
first-seen segment as `source_type`, repeats aggregated into
`occurrence_count`, mined from the same budget-capped segments saved to
`research_sources`. Customers researched before the stage are gap-filled
lazily: the next reuse pass writes facts from the saved text
(`source_type = 'backfill'`) when `hasCurrentResearchFacts` is false — no
one-time backfill migration. *Amendment: "the reuse path re-mines from
research_sources instead of the blob" moved to Stage 38 — the reuse path
and the panel edit handler are coupled (a manual `full_research_text` edit
must not be shadowed by stale source rows), so the whole cutover lands as
one stage.*

**Stage 38 — cutover + blob deprecation.** Implemented as designed minus
one concern (below): the reuse path and the admin detail view read the
current `research_sources` set via `readSavedResearchText`
(`buildSavedResearchText` rebuilds the exact legacy `=== ... ===` blob
format, since `cleanResearchContextForAi` splits on those headers), the
blob stays as the pre-Stage-36 fallback, and the fresh path no longer
writes `full_research_text` (the dual-write from Stage 36 ends here). The
panel field is now `readonly` — honest, because the PATCH whitelist never
accepted it. *Amendment: the planned "manual source row on panel edit"
was dropped — `updateCustomer`'s editable whitelist never contained
`full_research_text`, so manual edits have never persisted and cannot be
shadowed by source rows. No `manual` rows exist; the reader still passes
them through verbatim (single-snapshot semantics) should that ever
change. Column retained (deprecated cache, documented in schema.sql).*

**Normalization (companies / people / company_domains / …) — Phase 3b,
gated.** Audit §十三 lists the full split; §二十二 warns against wholesale
rewrites, and this split touches every consumer (admin API, panel, outreach
generation, campaigns, research). It is **not scheduled** here: it gets its
own design review with a concrete consumer-by-consumer cutover plan once
the research engine lands. The incremental path the audit itself endorses
(contacts, evidence, research_runs, outreach_emails — already split) plus
research_sources/facts is the safe trajectory.

**Phase 4 (outlook only).** With a uniform facts substrate, the pipeline
审计 §二十一 sketches (entity resolution → company profile → persona →
buying signal → lead score → outreach strategy) become consumers of
`research_facts`/`evidence` rather than a rewrite of the research pass.
Design comes after Phase 3 lands.

## 5. Pinned decisions

- **Per-segment granularity at the existing seams only**: `pageText` /
  `googleResults` / `additionalText` are already separate variables;
  Stage 36 writes ≤ 3 rows per run. Splitting `additionalText` per-URL
  requires refactoring `fetchAdditionalSources` — deferred until a
  consumer needs per-URL raw history (§35: no unmotivated refactors).
- **Caps**: each segment capped at its existing practical size; total raw
  per run mirrors today's 50 000-char research cap. No unbounded growth.
- **Fail-open, batch-atomic, versioned** — identical semantics to
  `appendFieldEvidence`; provenance is an auditability layer and must never
  fail research that already spent search credits.
- **Retention parity**: new tables inherit the Stage 31 horizons from day
  one (no unbounded raw-text bloat — the reason §十三 exists).
- **No FK constraints on new tables**: `research_sources.research_run_id`
  references a run that may not exist (fail-open start); `customer_id` is
  the TEXT company key used by evidence/contacts today. Consistency is
  structural (same keys), not declared — same as the existing research
  tables. Revisit only if Phase 3b normalization re-keys the model.
