# Database Schema

**Engine:** PostgreSQL 16 (container `watersports_postgres`, port 5432)
**Connection:** `postgresql+asyncpg://watersports:watersports@localhost:5432/watersports`
**Migration head:** `92a389f336cf` (add ai contexts)

This document is generated from live database introspection
(`information_schema` / SQLAlchemy `inspect`). Source of truth for the schema is
`src/app/db/models/`; migrations live in `alembic/versions/`. Discard-mode notes:
`research_evidence.content_hash` is NOT NULL; `ix_companies_normalized_domain`
is unique.

## Tables

| # | Table | Rows | Columns | Indexes | Purpose |
|---|-------|------|---------|---------|---------|
| 1 | companies | 25 | 38 | 6 | Core B2B company record + enrichment flags |
| 2 | contacts | 75 | 18 | 4 | People at a company (buyers/decision makers) |
| 3 | contact_methods | 155 | 15 | 4 | Email/phone/WhatsApp/address per contact |
| 4 | social_accounts | 40 | 16 | 5 | LinkedIn/Instagram/Facebook profiles, personal or business |
| 5 | research_evidence | 559 | 15 | 7 | Every claim with source URL, hash, confidence |
| 6 | research_tasks | 50 | 16 | 4 | PG-backed async work queue w/ retry |
| 7 | products | 17 | 7 | 4 | Normalized product catalog |
| 8 | brands | 8 | 5 | 3 | Normalized brand catalog |
| 9 | company_brands | 33 | 7 | 4 | Link company↔brand + relationship type |
| 10 | company_events | 50 | 9 | 2 | Business events (new store, catalog release…) |
| 11 | lead_scores | 25 | 15 | 2 | Deterministic lead scoring result (1:1 company) |
| 12 | ai_contexts | 100 | 8 | 3 | Regenerable AI context packs per company |
| 13 | alembic_version | 1 | 1 | 0 | Migration bookkeeping |

---

## 1. `companies`

Central record. Every company starts as a CSV row or API POST; enrichment fills
profile fields, sets boolean type flags, level/status, and scores.

| Column | Type | Null | Notes |
|--------|------|------|-------|
| id | UUID | no | PK |
| company_name | VARCHAR(255) | no | |
| legal_name | VARCHAR(255) | yes | |
| trading_name | VARCHAR(255) | yes | |
| website | VARCHAR(500) | yes | |
| normalized_domain | VARCHAR(255) | yes | **UNIQUE** — dedupe key |
| country | VARCHAR(100) | yes | |
| country_code | VARCHAR(2) | yes | ISO-3166-1 alpha-2 |
| region | VARCHAR(150) | yes | |
| city | VARCHAR(150) | yes | |
| address | VARCHAR(500) | yes | |
| postal_code | VARCHAR(50) | yes | |
| industry | VARCHAR(150) | yes | |
| company_type | ARRAY | yes | e.g. `{DISTRIBUTOR,RETAILER}` |
| business_model | VARCHAR(255) | yes | |
| founded_year | INTEGER | yes | 4-digit year |
| employee_range | VARCHAR(50) | yes | e.g. `11-50` |
| description | TEXT | yes | |
| main_products_summary | TEXT | yes | |
| target_markets | ARRAY | yes | countries/regions |
| manufacturer | BOOLEAN | no | default false |
| importer | BOOLEAN | no | default false |
| distributor | BOOLEAN | no | default false |
| wholesaler | BOOLEAN | no | default false |
| retailer | BOOLEAN | no | default false |
| ecommerce | BOOLEAN | no | default false |
| rental | BOOLEAN | no | default false |
| oem | BOOLEAN | no | default false |
| company_status | VARCHAR(9) | no | Active/Inactive/Unknown |
| research_status | VARCHAR(19) | no | UNRESEARCHED/COMPLETE_PARTIAL/FULLY_ENRICHED… |
| research_level | VARCHAR(2) | no | L1–L8 |
| company_score | DOUBLE PRECISION | yes | data-completeness score |
| lead_score | DOUBLE PRECISION | yes | mirrored from lead_scores |
| ai_context | TEXT | yes | legacy free-form summary |
| last_researched_at | TIMESTAMP | yes | |
| next_research_at | TIMESTAMP | yes | re-crawl cadence from lead grade |
| created_at | TIMESTAMP | no | |
| updated_at | TIMESTAMP | yes | |

Indexes: `ix_companies_company_name`, `ix_companies_country_code`,
`ix_companies_id`, `ix_companies_lead_score`, `ix_companies_research_status`,
**unique** `ix_companies_normalized_domain`.

## 2. `contacts`

| Column | Type | Null | Notes |
|--------|------|------|-------|
| id | UUID | no | PK |
| company_id | UUID | no | FK → companies.id |
| first_name | VARCHAR(150) | yes | |
| last_name | VARCHAR(150) | yes | |
| full_name | VARCHAR(300) | no | |
| job_title | VARCHAR(255) | yes | |
| department | VARCHAR(150) | yes | |
| seniority | VARCHAR(9) | yes | C-Suite/Management/Staff |
| role_type | VARCHAR(18) | yes | PURCHASING/OPS/OWNER… |
| purchasing_role | VARCHAR(14) | yes | Economic/Technical/User |
| decision_power | VARCHAR(7) | yes | High/Medium/Low |
| linkedin_url | VARCHAR(500) | yes | |
| bio | TEXT | yes | |
| status | VARCHAR(12) | no | Lead/Warm/Active/Dead… |
| confidence | DOUBLE PRECISION | yes | 0–1 |
| last_verified_at | TIMESTAMP | yes | |
| created_at | TIMESTAMP | no | |
| updated_at | TIMESTAMP | yes | |

Indexes: `ix_contacts_company_id`, `ix_contacts_full_name`, `ix_contacts_id`,
`ix_contacts_purchasing_role`.

## 3. `contact_methods`

| Column | Type | Null | Notes |
|--------|------|------|-------|
| id | UUID | no | PK |
| contact_id | UUID | no | FK → contacts.id |
| company_id | UUID | no | FK → companies.id (denormalized) |
| method_type | VARCHAR(8) | no | EMAIL/PHONE/WHATSAPP/ADDRESS |
| value | VARCHAR(500) | no | |
| normalized_value | VARCHAR(500) | yes | dedupe/normalized form |
| is_primary | BOOLEAN | no | |
| is_business | BOOLEAN | no | business vs personal |
| public_or_private | VARCHAR(7) | no | PUBLIC/PRIVATE |
| verification_status | VARCHAR(11) | no | verified/derived/suspect |
| confidence | DOUBLE PRECISION | yes | 0–1 |
| source_evidence_id | UUID | yes | FK → research_evidence.id |
| verified_at | TIMESTAMP | yes | |
| created_at | TIMESTAMP | no | |
| updated_at | TIMESTAMP | yes | |

Indexes incl. **unique** `uq_contact_method_value`
(`contact_id, method_type, normalized_value`).

## 4. `social_accounts`

| Column | Type | Null | Notes |
|--------|------|------|-------|
| id | UUID | no | PK |
| company_id | UUID | no | FK → companies.id |
| contact_id | UUID | yes | FK → contacts.id |
| platform | VARCHAR(9) | no | LINKEDIN/INSTAGRAM/FACEBOOK |
| profile_url | VARCHAR(500) | yes | |
| username | VARCHAR(255) | yes | |
| display_name | VARCHAR(255) | yes | |
| business_or_personal | VARCHAR(8) | no | BUSINESS/PERSONAL |
| followers | INTEGER | yes | |
| activity_level | VARCHAR(9) | no | HIGH/MEDIUM/LOW/INACTIVE |
| verification_status | VARCHAR(11) | no | |
| confidence | DOUBLE PRECISION | yes | 0–1 |
| source_evidence_id | UUID | yes | FK → research_evidence.id |
| last_checked_at | TIMESTAMP | yes | |
| created_at | TIMESTAMP | no | |
| updated_at | TIMESTAMP | yes | |

Indexes incl. **unique** `uq_social_profile`
(`company_id, platform, profile_url`).

## 5. `research_evidence`

| Column | Type | Null | Notes |
|--------|------|------|-------|
| id | UUID | no | PK |
| company_id | UUID | no | FK → companies.id |
| contact_id | UUID | yes | FK → contacts.id |
| field_name | VARCHAR(150) | no | e.g. `description`, `email.value` |
| value | TEXT | yes | |
| source_url | VARCHAR(1000) | yes | |
| source_domain | VARCHAR(255) | yes | |
| source_type | VARCHAR(21) | no | OFFICIAL_WEBSITE/BROCHURE/EBAY… |
| evidence_text | TEXT | yes | quote supporting the claim |
| extraction_method | VARCHAR(100) | yes | ai/csv/official |
| confidence | VARCHAR(7) | no | HIGH/MEDIUM/LOW |
| discovered_at | TIMESTAMP | no | |
| verified_at | TIMESTAMP | yes | |
| content_hash | VARCHAR(64) | **no** | **UNIQUE** `uq_evidence_hash` — claim dedupe |
| created_at | TIMESTAMP | no | |

## 6. `research_tasks`

PG-backed async worker queue. Claims via
`FOR UPDATE SKIP LOCKED` on `(status, priority, scheduled_at)` (`ix_research_claim`).

| Column | Type | Null | Notes |
|--------|------|------|-------|
| id | UUID | no | PK |
| company_id | UUID | no | FK → companies.id |
| task_type | VARCHAR(22) | no | FULL_ENRICHMENT/COMPANY/PRODUCT/CONTACT/SOCIAL/LEAD_SCORING |
| priority | INTEGER | no | higher = sooner |
| status | VARCHAR(9) | no | QUEUED/CLAIMED/COMPLETED/FAILED |
| attempts | INTEGER | no | |
| max_attempts | INTEGER | no | retry cap |
| scheduled_at | TIMESTAMP | no | |
| started_at | TIMESTAMP | yes | |
| completed_at | TIMESTAMP | yes | |
| next_retry_at | TIMESTAMP | yes | backoff |
| worker_id | VARCHAR(100) | yes | lease holder |
| error_message | TEXT | yes | |
| result_summary | TEXT | yes | |
| created_at | TIMESTAMP | no | |
| updated_at | TIMESTAMP | yes | |

## 7. `products` / 8. `brands`

Flat normalized catalogs. `name` is **unique** (`uq_product_name`/`uq_brand_name`).

products: name, category (SUP/KAYAK/WAKE…), subcategory, description, timestamps.
brands: name, website, timestamps.

## 9. `company_brands`

| Column | Type | Null | Notes |
|--------|------|------|-------|
| id | UUID | no | PK |
| company_id | UUID | no | FK → companies.id |
| brand_id | UUID | no | FK → brands.id |
| relationship_type | VARCHAR(11) | no | MANUFACTURES/DISTRIBUTES/DECLARES |
| source_evidence_id | UUID | yes | FK → research_evidence.id |
| created_at / updated_at | TIMESTAMP | – | |

**Unique** `uq_company_brand_rel` (`company_id, brand_id, relationship_type`).

## 10. `company_events`

| Column | Type | Null | Notes |
|--------|------|------|-------|
| id | UUID | no | PK |
| company_id | UUID | no | FK → companies.id |
| event_type | VARCHAR(26) | no | NEW_STORE/CATALOG_RELEASE/NEW_RESELLER/… |
| event_date | DATE | yes | |
| title | VARCHAR(255) | yes | |
| description | TEXT | yes | |
| importance | VARCHAR(8) | no | HIGH/MEDIUM/LOW |
| source_evidence_id | UUID | yes | FK → research_evidence.id |
| created_at | TIMESTAMP | no | |

## 11. `lead_scores`

1:1 with company (**unique** `uq_lead_scores_company_id`). Produced by the
deterministic scoring engine (`src/app/enrichment/scoring.py`), mirrored onto
`companies.lead_score`.

| Column | Type | Null | Notes |
|--------|------|------|-------|
| id | UUID | no | PK |
| company_id | UUID | no | FK → companies.id, **unique** |
| product_fit | DOUBLE PRECISION | no | 0–100 |
| company_fit | DOUBLE PRECISION | no | |
| market_fit | DOUBLE PRECISION | no | |
| purchasing_potential | DOUBLE PRECISION | no | |
| contact_quality | DOUBLE PRECISION | no | |
| growth_signals | DOUBLE PRECISION | no | |
| data_completeness | DOUBLE PRECISION | no | |
| recent_activity | DOUBLE PRECISION | no | |
| total_score | DOUBLE PRECISION | no | weighted sum |
| grade | VARCHAR(4) | yes | A/B/C/D/F |
| breakdown | JSON | yes | component detail |
| created_at / updated_at | TIMESTAMP | – | |

## 12. `ai_contexts`

Regenerable context packs. `AIContextRepository.replace()` deletes prior rows
for a scope then inserts, so rebuilds are idempotent with no duplicates.

| Column | Type | Null | Notes |
|--------|------|------|-------|
| id | UUID | no | PK |
| company_id | UUID | no | FK → companies.id |
| context_type | VARCHAR(40) | no | COMPANY_INTELLIGENCE/CONTACT_INTELLIGENCE/BUYING_SIGNAL_SUMMARY/OUTREACH_PREPARATION |
| contact_id | UUID | yes | FK → contacts.id — disambiguates contact-scoped packs |
| content | TEXT | no | populated JSON/text |
| regenerated_at | TIMESTAMP | yes | |
| created_at / updated_at | TIMESTAMP | – | |

**Unique** `uq_ai_context_scope` (`company_id, context_type, contact_id`).

---

## Relationships

```
companies 1──N contacts 1──N contact_methods
companies 1──N social_accounts        contacts 1──N social_accounts
companies 1──N research_evidence      contacts 1──N research_evidence
companies 1──N research_tasks
companies 1──N company_events
companies 1──N company_brands N──1 brands
companies 1──1 lead_scores (unique company_id)
companies 1──N ai_contexts            contacts 1──N ai_contexts
```

Products and brands have no direct FK to companies: companies are linked to
them via `company_brands` (brands) and via `research_evidence` rows whose
`field_name` is `product.name` (products).

## Verification commands

```bash
# migration state must equal 92a389f336cf
.venv/bin/alembic current

# table list + detailed column dump via container psql (no local psql assumed)
docker exec -it watersports_postgres psql -U watersports -d watersports -c "\dt"
docker exec -it watersports_postgres psql -U watersports -d watersports -c "\d companies"

# row counts sanity (matches the table above for a full import+enrich cycle)
.venv/bin/python - <<'EOF'
import asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import create_async_engine
from app.core.config import get_settings
from app.db.models import Company
async def main():
    e = create_async_engine(get_settings().database_url)
    async with e.connect() as c:
        print("companies:", await c.scalar(select(func.count()).select_from(Company)))
    await e.dispose()
asyncio.run(main())
EOF
```