# Research Engine

The research engine orchestrates enrichment per company through the research queue.

## Pipeline

```
Company -> Website discovery -> Web crawl -> Evidence extraction -> AI analysis -> Enrichment -> Verification -> Lead score -> Schedule next
```

## Research levels

- L0 raw company record
- L1 company identity verified
- L2 company profile researched
- L3 products and brands researched
- L4 decision maker discovered
- L5 business contact info researched
- L6 social + communication channels researched
- L7 lead intelligence completed
- L8 continuous monitoring

## Task types

COMPANY_DISCOVERY, COMPANY_RESEARCH, PRODUCT_RESEARCH, BRAND_RESEARCH, CONTACT_DISCOVERY, EMAIL_DISCOVERY, PHONE_DISCOVERY, WHATSAPP_DISCOVERY, SOCIAL_DISCOVERY, VERIFICATION, BUYING_SIGNAL_RESEARCH, LEAD_SCORING, FULL_ENRICHMENT.

## Incremental research

Never rerun everything. A company with HIGH company/products confidence but UNKNOWN contact and email gets only CONTACT_DISCOVERY + EMAIL_DISCOVERY tasks.

## Crawling policy

Prioritize homepage, about, products, brands, contact, team, news, catalog, relevant PDFs. Do not crawl the entire internet per company. Limits: max_pages_per_company, max_depth, request_delay, timeout, max_retries (conservative defaults). Respect robots.txt where applicable.

## Scheduling

Normal 90d, potential/A lead 30d, A+ 14d, recent buying signal 7d, major change immediate. All configurable in `research.policies`.

## Retry policy

Exponential backoff: 1->5m, 2->30m, 3->2h, 4->12h, 5->FAILED. Error categories: NETWORK_ERROR, TIMEOUT, HTTP_ERROR, BLOCKED, INVALID_DATA, AI_PROVIDER_ERROR, PARSER_ERROR, DATABASE_ERROR.

## Provider wiring (Phase 8)

- `src/app/research/register.py::register_all()` binds each `TaskType` to a `ResearchPipeline` step. Handlers resolve crawler/AI lazily via `src/app/research/providers.py` (`get_research_crawler` / `get_research_ai`), so tests can inject mocks with `configure_research_providers(crawler=..., ai=...)` before any task runs.
- `register_all()` is idempotent and is invoked from app startup (`main.py`), the worker CLI default executor, and `cli research-run`.
- `FULL_ENRICHMENT` crawls once per company and reuses the shared `CrawlSessionResult` across every step (company, product, brand, contact, email, phone, WhatsApp, social, verification, buying signals) through a per-pipeline crawl cache, then marks the company `L8 / FULLY_ENRICHED`.
- Steps never fabricate: emails/phones/WhatsApp numbers come only from crawled text or explicit links; AI output is validated against strict schemas (`extra="forbid"`) before persistence; every fact is recorded as evidence first.

## Deterministic lead scoring (Phase 10)

- `src/app/enrichment/scoring.py::describe_company()` computes eight 0-100 component scores from the database only (no AI): `product_fit`, `company_fit`, `market_fit`, `purchasing_potential`, `contact_quality`, `growth_signals`, `data_completeness`, `recent_activity`.
- `lead_score_result()` blends them with the configurable `settings.scoring_weights` and assigns a letter grade (A >= 85, B >= 70, C >= 50, D >= 35, F).
- `apply_lead_score()` upserts the `lead_scores` row (one per company) and mirrors `company.lead_score` for ordering. `target_priority_hours()` turns the total into a re-research cadence hint (14/30/45/90 day tiers).
- `LEAD_SCORING` is a registered research task (`pipeline.run_lead_scoring`) and completes with the score + grade in its summary.

## AI context (Phase 11)

- `src/app/enrichment/ai_context.py` derives four context objects entirely from the database (deterministic, never fabricated): company intelligence, contact intelligence (per contact), buying-signal summary, and an outreach-preparation object (JSON: best contact, verified channel, subject, talking points, signal context, cadence hint).
- `generate_company_contexts()` persists them into `ai_contexts` via `AIContextRepository.replace()` — each write deletes the prior row for that scope first, so contexts are always regenerable and never accumulate duplicates.
- `use_ai=True` (API `POST /companies/{id}/context/rebuild`, CLI `context-rebuild --ai`) optionally tightens the prose with the AI provider, falling back to the deterministic text on any error; the outreach JSON is never touched.
- Regeneration surfaces: `GET /companies/{id}/context`, `POST /companies/{id}/context/rebuild`, CLI `context-rebuild [--company-id ...] [--ai]`.

## Re-crawl scheduling (Phase 9 extras)

- `apply_lead_score()` also sets `company.next_research_at` = now + the cadence from the lead grade (`target_priority_hours`: A+ 14d, A 30d, B 45d, else 90d). The existing queue claim logic then picks up overdue companies for re-research with no extra tooling.

## End-to-end pipeline (Phase 12)

- `sample_customer_database.csv` at repo root: 25 rows (23 unique companies + 2 duplicate rows that must merge, one by domain, one by name).
- `tests/integration/test_e2e_customer_database.py` runs the whole chain against a fresh schema: CSV import → normalization (23 companies, dedupe on) → queue FULL_ENRICHMENT + LEAD_SCORING for each → mock crawler + mock AI → evidence → contacts → social → lead score → AI context regeneration → CSV export, asserting no fabricated data and merged rows never resurfaces as duplicates.

## Conflict resolution (Phase 9)

- `src/app/enrichment/conflict.py::ConflictDetector` decides whether an incoming fact may overwrite existing evidence. Standing = `(source_priority, confidence)` tuples; `SourceType` ranks official contact/team pages highest, imports lowest.
- Outcomes: `ACCEPT` (no prior evidence, or same value already backed), `CONFLICT_SKIP` (existing dominates — never overwritten), `CONFLICT_OVERWRITE` (incoming dominates), `CONFLICTING` (equal standing, different values — surfaced, not stored silently).
- Every conflict is persisted as a `conflict.<field>` evidence row so the case is auditable and can be re-reviewed.
- The pipeline consults the detector before recording contact methods (AI and regex) — a LOW-confidence scrape can never silently replace a VERIFIED business email. `CompanyResearchUpdater.apply_type` only ever adds known type flags; it never clears high-confidence type info.