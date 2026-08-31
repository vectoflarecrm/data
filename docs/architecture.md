# Architecture

Project: **Global Watersports B2B Intelligence Database**

Phase 0 architecture analysis. Records decisions, constraints, module boundaries, and responsibilities before implementation.

## 1. Goal

A production-oriented, local-first B2B customer intelligence platform for the global watersports industry (SUP, inflatable SUP, kayak, inflatable boat, RIB, paddles, pumps, life jackets, water toys, marine accessories).

The system ingests an existing customer CSV, enriches it incrementally from public business information, collects evidence with confidence scores, runs a database-backed research queue, and feeds a future AI email outreach pipeline.

## 2. Non-negotiable constraints

- **No Redis**: PostgreSQL is the only persistent store and the task queue.
- **Local-first**: Linux/macOS/WSL/Codespaces. No cloud required for V1.
- **Evidence-first**: every discovered fact keeps source URL, source type, evidence text, confidence, discovered/verified timestamps.
- **Public information only**: no private WhatsApp probing, no personal data harvesting, no bypassing auth.
- **Idempotent**: re-running a research task must not duplicate data.
- **Provider decoupling**: crawler and AI providers sit behind Protocol abstractions.
- **Never fabricate**: no invented emails. UNKNOWN / INFERRED / LOW are first-class values.

## 3. Layered model

Four layers so future AI swaps never require a data-model redesign:

1. **Identity** — companies, contacts, websites, countries.
2. **Intelligence** — products, brands, business model, purchasing roles, competitors.
3. **Evidence** — sources, URLs, evidence text, confidence, verification, research history.
4. **Engagement** — (future) email, LinkedIn, WhatsApp, follow/contact/open/reply.

## 4. Tech stack

- Python 3.12+
- FastAPI + Pydantic v2
- SQLAlchemy 2.x (async) + asyncpg
- Alembic migrations
- Crawl4AI (primary crawler) + httpx (fallback) + Playwright (optional)
- Gemini CLI (external provider via subprocess), behind an `AIProvider` protocol
- pytest / pytest-asyncio / ruff / mypy

## 5. Module boundaries

```
src/app/
  core/       config, logging, enums
  db/         session, base, models
  schemas/    Pydantic DTOs & AI result schemas
  repositories/  data access
  services/   business logic (normalization, verification)
  research/   engine, queue, scheduler, policies, workers
  crawlers/   base Protocol + implementations
  ai/         base Protocol, gemini_cli, validators, prompts
  enrichment/ company/contacts/products/social/verification steps
  scoring/    lead_score, rules, completeness, priority
  import_export/  csv_importer, csv_exporter
  api/        FastAPI routes + dependencies
```

Dependency rule: `research` depends on `crawlers` and `ai` *interfaces*, never on a concrete provider. `repositories` are the only layer that touches SQLAlchemy ORM objects outside `db/models`.

## 6. Research pipeline

```
Company
  -> Website discovery (if missing)
  -> Website crawl (about/products/brands/contact/team/news/catalog)
  -> Evidence extraction
  -> AI analysis (validated JSON)
  -> Structured enrichment
  -> Verification
  -> Lead score
  -> Schedule next research
```

## 7. Concurrency model

- Local worker processes claim rows from `research_tasks` using `SELECT ... FOR UPDATE SKIP LOCKED`.
- Task row carries `worker_id`, `status`, `attempts`, `next_retry_at`.
- A worker that dies mid-task leaves the task RUNNING with a stale `worker_id`; a sweeper reclaims tasks older than a staleness window.
- No duplicate processing: only the task owner transitions RUNNING to COMPLETED.

## 8. Idempotency keys

- Company: `normalized_domain` unique.
- Brand: `name` unique.
- Company-brand: `(company_id, brand_id, relationship_type)` unique.
- Social account: `(company_id, platform, profile_url)` unique.
- Evidence: `content_hash` unique.
- Contact dedup: normalized full name + company; contact_methods unique on `(contact_id, method_type, normalized_value)`.

## 9. Scoring

- **Lead score** (deterministic 0-100, configurable weights): Product Fit 20, Company Fit 15, Market Fit 15, Purchasing Potential 20, Contact Quality 10, Growth Signals 10, Data Completeness 5, Recent Activity 5. Grades: 90+ A+, 80-89 A, 70-79 B, 60-69 C, below 60 D.
- **Data completeness score** (0-100): measures how much of the record is filled, independent of lead quality.
- **Research priority**: `lead_score*0.40 + data_gap*0.25 + buying_signal*0.20 + freshness*0.15`.

## 10. Research levels, statuses, scheduling

- Levels L0..L8 describe research depth achieved.
- Statuses: NEW, DISCOVERED, COMPANY_RESEARCHED, PRODUCT_RESEARCHED, CONTACT_RESEARCHED, CONTACT_VERIFIED, SOCIAL_RESEARCHED, WHATSAPP_RESEARCHED, FULLY_ENRICHED, NEEDS_RESEARCH, RESEARCH_FAILED.
- Scheduling defaults: normal 90d, potential/A lead 30d, A+ 14d, recent signal 7d, major change immediate.
- Retry: exponential backoff 5min -> 30min -> 2h -> 12h -> FAILED (configurable). Failure categories: NETWORK_ERROR, TIMEOUT, HTTP_ERROR, BLOCKED, INVALID_DATA, AI_PROVIDER_ERROR, PARSER_ERROR, DATABASE_ERROR.

## 11. Security & compliance

- Environment-based configuration; `.env.example` only, no secrets in source control.
- CSV upload size-limited; no arbitrary command execution through the API.
- Gemini CLI invoked as an external subprocess with fixed argv; user-provided input travels as prompt data, never as shell text.
- Source priority for conflicts: official website > official social > catalog/PDF > professional network > industry publication > directory > search snippet.

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Gemini returns malformed/partial JSON | Strict Pydantic schemas, JSON extraction, clear provider error, never persist unvalidated output. |
| Websites disappear | content_hash dedup, incremental research, freshness-based re-scheduling, graceful failures. |
| Same company under different names | `normalized_domain` identity + merge/duplicate report for human review. |
| Contacts move companies | Contacts belong to a company; evidence carries discovered date; conflict store. |
| AI hallucination | UNKNOWN/INFERRED/CONFLICTING markers; LOW confidence; no fabricated emails. |
| Multi-worker duplicate processing | FOR UPDATE SKIP LOCKED + worker_id ownership + sweeper. |
| Scale to 10k companies | Indexes, pagination, batch processing, normalized identifiers, incremental research. |

## 13. Deviations vs original spec

- Outreach/campaign tables are reserved in schema but not wired to API or sending systems in V1.
- `products` stays a shared catalog table (category/subcategory enums + free-text name); company-product links are expressed via evidence and `company_brands` where applicable.
- Company roles are booleans simultaneously mirrored into a `company_type` array; a single primary type is not forced.
- PostgreSQL only for V1 (no SQLite backend), per execution spec.