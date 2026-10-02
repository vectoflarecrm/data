# Security V2 Baseline — CRM AI Worker

Date: 2026-10-02 · Branch: `feature/security-v2` (from `main` @ `035eede`)

## Baseline Test Results

| Check | Command | Result |
|---|---|---|
| Unit/integration tests | `npm test` (vitest run) | **162/162 pass** (11 files) |
| Type check | `npm run typecheck` (tsc --noEmit) | **pass** |
| Panel static check | `node scripts/check-panel.mjs` | **5 panels clean** |
| Build | `npx wrangler deploy --dry-run` | **pass** (388.13 KiB / gzip 99.27 KiB) |

No `lint` script exists in `package.json`; `tsc --noEmit` + `check-panel.mjs` + wrangler dry-run serve as the static-analysis baseline. No pre-existing test failures (TEST_BASELINE_PASS / TYPECHECK_BASELINE_PASS / BUILD_BASELINE_PASS). A `docs/pre-existing-failures.md` is therefore not required.

## Current Architecture

Cloudflare Worker (single script) + D1 (`crm-ai-db`) + optional Workers AI binding. Runtime has **zero npm dependencies**; dev-only deps are wrangler/vitest/typescript/workers-types.

```
fetch() ──► /admin/*  → handleAdminRequest (auth + panel HTML + admin JSON API)   [src/admin.ts, 3233 lines]
scheduled() ─► research pipeline: claim pending customers (BATCH_SIZE=3, parallel)
              → crawl domain → search providers → AI analysis → D1 persist        [src/index.ts, 2100 lines]
```

Modules: `admin.ts` (auth/routing/HTML panels), `index.ts` (cron research pipeline), `gmail.ts` (OAuth/JWT + MIME + send + quota), `outreach.ts` (AI draft generation + provider fallback chain), `campaigns.ts` (segments/campaign state machine), `credential-crypto.ts` (AES-GCM + HKDF envelope encryption `enc:v1:`), `provider-keys.ts` (D1-first key pools, 30s isolate cache), `key-pool.ts` (rotation order), `rate-limit.ts` (per-isolate RPM limiter), `bulk-keys.ts` (bulk key parse), `facets.ts` (filter options).

## Authentication Flow (current)

1. `GET /admin` serves `ADMIN_LOGIN_HTML` (no auth).
2. `POST /admin/api/login` `{password}` → constant-time compare against `ADMIN_PANEL_TOKEN` secret; IP + global throttling persisted in `admin_login_attempts` (D1).
3. Success sets cookie `crm_admin_token=<ADMIN_PANEL_TOKEN>` — **the raw master token itself**, `HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=86400`.
4. Every `/admin/api/*` route and panel page re-verifies the cookie against the secret (constant-time).

## Authorization Flow (current)

Single role: knowledge of `ADMIN_PANEL_TOKEN` = full root over customers, imports, research, provider keys, Gmail accounts, credentials, campaigns, sending, and **Cloudflare Worker secret mutation** (`/admin/api/secrets` + SECRETS_PANEL_HTML uses a Cloudflare API token stored in Worker secrets to rewrite the Worker's own secrets). No RBAC.

## Credential Flow (current)

- Envelope encryption in `credential-crypto.ts`: `enc:v1:<iv>:<ciphertext>` AES-256-GCM, HKDF-derived subkeys from `CREDENTIAL_ENC_KEY`, HMAC fingerprint. Applied to `api_configs.api_key`, `gmail_accounts.private_key` (new writes); legacy plaintext rows still decrypt-read for compatibility (read side tries `enc:` prefix detection).
- Panel never returns plaintext after save; one-time reveal via credential API.
- **Known leak**: `wrangler.toml` contains the real D1 `database_id` (`fb20ea82-...`); README/CI expect placeholder `REPLACE_WITH_D1_DATABASE_ID`.

## Gmail Send Flow (current)

`sendOutreachEmail` (gmail.ts:561): validate → `assertQuota()` (count `gmail_send_log` today vs pooled `daily_limit`) → choose account (brand binding → env secret → healthiest pool account) → get access token (service-account JWT or OAuth refresh; token cached in-memory) → build MIME (+ per-language catalog attachments) → POST Gmail API → on success write `gmail_send_log` + flip `outreach_emails.status='sent'`.

**Race**: quota check and send are not atomic; two concurrent batches can both pass `assertQuota()` and exceed the daily cap. No reservation, no per-email lock, no `uncertain` state (Worker crash after Gmail accepted → status stays `draft` → duplicate resend risk).

## Campaign Flow (current)

Segments (`outreach_groups` filters, preview gate) → `createCampaign` snapshots member ids (`outreach_campaign_members`, capped `MAX_CAMPAIGN_SIZE`, D1 batch chunks of 50) → Step 1 `runCampaignGenerate` (pending→generated/skipped/failed, retryable-error classification) → Step 2 `runCampaignSend` (generated→sent/failed one-at-a-time, quota-stop leaves members `generated` for tomorrow, `GmailConfigError` aborts batch, inter-send delay). Paused campaigns hard-stop both steps. Resume is cursor-based via member status.

## Research / Crawler Flow (current)

`scheduled()` claims `pending` customers (`BATCH_SIZE=3` with `run_at` staggering) → `normalizeDomain` (http/https only) → direct `fetchWebsite` (UA spoof, timeout, one retry on 5xx) → Firecrawl fallback on 403/503 → HTML→text + JSON-LD facts → search providers (Searlo→Brave→Tavily→Exa→DuckDuckGo fallback chain, all key-authenticated, 1s inter-source delay) → relevance precheck → AI analysis (Gemini responseSchema or OpenAI-compatible JSON mode) → parse → persist customers/contacts/evidence with `field_evidence` (source_url, quote, confidence).

## AI Provider Flow (current)

Provider pools resolve D1-first (`api_configs` + `provider_settings`, 30s isolate cache) with env secrets as bootstrap fallback. Per-customer deterministic start key (id-derived), rotation on failure; per-isolate RPM guard (`rate-limit.ts`) + reactive 429 cooldown in `api_key_health` (D1, keyed `<provider>:<keyId>`); usage counted in `api_key_usage`. Outreach generation shares the same pools through its own fallback chain (Gemini → groq/cerebras/zhipu/nvidia/amd/mistral/deepseek/openrouter).

## D1 Schema (schema.sql + migrations)

Tables: `customers`, `outreach_settings`, `outreach_attachments`, `outreach_emails`, `api_key_health`, `api_key_usage`, `api_configs`, `provider_settings`, `gmail_accounts`, `gmail_send_log`, `evidence`, `customer_imports`, `outreach_groups`, `outreach_campaigns`, `outreach_campaign_members`, `admin_login_attempts`.

Migrations (`migrations/`, forward-only, applied by CI deploy workflow):
1. `0001` company_entity + Vatrad sender defaults
2. `0002` Helen signature + attachment language
3. `0003` Gmail account pool
4. `0004` outreach campaigns
5. `0005` admin login attempts
6. `0006` api_configs credential columns

## Existing Tests (162)

`admin-hardening` (10: auth bypass, login throttle, 500 redaction), `credential-api` (18), `credential-crypto` (19), `campaigns` (21), `campaign-steps` (30), `facets` (14), `bulk-keys` (9), `key-pool` (10), `provider-keys` (11), `rate-limit` (8), `relevance` (12). Stack: vitest with hand-rolled D1/Request mocks; AI/Gmail are dependency-injected seams in `campaigns.ts`.

## Known Risks (audit findings feeding the stage plan)

| # | Risk | Severity | Stage |
|---|---|---|---|
| 1 | `ADMIN_PANEL_TOKEN` doubles as the long-lived browser session cookie | P0 | 1 |
| 2 | Worker can mutate its own Cloudflare secrets (CF API token in env) | P0 | 3 |
| 3 | Gmail quota check→send not atomic (concurrent batches exceed daily cap) — **fixed in Stage 11**: `src/gmail-quota.ts` reserves capacity with a single atomic INSERT…SELECT guarded by `sent_today + reserved_today < daily_limit` (per account), TTL-reaped holds, and quota views that subtract in-flight slots | P0 | 11 |
| 4 | No per-email send state machine (`uncertain` missing) → duplicate send on crash-after-accept — **fixed in Stage 10**: `src/outreach-send.ts` implements draft→reserved→sending→sent/failed/uncertain with atomic conditional claims, stale-lock reaping (reserved→draft, sending→uncertain), idempotency keys with a unique partial index, and a hard timeout on the Gmail API call | P0 | 10 |
| 5 | No campaign/email claim lock → concurrent sends can double-send one email — **fixed in Stages 10+12**: Stage 10's per-email atomic claims (`src/outreach-send.ts`) already make a double-send impossible; Stage 12 adds `src/campaign-lock.ts` + `campaign_locks` (migration 0011) so one campaign has at most one runner (generate or send): the claim is a single atomic upsert that steals only expired locks (30min TTL), release is token-guarded, a missing table fails open (the per-email guarantee carries), and admin endpoints surface a busy campaign as 409 | P0 | 12 |
| 6 | No RBAC (single root role) | P1 | 2 |
| 7 | KEYS_PANEL_HTML interpolates `last_error`/label/key hint into innerHTML without escaping (stored XSS via upstream provider error text); campaign member name unescaped at admin.ts:2877 | P1 | 5 |
| 8 | Real D1 database_id committed in `wrangler.toml` | P1 | 5 |
| 9 | No CSP/HSTS/X-Frame-Options/nosniff/Referrer-Policy headers | P1 | 5 |
| 10 | No Origin/CSRF validation on state-changing routes (SameSite=Strict mitigates but is unverified) — **fixed in Stage 6**: foreign-origin POST/PUT/PATCH/DELETE rejected 403 before any handler; missing-Origin deliberately allowed (policy in `src/security/origin-guard.ts`) | P1 | 6 |
| 11 | SSRF: outbound fetch of admin-supplied domains/search URLs with no private-IP/protocol guard — **fixed in Stage 6+7**: `src/security/outbound-url.ts` + guard in `fetchWithTimeout`; runtime-inherent limits documented in `docs/security-limitations.md` | P1 | 7 |
| 12 | CSV import unbounded (bytes/rows/fields); parser runs on full body — **fixed in Stage 8**: `src/security/csv-limits.ts` enforces 5MB/2000 data rows/10KB fields/200 columns; body read is stream-capped (chunked uploads without Content-Length cannot bypass); formula neutralization provided for any future export | P1 | 8 |
| 13 | No audit log — **fixed in Stage 9**: `audit_logs` table (migration 0008) + `src/audit/audit-log.ts`; every §10.1 action (logins, key/gmail/campaign/customer mutations, CSV import, research lifecycle) writes a row with actor, action, resource, redacted metadata and hashed IP/UA; authorization failures (401/403 on state-changing routes) recorded as `ACCESS_DENIED`; write failures are fail-open (never block the business action) | P1 | 9 |
| 14 | Scraped/search content enters AI prompts without untrusted-data framing (prompt injection) — **fixed in Stage 13**: all three AI prompt surfaces (research analysis, relevance precheck, outreach generation) now carry the spec §14 UNTRUSTED DATA contract verbatim and treat embedded instructions as evidence-only; §14.1 is enforced structurally — `parseAnalysis` whitelists output fields, `computeLeadScore` is deterministic code, and outreach drafts bind the recipient from the database (never from model output), which `generateDraftForCustomer` now validates as a strict `{subject, body}` string contract; `fixtures/prompt-injection.html` + `tests/prompt-injection.test.ts` prove a fully hijacked model still cannot send email, modify data, or change the score | P2 | 13 |
| 15 | Evidence overwritten in place (no research_run versioning) | P2 | 14 |
| 16 | `lead_score` conflates fit and data completeness | P2 | 15 |
| 17 | RPM limiter is per-isolate only | P2 | 16 |
| 18 | Core tables lack FKs/CHECKs (orphan members possible) | P2 | 17 |
| 19 | No unified response redaction / safeLog / request-id propagation | P2 | 18-20 |

## Security Debt Register (explicit)

- ~~Admin panels use inline `<script>` blocks with `onclick` handlers → CSP must retain `'unsafe-inline'` for now~~ **Resolved in Stage 5**: `htmlResponse()` mints a per-response nonce and rewrites every inline `<script>`/`<style>` tag, so `script-src`/`style-src` are nonce-based — no `unsafe-inline`, no `unsafe-eval`. Remaining, accepted debt: `style-src-attr 'unsafe-inline'` (panels use `style=""` attributes extensively; attributes cannot carry a nonce; CSS injection cannot execute script, and Stage 5 also escapes every dynamic innerHTML sink in the panels). A full class-based restyle would remove it.
- Per-isolate rate limiting accepted as local fast-limiter; distributed limiter deferred behind a `RateLimiter` abstraction (Stage 16).
- Legacy plaintext credentials remain readable until the Stage 4 migration encrypts them; new writes already enforce `enc:v1:`.
