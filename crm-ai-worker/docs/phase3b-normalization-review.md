# Phase 3b — Schema Normalization: design review

Status: **Signed off and implemented.** Operator approved the §4 verdicts
and Stage 39 on 2026-10-06 (including the assumption that the
list/sample APIs have no consumer beyond the bundled panel). Stage 39
landed as docs/stages/stage-39-read-path-slimming.md; the §4
reject/defer verdicts are now pinned decisions (§6). Trigger history:
`docs/phase3-research-engine.md` §4 gated this review on the research
engine landing — Stage 38, commit 9292f75.

Source requirements: 建议.txt §十三 (P2 schema split), §二十二 (staged,
never wholesale), 架构.txt §35 (no cosmetic refactors), Phase 3 design doc
§4/§5 (gating + pinned decisions).

## 1. What §十三 asked for vs what exists today

The audit's target list, checked against `schema.sql` and writers found by
grep (2026-10-06, HEAD 9292f75):

| Audit target | Status | Evidence |
| --- | --- | --- |
| `companies` | **exists in substance** | `customers` is already one row per company (`company_id` TEXT unique identity). A separate `companies` table would be a rename. |
| `people` | **exists** | `contacts` (research-mined, written by the pipeline at `index.ts:2262`). The 11 embedded person columns on `customers` are a separate problem — see §2. |
| `company_domains` | not built | One `domain` + `normalized_domain` (indexed; CSV dedup at `admin.ts:973` is a single indexed lookup). No multi-domain research exists. |
| `company_socials` | not built | `social_accounts_verified` JSON (pipeline writes, `index.ts:2087`); `social_accounts` is dead (§2). No query searches by social. |
| `company_products` | not built | `products_services` (CSV) + `product_categories` (AI) — consumed as LIKE filters (`campaigns.ts:152-159`, `facets.ts:141`). A table would still need LIKE; no gain. |
| `company_evidence` | **exists** | `evidence` (Security V2 Stage 14, versioned + is_current). |
| `research_runs` / `research_sources` / `research_facts` | **done** | Stage 14 / 36 / 37. |
| `lead_scores` | not split | `lead_score` + `data_completeness_score` on `customers`; Stage 15 pinned the separation as semantic, not physical. |
| `outreach_profiles` | not split | `company_profile` / `outreach_context` / `buying_signals` / `personas_and_solutions` JSON columns, written once per research run (`index.ts:2302`), read by outreach prompts + panel. |
| `outreach_emails` / `campaigns` / `campaign_members` / `send_attempts` | **exist** | `outreach_emails`, `outreach_campaigns`, `outreach_campaign_members`, `gmail_send_log`. |

**Nine of the audit's thirteen targets are live or already shipped.** The
audit's core pain — `full_research_text` permanently stuffed into
`customers` — was solved by Phase 3 Stage 38 (deprecated, no writers,
sources-first reads).

## 2. Column inventory with writer/reader evidence

`customers` has 58 columns. Grouped by concern, with every writer found:

| Group | Columns | Writers | Readers |
| --- | --- | --- | --- |
| Identity & firmographics (27) | id, company_id, display_id, domain, normalized_domain, company_name, legal_name, trading_name, country, country_code, region, city, street_address, zip_city, postal_code, business_tag, industry, company_type, business_model, founded_year, employee_range, description, target_markets, products_services, is_manufacturer…is_oem (8), source_import_id, updated_at | CSV import (`admin.ts:997`, 9 cols); panel PATCH (domain only, `admin.ts:1070` whitelist) | admin list/detail/sample, outreach prompts, campaign segments, facets, dedup |
| Embedded person (11) | first_name, last_name, full_name, title, department, linkedin_url, tel, email, cellphone, whatsapp | **only `email`** (CSV import). The other 10 have **no writer in any code path** — verified by grep across `src/`. | panel detail display; outreach prompt (first_name/last_name/title — always NULL today); list row fallback `c.email \|\| c.cellphone` (`admin.ts:3425`) |
| Social (2) | social_accounts, social_accounts_verified | `social_accounts`: **no writer — dead column**. `_verified`: pipeline (`index.ts:2087`). | panel detail (social_accounts renders contact list; verified renders the badge row) |
| Research raw (1) | full_research_text | none since Stage 38 | Stage 38 fallback only (`readSavedResearchText`) |
| AI profile (8) | customer_segment, product_categories, company_size, geographic_coverage, personas_and_solutions, company_profile, outreach_context, buying_signals | research AI completed UPDATE (`index.ts:2302`); PATCH whitelist (customer_segment, personas_and_solutions) | outreach prompts, campaign segments, facets, panel |
| Scoring & lifecycle (5) | status, lead_score, data_completeness_score, remarks, updated_at | pipeline (status/scores/remarks), claim/requeue (status), PATCH (status, remarks) | list/sample ORDER BY lead_score, segments, detail |

The embedded-person finding is decisive for the `people` question: there is
no person data on `customers` to migrate — only `email` (the import-time
contact). Real people data already lives in `contacts`.

## 3. Consumer-by-consumer cutover inventory

Every consumer of `customers`, what it touches, and what a physical split
would cost it:

| # | Consumer | Touchpoints | Split cost |
| --- | --- | --- | --- |
| 1 | Research pipeline (`src/index.ts`) | claim RETURNING (1739, 11 cols); stale recovery (1722); social_accounts_verified UPDATE (2087); outcome UPDATEs (2209/2302/2326/2345); contacts INSERT (2262) | Every outcome UPDATE becomes multi-table; claim needs JOINs. Highest-risk consumer (cron, credits). |
| 2 | Admin list (`admin.ts:885`) | SELECT all 58 cols × limit 20-100 | Ships the deprecated blob + dead columns per row; panel list uses **10 fields** (3425). No split needed to fix this — see §5. |
| 3 | Admin detail (`admin.ts:847` + 2519) | all cols + Stage 38 reconstruction + contacts + evidence | Would need multi-table assembly; response shape is panel contract. |
| 4 | Admin sample (`admin.ts:1069`) | top-20 ORDER BY lead_score, all cols | Same blob-shipping issue as list. |
| 5 | updateCustomer (`admin.ts:1118`) | whitelist 5 cols, RETURNING all | RETURNING across split tables needs reassembly. |
| 6 | CSV import + dedup (`admin.ts:973-1008`) | INSERT 9 cols; dedup on normalized_domain/company_name | Identity split adds a second INSERT + FK choreography in a 50-statement batch loop. |
| 7 | Outreach generation (`src/outreach.ts:484/573/645`) | 16-col list incl. 3 dead person cols | Prompt input assembly needs JOIN if person cols move. |
| 8 | Campaign segments (`src/campaigns.ts:133-179`) | WHERE on status/email/country/customer_segment/product_categories/products_services/company_name/description/business_tag/lead_score/id | Filter builder is shared between 海选 and campaign preview; every split column adds a JOIN to both. |
| 9 | Facets (`src/facets.ts:132/141/290`) | GROUP BY country/customer_segment/product_categories; keyword mining on company_name/description/business_tag | Same JOIN fan-out. |
| 10 | Data retention (`src/data-retention.ts`) | none on customers (imports pruned; customers survive) | none. |

## 4. Verdict per remaining split

Applying §二十二 (staged, never wholesale) and §35 (no unmotivated
refactors) to the evidence above:

- **`companies` — REJECT (rename-only).** `customers` already is the
  companies table. A split would touch all 10 consumers for zero new
  capability.
- **`people` — RESOLVED WITHOUT SPLIT.** `contacts` is the people table.
  The 10 embedded person columns have no writers: nothing to migrate.
  Proposal: deprecate them in `schema.sql` and exit them from read paths
  (§5). `customers.email` STAYS: it is the import-time contact, hot in the
  `has_email` segment filter and outreach prompts.
- **`company_domains` — DEFER (no consumer).** No multi-domain research
  exists; dedup is a single indexed lookup.
- **`company_socials` — DEFER (no consumer).** 1:1 JSON, one writer, no
  social-based queries.
- **`company_products` — DEFER (no gain).** Both product columns are LIKE
  filter inputs; a normalized table would still need LIKE.
- **`lead_scores` — REJECT as a table.** Both scores are ORDER BY-hot
  (`admin.ts:1069`, `campaigns.ts:481`). A JOIN on the hottest sort path
  for zero modeling gain. Stage 15's separation is semantic.
- **`outreach_profiles` — DEFER with trigger.** 1:1 JSON columns with one
  writer. Revisit when Phase 4 wants per-run versioned profiles or
  per-brand profiles — that is the first real consumer.

## 5. The one real cost found → proposed Stage 39 (read-path slimming)

Evidence: the list, sample and PATCH-RETURNING queries ship the deprecated
blob plus dead columns on every row — a 50-row list page can ship
megabytes of frozen blobs, and the panel list uses 10 fields (`admin.ts:3425`).
This is fixable with **zero schema change and zero data change**:

- Split `CUSTOMER_COLUMNS` into a list/sample list (drops
  `full_research_text`, `social_accounts`, and the 9 never-written person
  columns; keeps `email`/`cellphone` for the list row) and a detail list
  (unchanged — the detail endpoint needs the blob as the Stage 38 fallback
  source and keeps its response shape).
- `schema.sql`: deprecation comments on the dead columns (same treatment
  `full_research_text` got in Stage 38).
- Tests: list API response shape (blob/dead fields absent, live fields
  present); detail response unchanged (already pinned by
  `tests/research-text.test.ts`).
- No DROP, ever, without a forcing migration — SQLite DROP COLUMN
  rebuilds the table; the columns cost nothing once out of the read paths.

## 6. Proposed pinned decisions (for sign-off)

1. **No physical table split in Phase 3b.** Rationale: §4 verdicts.
2. `customers` remains the companies table; `contacts` remains the people
   table.
3. `customers.email` stays put (import-time contact; segment filter input).
4. Dead columns: deprecate in schema + exit read paths; never DROP without
   a forcing migration.
5. Revisit triggers (documented, not scheduled): multi-domain research →
   `company_domains`; social-based search → `company_socials`; per-run /
   per-brand profiles → `outreach_profiles` (likely Phase 4).

## 7. Review checklist — resolved

- [x] Stage 39 (read-path slimming) — **approved** (2026-10-06), implemented
      in docs/stages/stage-39-read-path-slimming.md.
- [x] §4 verdicts (reject/defer per split) — confirmed as written; now
      pinned (§6).
- [x] Assumption check: the admin list/sample APIs are consumed only by
      the bundled panel — confirmed by the operator (no external
      consumer reads `full_research_text` or the dead person columns from
      LIST responses).
- [ ] Phase 4 profile versioning pulling `outreach_profiles` forward —
      open, decided at Phase 4 design time.
