# Security V2 Final Report

Branch `feature/security-v2` · Stages 0-24 · 26 commits · final verification 543/543 tests, `tsc --noEmit` clean, `wrangler deploy --dry-run` 440.02 KiB (gzip 112.15 KiB), 4 admin panels clean.

## Executive Summary

The CRM AI Worker entered this program with a single static `ADMIN_PANEL_TOKEN` doubling as browser session, credentials stored in plaintext and echoed back through the panel API, no audit trail, a fire-and-forget Gmail sender that could double-send and overshoot account quotas under concurrent Cron invocations, and no SSRF/CSV/prompt-injection hardening. Security V2 rebuilt the trust boundary in 24 verifiable stages on the standing constraint of **no rewrites**: every change is an additive service, migration, helper, validation or test, every stage ended with the full suite green and a committed stage report, and three defects were caught by the new suites themselves (a mis-gated campaign permission, a trailing-dot SSRF bypass, and a schema drift that would have bricked fresh installs).

Headline outcomes: browser-session auth is gone (hashed, expiring, revocable sessions behind an RBAC gate); the worker can no longer mutate Cloudflare secrets (that surface was removed, credentials moved to AES-GCM-encrypted D1 rows with masked display); every mutating action is audited with actor, role and request id; Gmail sending is a crash-safe state machine with idempotent claims, atomic quota reservation and single-flight campaign locks; outbound fetches, CSV imports and AI prompts are hardened; and the whole program is pinned by 543 tests — 72 security acceptance, 59 concurrency (10/50/100-task storms), 9 smoke-mechanism, the rest stage suites and pre-existing regression tests.

## Security Acceptance Checklist (spec §26)

| Item | Status | Evidence |
|---|---|---|
| Admin Token no longer acts as browser session | [x] | Stage 2: sessions in `admin_sessions`, token demoted to bootstrap/recovery credential; `tests/auth-sessions.test.ts`, `tests/security/auth.test.ts` |
| Sessions are hashed | [x] | Stage 2: `token_hash` = SHA-256(token), raw token only in HttpOnly cookie (`src/admin.ts:403-419`) |
| Sessions expire | [x] | Stage 2: `SESSION_TTL_SECONDS = 3600` (`src/admin.ts:259`), expiry checked on every request |
| Sessions can be revoked | [x] | Stage 2: `revoked_at` column + logout revocation (`src/admin.ts:437-449`) |
| RBAC implemented | [x] | Stage 3: `src/auth/rbac.ts`, roles super_admin/operator/researcher/sender/readonly, deny-by-default; Stage 22 fixed the campaign-action segment bug; `tests/rbac.test.ts`, `tests/security/rbac.test.ts` |
| Worker cannot mutate Cloudflare secrets | [x] | Stage 3: secret-management routes removed; only operator-run `wrangler` can set account secrets |
| Credentials encrypted at rest | [x] | Stage 4: `enc:v1:` AES-GCM-256 under `CREDENTIAL_ENC_KEY`, `key_hint`/`key_fingerprint` columns; `tests/credential-crypto.test.ts` |
| Secrets never appear in API response | [x] | Stage 18: `sanitizeResponse()` in `jsonResponse()` (§19 key names → `[REDACTED]`); `tests/response-redaction.test.ts`, `tests/security/credential-redaction.test.ts` |
| Secrets never appear in logs | [x] | Stage 19: `safeLog()` redacts keys + scrubs PEM/`enc:v1:`/Bearer patterns; static no-`console.*` guard `tests/safe-log.test.ts:124` |
| Security headers implemented | [x] | Stage 5: nonce-based CSP (no `unsafe-inline`/`unsafe-eval` for script/style), `src/security-headers.ts`; `tests/security-headers.test.ts` |
| CSRF/Origin protection implemented | [x] | Stage 6: same-origin `Origin`/`Referer` enforcement on mutations, 403 before auth; `SameSite=Strict` cookies; `tests/csrf.test.ts` |
| SSRF protection implemented | [x] | Stage 7: `assertPublicHttpUrl()` — scheme allowlist, private/loopback/link-local v4+v6 blocks, redirect revalidation; Stage 22 fixed the trailing-dot bypass; `tests/ssrf.test.ts` |
| CSV limits implemented | [x] | Stage 8: 5 MB / 2 000 rows / 200 columns / 10 000-char fields, streamed length enforcement (`src/security/csv-limits.ts:18-21`) |
| CSV formula injection protected | [x] | Stage 8: export cells neutralized (§9.3), imports stored inert; `tests/csv-limits.test.ts` |
| Audit log implemented | [x] | Stage 9: `src/audit/audit-log.ts`, `audit_logs` table, fail-open, `metadata_json`, `request_id` (Stage 20); `tests/audit-log.test.ts` |
| Gmail state machine implemented | [x] | Stage 10: draft→reserved→sending→sent/uncertain/failed + `reapStaleSends`; `tests/outreach-send.test.ts` |
| Gmail idempotency implemented | [x] | Stage 10: `idempotency_key` unique partial index `idx_outreach_idempotency`; `tests/concurrency/gmail-idempotency.test.ts` |
| Gmail quota reservation implemented | [x] | Stage 11: atomic INSERT…SELECT guard, 15-min TTL reaper; `tests/gmail-quota.test.ts`, `tests/concurrency/gmail-quota.test.ts` |
| Campaign concurrency lock implemented | [x] | Stage 12: `acquireCampaignLock` ON CONFLICT…WHERE, token-guarded release; `tests/campaign-lock.test.ts`, `tests/concurrency/campaign-claim.test.ts` |
| AI prompt injection defense implemented | [x] | Stage 13: hardened prompts, strict verdict parsing, relevance precheck fail-open, contact-entry bar; `tests/prompt-injection.test.ts`, `tests/security/prompt-injection.test.ts` |
| Evidence versioning implemented | [x] | Stage 14: `research_runs` + versioned evidence with supersession and provenance; `tests/evidence-v2.test.ts` |
| Lead score separated from completeness | [x] | Stage 15: `lead_score` (AI judgment) vs `completeness_score` (deterministic); `tests/score-separation.test.ts` |
| Distributed rate limiter abstraction implemented | [x] | Stage 16: `RateLimiter` interface + Local/D1/Tiered implementations, `providerRateLimiter(env)`; `tests/rate-limiter.test.ts`, `tests/concurrency/provider-rate-limit.test.ts` |
| Database constraints reviewed | [x] | Stage 17: §18 tables complete in schema.sql, 5 duplicate classes enforced by partial unique indexes via CI step, 409 mapping; `tests/db-integrity.test.ts` |
| Backup/recovery documented | [x] | Stage 21: `docs/backup-recovery.md` (RPO/RTO, Time Travel runbook, credential/campaign/research recovery, quarterly drill) |
| Security tests pass | [x] | Stage 22: 72/72 across 10 files in `tests/security/` |
| Concurrency tests pass | [x] | Stage 23: 59/59 across 5 files in `tests/concurrency/`, storms at 10/50/100 tasks |
| Regression tests pass | [x] | Stage 24: 543/543, 46 files, zero regressions |
| Typecheck passes | [x] | Stage 24: `npm run typecheck` exit 0 |
| Build passes | [x] | Stage 24: `wrangler deploy --dry-run` 440.02 KiB / gzip 112.15 KiB, clean exit |

## Changes

Stage-by-stage detail lives in `docs/stages/stage-01` … `stage-26`; the running findings ledger is `docs/security-v2-baseline.md` (20 findings, all fixed; plus the explicitly tracked debt register quoted under Remaining Risks).

- **Stages 1-3 (auth, RBAC, secret-mgmt removal)**: `admin_users`/`admin_sessions`, hashed expiring revocable sessions, login throttling (5 fails/15 min per ident, 30/15 min global), 5-role RBAC gate on every admin route, removal of the worker's Cloudflare-secret mutation surface.
- **Stage 4 (credential encryption)**: `enc:v1:` AES-GCM-256 envelope, `CREDENTIAL_ENC_KEY` via Wrangler, `key_hint`/`key_fingerprint`, lazy plaintext migration on read.
- **Stages 5-8 (perimeter)**: nonce-CSP + header set; same-origin mutation guard (403 pre-auth, no side effects); `assertPublicHttpUrl` SSRF guard for all outbound research fetches; CSV byte/row/column/field limits with streamed enforcement and export formula neutralization.
- **Stage 9 (audit)**: append-only `audit_logs` with actor/role/action/target/`metadata_json`, fail-open on D1 errors, `ACCESS_DENIED` and `LOGIN_FAILED` events.
- **Stages 10-12 (Gmail reliability)**: send state machine with stale-lock reaping; content-keyed idempotency with unique partial index; atomic per-account quota reservation with TTL reaper; single-flight campaign lock with token-guarded release.
- **Stage 13 (prompt injection)**: hardened system prompts, strict `parseRelevanceVerdict` (malformed → irrelevant, precheck fail-open), contact-entry bar keeps crawled PII out of prompts.
- **Stages 14-15 (evidence, scores)**: `research_runs` + versioned evidence (supersede, never overwrite) with provenance; `lead_score` split from `completeness_score`.
- **Stage 16 (rate limiting)**: `RateLimiter` abstraction — per-isolate sliding window (local fast tier) + D1 fixed window (global authoritative tier, fail-open to local on D1 unavailability) + reactive `api_key_health` cooldown retained.
- **Stage 17 (DB integrity)**: every §18 table fully defined in schema.sql (formalizing hand-made production tables), duplicate-detection partial unique indexes applied by a dedicated CI step, 409 conflict mapping, orphan prevention.
- **Stages 18-20 (observability hygiene)**: response redaction at the `jsonResponse()` choke point; `safeLog` with pattern scrubbing + static no-console guard; per-request UUID (`X-Request-ID`) into headers, audit rows and 500 bodies.
- **Stage 21**: `docs/backup-recovery.md` (assets, Time Travel facts, weekly off-platform export, migration runbook, RPO/RTO, quarterly restore drill).
- **Stage 22**: security acceptance suite (10 files, 72 tests) through the real `handleAdminRequest` path — found and fixed the RBAC campaign-action segment bug and the `https://localhost./` trailing-dot SSRF bypass.
- **Stage 23**: concurrency suite (5 files, 59 tests, 10/50/100-task storms) — found and fixed the `sender_client_email` schema drift that would have bricked fresh installs.
- **Stage 24**: regression gate — full suite, typecheck, build dry-run, panel checks, all green.
- **Post-spec §31/§32 hardening**: `docs/deployment-v2.md` (the no-staging safe-deploy pipeline + production smoke procedure), an unauthenticated `GET /health` liveness probe (200 only when the D1 binding answers, 503 otherwise), and the `OUTREACH_DRY_RUN` flag — "true"/"1" walks the full send state machine while the Gmail transport stays a no-op (no API call, no reservation, no quota row; rows marked `dry-run-…`), so smoke tests can never send real email.
- **Post-V2 Stage 25 (audit retention + view)**: `AUDIT_RETENTION_DAYS` (default 180, "0" = keep forever, typo-fail-safe) pruned by the 5-min cron before the claim early-return, every non-empty prune self-recording an `AUDIT_PRUNE` row; read-only `GET /admin/api/audit-logs` (audit.read: cursor paging, action filter, no IP/UA hashes) and the `/admin/audit` panel page.
- **Post-V2 Stage 26 (key rotation)**: `CREDENTIAL_ENC_KEY_PREVIOUS` decrypt fallback + idempotent `POST /admin/api/keys/reseal` and `POST /admin/api/gmail/reseal` sweeps (credentials.write) that re-encrypt every row onto the current master with the Stage 4 verification gate — rotation is now a documented 5-step procedure instead of panel re-entry (`docs/backup-recovery.md` §4).
- **Post-V2 Stage 27 (session inventory + admin-wide revocation)**: `GET /admin/api/auth/sessions` (cross-user listing, `is_current`, no token material), `POST /admin/api/auth/sessions/revoke` (any user's session) and `POST /admin/api/auth/revoke-all` (spares the session caller's own row) — all super_admin only with the gate's ACCESS_DENIED audit shape; `/admin/sessions` panel; cron vacuums sessions expired more than a fixed 7-day inspection grace ago (`src/auth/session-hygiene.ts`, own fail-open envelope).
- **Post-V2 Stage 28 (transport hygiene)**: `callGeminiOutreach` now carries the API key in the `x-goog-api-key` header and URL-encodes the model name (parity with the analysis call site) — no fetch error path can ship the key into logs via the request URL.
- **Post-V2 Stage 29 (WebAuthn 2FA)**: opt-in two-step admin login — `WEBAUTHN_RP_ID` + a registered security key/passkey make login token → assert challenge → session, with 10 one-time SHA-256-stored recovery codes as break-glass; strict no-dependency WebAuthn verifier (CBOR/authenticator-data/COSE-ES256+RS256, P1363/DER dual-format signatures, clone-counter rule), single-use TTL-300s challenge rows with cron vacuum, seven `/admin/api/auth/*` endpoints sharing the login throttle and audit vocabulary, `/admin/security` self-service panel, and — while the bootstrap operator holds an active credential — the Bearer master-token path is closed (a header-swappable second factor would be decoration). Migration `0017_webauthn.sql`; rollout + lockout runbook in `docs/deployment-v2.md` §6 and `docs/backup-recovery.md` §4.
- **Post-V2 verification**: 642/642 tests (52 files: 403 pre-existing + 72 security + 59 concurrency + 9 smoke + 19 retention + 14 rotation + 16 session-inventory + 2 transport + 20 webauthn-unit + 28 webauthn-flow), `tsc` exit 0, dry-run 520.55 KiB / gzip 127.65 KiB, 7 panels clean.

## Database Migrations

Forward-only, additive, per spec §29; `schema.sql` is kept in lockstep for fresh installs and the deploy workflow runs it plus per-statement idempotent ALTER steps (duplicate-column tolerant, with `pragma_table_info` verification) on every deploy. Security V2 migrations:

| File | Stage | Contents |
|---|---|---|
| `0005_admin_login_attempts.sql` | 2 | login-failure tracking for throttling |
| `0006_api_configs_credential_columns.sql` | 4 | `key_hint`, `key_fingerprint` |
| `0007_auth_sessions.sql` | 2 | `admin_sessions` (hashed tokens, expiry, revocation, ip/UA hashes) |
| `0008_audit_log.sql` | 9 | `audit_logs` |
| `0009_outreach_send_state.sql` | 10 | send-state columns + `idx_outreach_idempotency` |
| `0010_gmail_quota_reservations.sql` | 11 | `gmail_send_reservations` |
| `0011_campaign_locks.sql` | 12 | `campaign_locks` |
| `0012_research_runs_evidence_v2.sql` | 14 | research run + versioned evidence |
| `0013_customers_completeness_score.sql` | 15 | score separation columns |
| `0014_rate_limit_windows.sql` | 16 | global fixed-window counters |
| `0015_contacts_and_integrity_indexes.sql` | 17 | contacts table + integrity indexes |
| `0016_gmail_send_log_sender.sql` | 23 | drift fix: `sender_client_email` on fresh installs |
| `0017_webauthn.sql` | 29 | `webauthn_credentials`, `webauthn_challenges`, `webauthn_recovery_codes` (2FA) |

CI column steps: customers profile columns, api_configs credential columns, outreach_emails send-state columns, gmail_send_log sender column — each with post-step verification that fails the deploy if a column is missing.

## Authentication

- `ADMIN_PANEL_TOKEN` is no longer a session: it authenticates as the recovery/bootstrap identity only.
- Browser auth = `admin_sessions`: random 256-bit token, stored **hashed** (SHA-256), delivered in an `HttpOnly; SameSite=Strict; Secure` cookie, **1-hour expiry** checked on every request, revocable (`revoked_at`, logout).
- Login throttling: 5 failures → 15-minute lock per identifier (hashed CF-Connecting-IP or username), 30 global failures/15 min → full lockout; failures audited as `LOGIN_FAILED`.
- Session rows record `ip_hash`/`user_agent_hash` for anomaly review without storing raw PII.
- **Post-V2 Stage 29 (opt-in 2FA)**: while `WEBAUTHN_RP_ID` is set and the operator holds ≥ 1 active credential, login is two-step (token → WebAuthn assertion or one-time recovery code → session) and the Bearer bootstrap path is closed — fail-closed on credential-lookup errors, `safeLog`-only (no audit rows) so automation cannot flood `audit_logs`. Removing the last credential re-opens Bearer. Details: `docs/stages/stage-29-webauthn.md`.

## Authorization

- Five roles (`super_admin`, `operator`, `researcher`, `sender`, `readonly`), enforced by `src/auth/rbac.ts` as a deny-by-default permission map; role is fixed at mint time and re-read from the session row on every request (forged role values are impossible — `admin_users.role` has a CHECK constraint, and the RBAC layer was proven to reject unknown roles in Stage 22 tests).
- Gate order on every admin API request: origin guard → authentication → RBAC → handler → redaction → security headers; RBAC denials return the missing permission name and write an `ACCESS_DENIED` audit row; unknown routes 404 uniformly (no gate-existence disclosure).
- The Stage 22 suite caught a real bug here: `POST /admin/api/outreach/campaigns/:id/send` was gated as `campaigns.write` (action segment misread) instead of `outreach.send`, wrongly denying the `sender` role its designed capability — fixed and regression-pinned.

## Credential Security

- Provider keys and Gmail service accounts are stored as `enc:v1:<iv>:<cipher>:<tag>` AES-GCM-256 rows in D1, sealed under `CREDENTIAL_ENC_KEY` (a Wrangler secret, never in git; `key_hint` identifies which key sealed a row).
- The worker has **no** route that can create, update or delete Cloudflare account secrets — that surface was removed in Stage 3; credential lifecycle is panel → encrypted D1 row only.
- Response redaction (Stage 18) rewrites §19 secret key names at the single `jsonResponse()` choke point; logs go through `safeLog` (Stage 19) which redacts structured keys and scrubs PEM/`enc:v1:`/Bearer patterns; a repo-wide static test keeps any direct `console.*` out of `src/`.
- Plaintext rows are migrated lazily on first read/write; the suite proves the fail-closed behavior when `CREDENTIAL_ENC_KEY` is absent.

## Gmail Reliability

- **State machine** (Stage 10): `draft → reserved → sending → sent | failed | uncertain`; exactly one worker flips a row via a conditional UPDATE; `reapStaleSends` returns abandoned `reserved` rows to `draft` and quarantines stuck `sending` rows as `uncertain` (never auto-retried — an uncertain send may have consumed Gmail-side quota; the operator decides).
- **Idempotency**: `idempotency_key` = content-derived logical identity, enforced by a UNIQUE partial index — a retry storm can never double-send the same message; reservation rows carry a second UNIQUE (`email:<id>`).
- **Quota reservation** (Stage 11): one atomic `INSERT…SELECT` guarded by sent+reserved counts per sender account; slots are released on definite outcomes and reaped after a 15-minute TTL; quota exhaustion fails closed (missing tables/columns never degrade the control — the Stage 23 drift fix restored this for fresh installs).
- **Campaign lock** (Stage 12): single-flight execution per campaign via an atomic upsert with expiry-steal; release is token-guarded so a thief can't delete a newer holder's lock; the lock fails open only if the table is missing, with per-email idempotency remaining the hard guarantee.

## SSRF Protection

`src/security/outbound-url.ts` gates every outbound fetch the research pipeline makes: http/https only; IPv4 private (10/8, 172.16/12, 192.168/16), loopback (127/8), link-local (169.254/16, cloud metadata) and the IPv6 equivalents blocked; hostname normalization (case, trailing dots — the Stage 22 bypass fix); redirect chains revalidated per hop so a public URL can't bounce to an internal target.

## CSV Security

Import (Stage 8): 5 MB total (streamed against Content-Length + actual bytes), 2 000 data rows, 200 columns, 10 000 characters per field, BOM handling, RFC-4180 quoting; oversized input is rejected before parsing consumes memory. Export: formula-injection neutralization (§9.3); imported formula-looking text is stored inert as plain text and returned quoted in JSON.

## AI Prompt Injection

Hardened system prompts separate instructions from data; the relevance precheck returns a strictly parsed verdict (anything malformed = `irrelevant`, and any model/binding failure fails open to "never block the pipeline"); a contact-entry bar strips crawled contact-like content from prompts so PII and injected instructions never reach the model; generation outputs are parsed defensively. Proven by `tests/prompt-injection.test.ts` (unit) and `tests/security/prompt-injection.test.ts` (acceptance).

## Evidence Architecture

`research_runs` owns run state (pending → running → done/failed; orphaned `running` rows are cosmetic and reset), evidence rows are **versioned with provenance** (source URL, fetch time, content identity) and superseded rather than overwritten, so an AI judgment can always be traced to the exact evidence version it was made from. Write failures fail open — research availability is not held hostage by evidence bookkeeping — and the supersession chain is what makes re-running research safe (no duplicate evidence accumulation).

## Audit Log

Append-only `audit_logs`: actor user/role, action (create/update/delete/login/denial vocabulary), target, `metadata_json`, and since Stage 20 the `request_id` that also appears in the response header and any 500 body — the chain that answers "这一封邮件为什么被发送？". Writes are fail-open by design (a broken audit sink must not take down the panel), which the acceptance suite pins explicitly. Retention is bounded since post-V2 Stage 25: the 5-min cron prunes rows older than `AUDIT_RETENTION_DAYS` (default 180) and records each non-empty prune as an `AUDIT_PRUNE` row; the trail is inspectable via `GET /admin/api/audit-logs` and the `/admin/audit` panel.

## Rate Limiting

Three layers: (1) per-isolate sliding window (`LocalRateLimiter`, the cheap local tier), (2) global D1 fixed-window counter (`D1RateLimiter`, the authoritative tier — one atomic upsert both increments and returns the count, so concurrent isolates can never overshoot; fails open to local-only limiting if D1 is unavailable), composed by `TieredRateLimiter` behind `providerRateLimiter(env)`; (3) the reactive `api_key_health` 429-cooldown safety net. Login has its own per-ident + global throttle. The concurrency suite proves exact-limit admission at 10/50/100 tasks for the local, D1 and tiered paths, plus the documented fail-open shape.

## Tests

- **Total**: 642 tests, 52 files, all passing (`npm test` → `vitest run`).
- Composition: 403 pre-existing + stage suites (Stages 2-20, each stage's unit/integration file), 72 security acceptance (`tests/security/`, Stage 22), 59 concurrency (`tests/concurrency/`, Stage 23), 9 smoke mechanism (`tests/health.test.ts` 4, `tests/outreach-dry-run.test.ts` 5), plus post-V2 suites: 19 retention, 14 rotation, 16 session-inventory, 2 transport, 20 WebAuthn unit + 28 WebAuthn flow (real P-256 signatures verified end to end).
- Suites deliberately overlap: stage suites prove each layer's unit behavior, the security suite proves the layered combination through the real `handleAdminRequest` entry, the concurrency suite proves the single-statement atomicity the layers rely on under 10/50/100-task storms.
- The suites bite: Stage 22 found a real RBAC gating bug and a real SSRF bypass; Stage 23 found a real schema drift. All three were fixed with regression pins the same day they were found.

## Security Test Results

`tests/security/` — **72/72** across `auth`, `rbac`, `csrf`, `ssrf`, `credential-redaction`, `credential-encryption`, `csv-limits`, `headers`, `audit-log`, `prompt-injection` (+ shared `_helpers.ts` driving requests through origin guard → auth → RBAC → handler → redaction → headers over the real schema). Two production defects found and fixed during its construction (see above), both now regression-pinned and recorded in the baseline (#6, #11 correction notes).

## Concurrency Test Results

`tests/concurrency/` — **59/59** across `gmail-quota` (11), `gmail-idempotency` (10), `campaign-claim` (11), `research-claim` (10), `provider-rate-limit` (17). Every core invariant is stormed at 10/50/100 parallel tasks: exact-limit quota admission, single-slot-per-email, single-winner claims, disjoint research batches, expired-lock single-steal, token-guarded release, exact tiered-limiter caps, and the fail-open-to-local degradation. One production defect found and fixed (schema drift, baseline #20).

## Regression Results

Stage 24 gate, all green: `npm test` 543/543 (46 files); `npm run typecheck` exit 0; no linter is configured in this repo — the actual static gates are `tsc --noEmit` plus the repo-wide static tests inside vitest (notably the no-console guard); build = `npx wrangler deploy --dry-run --outdir dist-dryrun` → 440.02 KiB / gzip 112.15 KiB, clean exit; `scripts/check-panel.mjs` → 4 panels clean. Zero regressions across the entire program.

## Remaining Risks

Accepted and documented, none unmitigated:

1. **`style-src-attr 'unsafe-inline'`** in CSP — panels use `style=""` attributes (attributes cannot carry a nonce); CSS injection cannot execute script and Stage 5 escaped every dynamic innerHTML sink. A class-based restyle removes it (deferred).
2. **Fail-open by design** on audit, evidence and rate-limiter D1 writes (availability over bookkeeping), and on the campaign lock when its table is missing (per-email idempotency remains the hard guarantee). Each fail-open is an explicit, tested policy — a silent one would be a bug.
3. **Fixed-window rate limiter** can admit up to 2× the cap across a window boundary; documented in `src/rate-limiter.ts`, caught in practice by the reactive `api_key_health` cooldown.
4. **No FK enforcement on existing tables** (SQLite cannot add FKs without a table rebuild); orphan prevention is structural (documented in stage-17).
5. **Audit log retention** — resolved post-V2 (Stage 25): the cron prunes `audit_logs` beyond `AUDIT_RETENTION_DAYS` (default 180, "0" = keep forever) and self-records each prune; a misconfigured value fails safe to the default, never more aggressive.
6. **Single `CREDENTIAL_ENC_KEY`** — rotation without panel re-entry resolved post-V2 (Stage 26): while `CREDENTIAL_ENC_KEY_PREVIOUS` is set, decryption falls back to the old master and the `keys/reseal` + `gmail/reseal` sweeps rewrite every row onto the current key (procedure in `docs/backup-recovery.md` §4). Losing the key entirely still means panel re-entry — that recovery path is unchanged.
7. **`uncertain` Gmail sends** require an operator decision by design (auto-retry could double-send); the panel surfaces them for review.
8. **`request_id` correlation for AI/Gmail-layer work** goes through `CAMPAIGN_*`/`RESEARCH_*` audit rows rather than every business row — a documented boundary of the traceability chain.
9. **Legacy plaintext credential rows** are tolerated until first read (lazy migration); the fail-closed path when the master key is absent is tested.
10. **A forgotten `OUTREACH_DRY_RUN` flag** would silently swallow every real send (rows would pile up with `dry-run-` message ids and no `gmail_send_log` trail) — the deployment runbook makes removing the flag the last step of every smoke pass, and the `dry-run-` prefix is the designed detection signal.

## Deferred Improvements

- Durable-Objects-based rate limiter — drop-in via the `RateLimiter` interface (the abstraction exists for exactly this).
- Class-based panel restyle → drop `style-src-attr 'unsafe-inline'`.
- ~~Audit retention/prune job + panel view over audit_logs~~ — done in post-V2 Stage 25 (`AUDIT_RETENTION_DAYS` cron prune, `/admin/api/audit-logs`, `/admin/audit`).
- ~~Automated `CREDENTIAL_ENC_KEY` rotation (re-encryption sweep) instead of panel re-entry~~ — done in post-V2 Stage 26 (`CREDENTIAL_ENC_KEY_PREVIOUS` + reseal sweeps).
- FK-adding table rebuilds for existing databases.
- ~~2FA (WebAuthn) for admin accounts~~ — done in post-V2 Stage 29 (opt-in two-step login + recovery codes + Bearer closure; `docs/stages/stage-29-webauthn.md`). Cloudflare Access as an alternative zero-trust perimeter remains an open option for environments that prefer managed identity.
- ~~Session inventory/admin-wide revocation UI~~ — done in post-V2 Stage 27 (`/admin/api/auth/sessions` + `/admin/sessions`, super_admin only).
- Per-row `request_id` on D1 business tables to shorten the traceability chain.

## Deployment Instructions

The full pipeline and smoke procedure is `docs/deployment-v2.md` (spec §31/§32). Summary:

1. **Secrets** (operator, via Wrangler — never in git): `ADMIN_PANEL_TOKEN`, `CREDENTIAL_ENC_KEY` (32 random bytes, base64), `GEMINI_API_KEY`, `GEMINI_MODEL` (+ optional `CAMPAIGN_LOCK_TTL_MS`). Verify with `npx wrangler secret list`.
2. **Deploy**: push to the deploy branch — GitHub Actions runs `schema.sql` (IF NOT EXISTS, idempotent), then the per-statement ALTER steps with `pragma_table_info` verification (self-healing, fail the deploy if a column is missing), then `wrangler deploy`. Never deploy by hand over production.
3. **Post-deploy smoke** (per `docs/deployment-v2.md`): read-only probes — `GET /health` (200 only when the D1 binding answers), `/admin`, `/admin/api/auth/me`, `/admin/api/customers` — then the dry-run exercise with `OUTREACH_DRY_RUN=true`: create test customer → research → generate → send. The flag makes every send a no-op through the full state machine (rows marked `dry-run-…`, no Gmail call, no quota trail), so **smoke tests can never send real email**; remove the flag afterwards.
4. **New installs**: `schema.sql` alone is sufficient (migrations 0005-0016 are for the pre-existing database; the workflow steps make them no-ops there). The Stage 23 drift fix is what makes this true — a fresh-install smoke test of quota reservation is part of the concurrency suite's fixture seeding.
5. **Backup posture** (per `docs/backup-recovery.md`): weekly `wrangler d1 export` off-platform, a Time Travel bookmark note before risky migrations, quarterly restore drill.

## Rollback Instructions

1. **Worker only**: `git revert` the offending commit(s) and push — CI redeploys the previous bundle. Every Security V2 schema change is additive (tables, columns, indexes); old code ignores them, so **no schema rollback is required** for a code revert.
2. **Data**: D1 Time Travel — `npx wrangler d1 time-travel info` / `restore` (in-place and destructive; the command prints an undo bookmark — record it before doing anything else). Window: 30 days (paid) / 7 days (free).
3. **Off-platform restore**: the weekly `wrangler d1 export` dump, per the runbook in `docs/backup-recovery.md`.
4. **Credentials after key loss/rotation**: re-enter credentials in the panel (each row's `key_hint` identifies which key sealed it); never delete rows to "fix" encryption — the lazy migration re-seals on next write once a valid key is present.

## Appendix: coverage of the original audit (建议.txt)

The audit that prompted this program, triaged item by item. Every item is either implemented or an explicitly documented deferral — nothing was silently dropped between audit → spec → implementation.

| Audit item | Status |
|---|---|
| P0 Admin Token = root key → sessions + role split | Implemented — Stages 2/3 |
| P0 Gmail quota check→send→log race | Implemented — Stage 11 (atomic reservation) |
| P0 Gmail double-send on worker timeout | Implemented — Stage 10 (state machine + idempotency) |
| P0 Cloudflare secret self-management (persistent-compromise chain) | Implemented — Stage 3 (surface removed) |
| P1 plaintext credentials tolerated in schema | Implemented — Stage 4 encryption + lazy migration; schema-level `CHECK(enc:v1:)` impossible on existing SQLite tables without rebuild → Remaining Risks #9 |
| P1 missing CSP/HSTS/X-Frame-Options | Implemented — Stage 5 (nonce CSP, stronger than the audit's `unsafe-inline` suggestion) |
| P1 single admin role | Implemented — Stage 3 (5 roles, deny-by-default) |
| P1 CSV without size/row/field limits | Implemented — Stage 8 (5 MB / 2 000 rows / 200 cols / 10 k-char fields, stricter than suggested) |
| P2 SSRF on customer domains | Implemented — Stage 7 (`assertPublicHttpUrl` choke point) |
| P2 search-result URLs treated as untrusted | Implemented — Stage 7: every dynamic outbound fetch (customer domains, search-result links, research/social URLs) funnels through `fetchWithTimeout` → guard; the only raw `fetch()` sites are compile-time-constant vendor endpoints (verified by call-site audit) |
| P2 per-isolate RPM drift | Implemented — Stage 16 (D1 global window + `RateLimiter` abstraction; DO limiter is the documented drop-in next step) |
| P2 research/contact data retention & bloat | Mostly — evidence versioning (Stage 14) stops re-research bloat and audit-log retention landed in post-V2 Stage 25; research/contact retention pruning remains deferred (audit log retention was Remaining Risks #5, now resolved) |
| P2 hardcoded lead-score rules | Partially — Stage 15 split `lead_score` from `completeness_score`; making weights configurable deferred |
| P3 no audit log | Implemented — Stage 9 (+ request-id correlation Stage 20) |
| P3 no backup/recovery strategy | Implemented — Stage 21 (`docs/backup-recovery.md`) |
| P3 no real task queue/lease | Accepted as documented design — atomic `UPDATE … RETURNING` claims (Stage 23-proven) cover current scale; queue migration is a Phase 3/4 architecture step (spec §35 forbids unmotivated big refactors) |
| Cloudflare Access instead of self-managed auth | Deferred improvement — sessions + RBAC + throttling implemented now; Access integration listed under Deferred Improvements (2FA/WebAuthn) |
| D1 database id in wrangler.toml | Implemented pre-V2 — placeholder + CI secret substitution |
| Evidence provenance (source_hash/content_hash/model/version) | Implemented — Stage 14 (`research_runs` carries parser_version, model_name, model_version; evidence rows carry source_id/source_hash/content_hash) |
| Indirect prompt injection from crawled content | Implemented — Stage 13 |
| Customers-table normalization (companies/people/facts; `full_research_text` out of customers) | Deferred — Phase 3 architecture evolution (audit's own recommendation order puts it after security/reliability); current split (contacts, evidence, research_runs, outreach_emails) is the incremental path |
| AI intelligence pipeline (fact extraction → entity resolution → scoring) | Deferred — Phase 4, beyond Security V2 scope |
