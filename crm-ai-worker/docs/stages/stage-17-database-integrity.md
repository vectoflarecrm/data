# Stage 17 — Database Integrity (spec §18)

**Status: complete.** Commit: `security-v2: add database integrity constraints`
Test surface: 377/377 (10 new in `tests/db-integrity.test.ts`), tsc clean, dry-run 435.08 KiB, 4 panels clean.

## What the spec asked for (§18, 架构.txt L1326-1359)

Check all core tables' FK / UNIQUE / INDEX / NOT NULL / CHECK; fix the five §18.1 duplicate/orphan classes:
防止 orphan campaign member、orphan outreach email、duplicate email、duplicate customer domain、duplicate API fingerprint、duplicate Gmail account。
Constraint: 严禁重写 — no destructive migration, no behavior-affecting refactor.

## The two fresh-install landmines found (and fixed)

1. **`contacts` was never created anywhere in the repository.** Not in `schema.sql`, not in any migration, not in the CI workflow. The research save path (`index.ts`) writes it with `INSERT OR IGNORE` and the panel reads it — production has a hand-made table of unknown shape, but a fresh D1 (or a dev replica) fails the research save step with `no such table: contacts`. Fixed: `schema.sql` now carries the full 15-column definition, and a belt-and-suspenders `CREATE TABLE IF NOT EXISTS` runs in the new CI step (the statement is tolerated with `|| true` so a differently-shaped production table does not block deploys).
2. **`customers.display_id` (and the four Stage 15 ALTER columns) were missing from the `schema.sql` CREATE.** `CUSTOMER_COLUMNS` selects them on every panel query, so a fresh install 500s on any customer read. Fixed: the CREATE now includes `display_id`, `lead_score`, `buying_signals`, `source_import_id`, `data_completeness_score` — fresh installs resolve the full read surface from `schema.sql` alone; existing databases still receive them via the existing per-column CI ALTERs (now including `display_id`, which only existed in production).

While editing the workflow, a latent CI-breaking typo from Stage 15 was fixed: the verification SQL `name = 'data_completeness_score')` had an extra `)` — a bash syntax error that would have failed the very next deploy.

## Audit matrix (10 core tables, verified against schema.sql)

| Table | PK | FK | UNIQUE | INDEX | NOT NULL / CHECK | Notes |
|---|---|---|---|---|---|---|
| customers | `id` INTEGER PK | — (no parent) | `company_id` inline UNIQUE; `idx_customers_domain` (partial, CI — `WHERE domain != ''`) | `idx_customers_status`, `idx_customers_company_id` | `status` CHECK; `personas_and_solutions`/`company_profile`/`outreach_context` JSON CHECKs | import rows without a usable domain carry `''`, deliberately excluded from the partial index; CHECK/JSON constraints exist on fresh installs only (SQLite cannot add CHECK to an existing table) |
| contacts | `id` INTEGER PK | — | `idx_contacts_contact_id`, `idx_contacts_seq (company_id, seq)` (CI) | `idx_contacts_company` (schema.sql) | NOT NULLs on identity columns (fresh installs) | **defined in schema.sql for the first time**; named indexes (not inline constraints) so a hand-made production table and fresh installs converge under the same index set |
| evidence | `id` INTEGER PK AUTOINCREMENT | — (`company_id` TEXT, no FK) | — | `idx_evidence_company (company_id, field_name)` | `company_id`/`field_name` NOT NULL | Stage 14 append-only provenance columns included |
| outreach_campaigns | `id` INTEGER PK AUTOINCREMENT | — (`group_id` INTEGER, no FK) | — | `idx_campaigns_brand (brand_name, status)` | `name`/`brand_name` NOT NULL; `status` CHECK (draft/paused/done); `filters` JSON CHECK | deleting a group leaves `group_id` dangling (see Limitations) |
| outreach_campaign_members | composite PK `(campaign_id, customer_id)` | — | the composite PK itself | `idx_campaign_members_queue (campaign_id, status)` | `status` CHECK (pending/generated/sent/skipped/failed) | the composite PK makes a duplicate membership row impossible on any install; orphans are prevented structurally (delete ordering + no customer-delete path), not by FKs |
| outreach_emails | `id` INTEGER PK AUTOINCREMENT | `customer_id` → customers(id) | `idx_outreach_idempotency` (partial, Stage 10) | `idx_outreach_customer_id`, `idx_outreach_status`, `idx_outreach_product`, `idx_outreach_send_lock` | `send_attempts` NOT NULL | FK enforced by D1 (asserted in tests: inserting an email for a missing customer throws) |
| gmail_accounts | `id` INTEGER PK AUTOINCREMENT | — | `client_email` inline UNIQUE (migration 0003) | — | `client_email`/`private_key` NOT NULL; `credential_type` CHECK; `enabled` CHECK | duplicate Gmail account → 409 “该服务账号已存在” (Stage 4-era behavior, retained) |
| api_configs | `id` INTEGER PK AUTOINCREMENT | — | `idx_api_configs_fingerprint (provider, key_fingerprint)` (partial, CI — `WHERE key_fingerprint IS NOT NULL`) | `idx_api_configs_provider (provider, is_active)` | `api_key` NOT NULL; `is_active` CHECK | per-provider on purpose: bulk import documents dedup as "duplicates within the paste AND keys already stored **for the provider** are skipped"; a global index would turn a legitimate cross-provider paste row into a mid-loop 500 |
| audit_logs | `id` TEXT PK | — | — | `idx_audit_logs_created_at`, `idx_audit_logs_resource`, `idx_audit_logs_actor` | `action`/`resource_type`/`created_at` NOT NULL | append-only, Stage 9 |
| research_runs | `id` TEXT PK | — (`customer_id` TEXT, no FK) | — | `idx_research_runs_customer` (schema.sql, new) | `customer_id`/`status`/`started_at` NOT NULL | Stage 14; index added because every provenance query filters by customer |

## §18.1 mapping — where each "防止" is enforced

| Item | Enforcement |
|---|---|
| orphan campaign member | composite PK `(campaign_id, customer_id)` + `deleteCampaign` deletes members **before** the campaign (campaigns.ts) + no code path deletes customers (members carry no FK by design — structural prevention instead) |
| orphan outreach email | real FK `outreach_emails.customer_id` → `customers(id)` (D1 enforces FKs by default; test asserts) + no code path deletes customers |
| duplicate email | `gmail_accounts.client_email` UNIQUE (test asserts); send-side duplicates additionally blocked by Stage 10's idempotency partial index |
| duplicate customer domain | `idx_customers_domain` partial unique index (CI step) + PATCH conflict maps to 409 (new) |
| duplicate API fingerprint | `idx_api_configs_fingerprint` partial unique index (CI step, per-provider) + single-key POST 409 pre-check (new, matches bulk semantics) |
| duplicate Gmail account | `gmail_accounts.client_email` UNIQUE (test asserts) |

## Changes

- `crm-ai-worker/schema.sql` — `contacts` table (15 columns) + `idx_contacts_company` + `idx_research_runs_customer`; `customers` CREATE gains `display_id` and the four Stage 15 columns; comments explain the index/ALTER division of labor.
- `.github/workflows/deploy-worker.yml` — new step **"Migrate contacts + integrity indexes (Security V2 Stage 17)"**: `CREATE TABLE IF NOT EXISTS contacts` (`|| true`), per-column `display_id` ALTER with duplicate-column tolerance, the four partial unique indexes (`|| true` + WARNING echo — production dirty data must not block a deploy), verification echoes (contacts table exists, index count); fixed the Stage 15 step's SQL typo.
- `crm-ai-worker/migrations/0015_contacts_and_integrity_indexes.sql` — documentation migration (DDL + rationale; FK/CHECK limitation noted).
- `crm-ai-worker/src/admin.ts` — single-key `POST /admin/api/keys`: duplicate `(provider, fingerprint)` pre-check → 409 (previously only the bulk route deduped); `updateCustomer` catch: `UNIQUE constraint failed: customers.domain` → 409 “该 domain 已被其他客户占用”.
- `crm-ai-worker/tests/db-integrity.test.ts` — new, 10 tests: schema.sql idempotent + full §18 table/index set; fresh-install customers read surface; contacts research-path INSERT OR IGNORE; the four duplicate classes at the DB level; FK orphan rejection; both admin API behaviors (409s + cross-provider/unique acceptance).

## Decisions

- **Partial unique indexes go in the CI step, not `schema.sql`.** `schema.sql` runs against production on **every** deploy; if dirty data already violates an index, the deploy would fail and block everything. The CI step creates them with `|| true` + a visible WARNING + verification echoes (Stage 10 precedent). `IF NOT EXISTS` keeps re-runs idempotent.
- **Per-provider fingerprint uniqueness** matches the bulk route's documented semantics and avoids breaking the row-at-a-time bulk insert.
- **`contacts` uses named indexes, not inline constraints**, so a pre-existing production table and fresh installs converge under the same named index set.
- **PATCHed domains are stored in URL form** (`validateDomain` returns `https://acme.com/`), so the index enforces exact-string uniqueness on that form; semantic site identity remains `normalized_domain`'s job (out of scope — changing it would be a rewrite).
- **`ct.source` binds into the `department` column** in the research save path — pre-existing quirk, kept as-is (changing it would alter panel-visible data).
- **Fail-open/strict spectrum unchanged:** this stage adds no fail-open paths; the unique indexes are correctness-adjacent, but a blocked index creation is a deploy-time WARNING, not a runtime failure.

## Limitations (documented, accepted)

- **SQLite cannot add FK/NOT NULL/CHECK constraints to existing tables without a table rebuild** (`CREATE new → copy → DROP → RENAME`). A rebuild of production tables with live data was judged too risky for this stage's constraint (严禁重写); fresh installs get the full constraint set from `schema.sql`, and existing databases get the unique indexes (the duplicate classes — the §18.1 focus) from CI. This is recorded in migration 0015.
- **`deleteGroup` leaves `group_id` dangling** in `outreach_campaigns` (not one of the §18.1 items; adding a guard would change existing behavior and break existing tests). The only real child-table FK in the schema is `outreach_emails.customer_id`; `outreach_campaign_members` relies on structural prevention (composite PK + delete ordering) instead.
- Import-time domain dedup remains application-level (`normalized_domain` LIKE matching in `importCustomersCsv`); the new index closes the TOCTOU window for exact strings but not for normalization variants.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **377/377 (26 files)**, including the 10 new db-integrity tests.
- `npx wrangler deploy --dry-run --outdir dist-dryrun` — Total Upload 435.08 KiB.
- `node scripts/check-panel.mjs` — 4 panels clean.

Baseline #18 marked fixed in `docs/security-v2-baseline.md`.
