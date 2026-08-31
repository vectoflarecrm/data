# Database Design

Phase 0 database analysis for **Global Watersports B2B Intelligence DB**.

## 1. Engine

- PostgreSQL 16 (Docker), async driver `asyncpg`, SQLAlchemy 2.x ORM, UUID primary keys, UTC timestamps, explicit FKs, Alembic migrations.

## 2. ERD

```
companies 1--* contacts 1--* contact_methods
  |                  |
  |                  |--* social_accounts
  |                  \--* research_evidence
  |
  |--* company_brands *--1 brands
  |--* products            (shared catalog; link companies via evidence/brands in V1)
  |--* company_events
  |--* research_evidence
  |--* research_tasks
  \--1 lead_scores (unique company_id)

reserved (future): campaigns, outreach, outreach_events, email_messages
```

## 3. Core tables

### companies
id, company_name, legal_name, trading_name, website, normalized_domain, country, country_code, region, city, address, postal_code, industry, company_type (array), business_model, founded_year, employee_range, description, main_products_summary, target_markets (array), manufacturer, importer, distributor, wholesaler, retailer, ecommerce, rental, oem (booleans), company_status, research_status, research_level, company_score, lead_score, ai_context, created_at, updated_at, last_researched_at, next_research_at.

Unique: `normalized_domain`. Indexes: country_code, company_status, research_status, lead_score.

### contacts
id, company_id, first_name, last_name, full_name, job_title, department, seniority, role_type, purchasing_role, decision_power, linkedin_url, bio, status, confidence, created_at, updated_at, last_verified_at. Indexes: company_id, purchasing_role.

### contact_methods
id, contact_id, company_id, method_type, value, normalized_value, is_primary, is_business, public_or_private, verification_status, confidence, source_evidence_id, created_at, updated_at, verified_at. Unique: (contact_id, method_type, normalized_value). Index: company_id.

### social_accounts
id, company_id, contact_id, platform, profile_url, username, display_name, business_or_personal, followers, activity_level, verification_status, confidence, source_evidence_id, created_at, updated_at, last_checked_at. Unique: (company_id, platform, profile_url).

### products
id, name, category, subcategory, description, created_at, updated_at. Unique: name (case-insensitive). Index: category.

### brands
id, name, website, created_at, updated_at. Unique: name.

### company_brands
id, company_id, brand_id, relationship_type, source_evidence_id, created_at, updated_at. Unique: (company_id, brand_id, relationship_type).

### company_events
id, company_id, event_type, event_date, title, description, importance, source_evidence_id, created_at. Index: (company_id, event_date).

### research_evidence
id, company_id, contact_id, field_name, value, source_url, source_domain, source_type, evidence_text, extraction_method, confidence, discovered_at, verified_at, content_hash, created_at. Unique: content_hash. Indexes: company_id, field_name, source_domain.

### research_tasks
id, company_id, task_type, priority, status, attempts, max_attempts, scheduled_at, started_at, completed_at, next_retry_at, worker_id, error_message, result_summary, created_at, updated_at. Indexes: (status, priority, scheduled_at) partial, company_id.

### lead_scores
id, company_id, product_fit, company_fit, market_fit, purchasing_potential, contact_quality, growth_signals, data_completeness, recent_activity, total_score, grade, breakdown (jsonb), created_at, updated_at. Unique: company_id.

## 4. Enums (PostgreSQL native via SQLAlchemy Enum)

- company_type: MANUFACTURER, BRAND_OWNER, IMPORTER, DISTRIBUTOR, WHOLESALER, RETAILER, ECOMMERCE, DEALER, RENTAL, OEM, ODM, SERVICE_PROVIDER, OTHER, UNKNOWN
- company_status: ACTIVE, INACTIVE, SUSPENDED, OTHER, UNKNOWN
- research_status: NEW, DISCOVERED, COMPANY_RESEARCHED, PRODUCT_RESEARCHED, CONTACT_RESEARCHED, CONTACT_VERIFIED, SOCIAL_RESEARCHED, WHATSAPP_RESEARCHED, FULLY_ENRICHED, NEEDS_RESEARCH, RESEARCH_FAILED
- contact_status: ACTIVE, INACTIVE, LEFT_COMPANY, UNKNOWN
- role_type: OWNER, FOUNDER, CEO, GENERAL_MANAGER, PURCHASING_MANAGER, BUYER, PROCUREMENT, PRODUCT_MANAGER, IMPORT_MANAGER, SALES_DIRECTOR, MARKETING_DIRECTOR, EXECUTIVE, OTHER, UNKNOWN
- purchasing_role: DECISION_MAKER, BUYER, INFLUENCER, TECHNICAL, EXECUTIVE, SALES, MARKETING, UNKNOWN
- method_type: EMAIL, PHONE, MOBILE, WHATSAPP, TELEGRAM, SKYPE, OTHER
- verification_status: UNVERIFIED, VERIFIED, INFERRED, CONFLICTING
- platform: LINKEDIN, INSTAGRAM, FACEBOOK, YOUTUBE, TIKTOK, PINTEREST, X, WHATSAPP, TELEGRAM, OTHER
- product_category: SUP, INFLATABLE_SUP, HARD_SUP, TOURING_SUP, ALL_ROUND_SUP, RACE_SUP, YOGA_SUP, KAYAK, INFLATABLE_KAYAK, FISHING_KAYAK, TOURING_KAYAK, INFLATABLE_BOAT, RIB, PADDLE, PUMP, LIFE_JACKET, WATER_TOY, ACCESSORY, OTHER
- brand_relationship: OWNED, DISTRIBUTOR, IMPORTER, DEALER, RESELLER, COMPETITOR, PARTNER, OTHER
- event_type: NEW_PRODUCT, NEW_BRAND, NEW_DISTRIBUTOR, NEW_HIRING, NEW_MANAGER, NEW_STORE, EXPANSION, NEW_WAREHOUSE, TRADE_SHOW, CATALOG_RELEASE, WEBSITE_UPDATE, PARTNERSHIP, PRODUCT_CATEGORY_EXPANSION, OTHER
- task_type: COMPANY_DISCOVERY, COMPANY_RESEARCH, PRODUCT_RESEARCH, BRAND_RESEARCH, CONTACT_DISCOVERY, EMAIL_DISCOVERY, PHONE_DISCOVERY, WHATSAPP_DISCOVERY, SOCIAL_DISCOVERY, VERIFICATION, BUYING_SIGNAL_RESEARCH, LEAD_SCORING, FULL_ENRICHMENT
- task_status: PENDING, RUNNING, COMPLETED, FAILED, RETRY, CANCELLED
- source_type: OFFICIAL_WEBSITE, OFFICIAL_CONTACT_PAGE, OFFICIAL_TEAM_PAGE, OFFICIAL_PRODUCT_PAGE, OFFICIAL_CATALOG, OFFICIAL_SOCIAL, LINKEDIN, INDUSTRY_DIRECTORY, TRADE_PUBLICATION, SEARCH_RESULT, IMPORTED_DATA, OTHER
- evidence_confidence: HIGH, MEDIUM, LOW, UNKNOWN
- importance: CRITICAL, HIGH, MEDIUM, LOW

## 5. Normalization rules

- Domain: lowercase, strip scheme/path, strip www, idna encode.
- Email: lowercase, strip whitespace.
- Phone: original kept in `value`; `normalized_value` E.164 best-effort with leading +.
- Names: strip, collapse whitespace, title-case first/last.
- URLs: validate http(s) scheme.

## 6. Indexes and constraints

- Every FK column indexed.
- Unique constraints as listed (idempotency keys).
- `research_tasks` partial index for claim scans on (PENDING, RETRY) rows.