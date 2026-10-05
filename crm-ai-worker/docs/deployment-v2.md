# Deployment V2 — Safe Deployment & Production Smoke Tests

Security V2 spec §31/§32. This project has no staging environment, so this document defines the substitute pipeline that must be walked **every time** production changes, and the smoke procedure that follows every deploy. Standing rule (§31): never run `wrangler deploy` by hand over production — deploys go through CI.

## 1. The pipeline (spec §31)

```
local tests            migration validation           preview/staging         smoke test            production
(708 vitest tests,    (tsc --noEmit + wrangler      (none exists — the      (§32 below, with      (CI push of the
 tsc --noEmit,         deploy --dry-run proves the    dry-run build + CI      OUTREACH_DRY_RUN      reviewed branch;
 check-panel.mjs)      bundle builds and binds)       gate steps in the       on, then off)         CI runs schema.sql
                                                        workflow are the                              + column checks
                                                        substitute)                                   + deploy)
```

Concretely, before every deploy:

1. **Local tests** — `npm test` (708 tests: unit/stage suites + 72 security acceptance + 59 concurrency + dry-run/health + post-V2 suites), `npm run typecheck`, `node scripts/check-panel.mjs`. All must be green.
2. **Build validation** — `npx wrangler deploy --dry-run --outdir dist-dryrun` with `WRANGLER_SEND_METRICS=false`. Proves the bundle compiles and binds. Delete `dist-dryrun/` afterwards.
3. **Migration validation** — CI applies migrations idempotently and **verifies**: `schema.sql` runs with IF NOT EXISTS, then per-statement ALTER steps (duplicate-column tolerant), then `pragma_table_info` assertions that fail the deploy if any expected column is missing; the Stage 34 step conditionally rebuilds legacy `outreach_emails` with its FK declaration (skipped when the FK already exists, blocked over orphaned rows, single transaction). A deploy cannot succeed with a half-migrated database. Forward-only per §29; every change is additive, so an old worker on a new schema keeps working (backward compatibility, §30 — business data is never touched).
4. **Production** — push the reviewed branch; the workflow deploys. The worker is stateless; the only state is D1.

## 2. Secrets and variables checklist

| Name | Kind | Notes |
|---|---|---|
| `ADMIN_PANEL_TOKEN` | Wrangler secret | recovery/bootstrap identity, not a session |
| `CREDENTIAL_ENC_KEY` | Wrangler secret | 32 random bytes, base64 — AES-GCM master key |
| `GEMINI_API_KEY` | Wrangler secret | provider key |
| `GEMINI_MODEL` | Wrangler secret (optional) | model override |
| `CLOUDFLARE_D1_DATABASE_ID` | GitHub secret | CI substitutes the real D1 id into wrangler.toml (the repo carries a placeholder) |
| `OUTREACH_DRY_RUN` | var (optional) | **smoke tests only** — see §3. Remove after the smoke pass. |
| `CREDENTIAL_ENC_KEY_PREVIOUS` | Wrangler secret (optional) | old master during a key rotation; decrypt fallback while set. Run the reseal sweep (docs/backup-recovery.md §4), then **remove it** — it is a transition state, not a permanent second key |
| `AUDIT_RETENTION_DAYS` | var (optional) | audit_logs horizon: unset → 180 days, `"0"` → keep forever. Pruned by the 5-min cron; every non-empty prune writes an AUDIT_PRUNE row (see `/admin/audit`) |
| `DATA_RETENTION_DAYS` | var (optional) | business-data horizon (gmail_send_log / research_runs / superseded evidence / customer_imports): unset → 180 days, `"0"` → keep everything. Evidence is pruned superseded-only — live chains survive forever; the fixed 30-day admin_login_attempts sweep always runs. Non-empty prunes write a DATA_PRUNE audit row |
| `WEBAUTHN_RP_ID` | var (optional) | WebAuthn 2FA RP ID (bare domain). Unset → 2FA dormant. See §6 before setting it. |
| `WEBAUTHN_RP_NAME` | var (optional) | RP display name (defaults to `WEBAUTHN_RP_ID`) |
| `WEBAUTHN_ORIGINS` | var (optional) | comma-separated caller-origin allowlist (defaults to `https://<WEBAUTHN_RP_ID>`) |

## 3. Production smoke tests (spec §32)

Run after every deploy. Two phases: read-only probes, then a dry-run send exercise.

### Phase A — read-only probes

```bash
WORKER="https://<your-worker>.<account>.workers.dev"

curl -fsS "$WORKER/"            # expected: the landing/404 shape your deploy serves
curl -fsS "$WORKER/health"      # expected: {"ok":true,"service":"crm-ai-worker"} — 503 means the D1 binding is broken
curl -fsS -o /dev/null -w "%{http_code}\n" "$WORKER/admin"          # 200 (login page HTML)
curl -fsS -H "Authorization: Bearer <ADMIN_PANEL_TOKEN>" "$WORKER/admin/api/auth/me"     # 200, your identity + role + expiry
curl -fsS -H "Authorization: Bearer <ADMIN_PANEL_TOKEN>" "$WORKER/admin/api/customers"   # 200, JSON list
```

`/health` is an unauthenticated liveness probe that answers 200 only when the D1 binding answers a trivial query — it is the one endpoint that catches "deployed but database binding broken".

**2FA caveat (Stage 29)**: the two `Authorization: Bearer` probes above expect `200` only while WebAuthn 2FA is **dormant or off**. Once the bootstrap operator has an active credential, the Bearer path is closed by design and both probes answer `401` — that is the *passing* result in that state. Substitute a browser login (token + security key) and probe `/admin/api/auth/me` with the `crm_session` cookie, or temporarily remove the last credential.

### Phase B — dry-run exercise (no real email, ever)

**Precondition**: set `OUTREACH_DRY_RUN = "true"` (Dashboard → Worker → Settings → Variables, or temporarily in `wrangler.toml [vars]`) and let it apply (redeploy via CI, or set it before the deploy you are smoke-testing).

With the flag on, the send state machine runs end-to-end but the Gmail transport is a no-op: no Gmail API call, no quota reservation, no `gmail_send_log` row. Rows touched by the exercise are unmistakable — `gmail_message_id` starts with `dry-run-`. This is enforced in code (guard resolves before the real transport) and pinned by `tests/outreach-dry-run.test.ts`.

1. **Create a test customer** via the panel (name it clearly, e.g. `SMOKE-TEST-<date>`; use a domain you own or `example.com`).
2. **Research it** (panel button or let the 5-minute cron pick it up): verify the customer reaches `completed` with analysis fields, and `audit_logs` shows `START_RESEARCH`/`COMPLETE_RESEARCH` rows with the same `request_id` chain.
3. **Generate a test email** (draft): verify the draft exists with subject/body.
4. **Send it** (panel single-send, or a running campaign containing the test customer): verify the row flips to `sent` with a `dry-run-…` message id, **no `gmail_send_log` row appears**, and Gmail sent-mail shows nothing.
5. **Cleanup**: delete the test customer and its generated rows via the panel; confirm `audit_logs` records the deletions.
6. **Remove the flag** — `OUTREACH_DRY_RUN` off, redeploy, and re-run the Phase A probes. A forgotten dry-run flag would silently swallow every real send: the panel's sent rows would all carry `dry-run-` ids, which is also how you detect it.

**Default rule (§32): production smoke tests never send real Gmail.** If a smoke procedure ever needs the real transport, that is not a smoke test — it is a pilot campaign and needs its own plan.

## 4. Rollback

- **Code**: `git revert` + push; CI redeploys the previous bundle. All Security V2 schema changes are additive — the old worker ignores new columns/tables, no schema rollback needed.
- **Data**: D1 Time Travel (`npx wrangler d1 time-travel info` / `restore`) — in-place and destructive, prints an undo bookmark; window 30 days (paid) / 7 days (free). Weekly off-platform `wrangler d1 export` per `docs/backup-recovery.md`.
- **Credentials**: key loss/rotation → panel re-entry (each row's `key_hint` identifies the sealing key); recovery runbook in `docs/backup-recovery.md`.

## 5. Verification record

- Pipeline gate as of this document: 708/708 tests (57 files), `tsc --noEmit` clean, dry-run build 541.05 KiB (gzip 133.16 KiB), 7 panels clean.
- **outreach_emails FK rebuild (post-V2 Stage 34)**: legacy databases whose `outreach_emails` predates the FK declaration get it via a single-transaction rebuild (`migrations/0019_outreach_emails_fk_rebuild.sql`, wrangler `--file` = one implicit transaction). The CI step gates on `pragma_foreign_key_list` — skip when the FK exists, block with the cleanup SQL when orphaned drafts are found, verify FK + unchanged row count afterwards. Fresh installs are unaffected (schema.sql always declared the FK). Rolling back a Stage-34 deploy is safe: the table shape is unchanged (same columns, same indexes); only the constraint declaration differs, and old code never wrote orphans.
- Smoke-mechanism tests: `tests/health.test.ts` (probe contract), `tests/outreach-dry-run.test.ts` (dry-run guard).
- **request_id columns (post-V2 Stage 33)**: `outreach_emails` / `gmail_send_log` / `customer_imports` gain a nullable `request_id` via the CI idempotent ALTER block (`migrations/0018_business_request_ids.sql` is the change record; fresh installs get the columns straight from schema.sql). Old rows keep NULL — the column only populates from the first deploy onward. No smoke step: the column is exercised by the first generate/send/import.
- **Durable Objects (post-V2 Stage 32)**: `wrangler.toml` declares the `RATE_LIMITER` binding + a one-time SQLite migration for `RateLimiterDO`. `wrangler deploy` applies the migration automatically on the first deploy carrying it; no D1 step and no operator action. The limiter is active from that deploy (true global sliding window). Rolling back to a pre-Stage-32 bundle is safe: old code simply ignores the binding.

## 6. Enabling WebAuthn 2FA (post-V2 Stage 29) — read before setting `WEBAUTHN_RP_ID`

2FA is **opt-in and dormant** until both of these are true: `WEBAUTHN_RP_ID` is set, and the operator has registered at least one security key / passkey. Sequence:

1. Set the vars (Dashboard → Worker → Settings → Variables, or `wrangler.toml [vars]`): `WEBAUTHN_RP_ID` = the bare domain users visit (no scheme/port); optionally `WEBAUTHN_RP_NAME`; optionally `WEBAUTHN_ORIGINS` (defaults to `https://<RP_ID>` — add every origin callers actually use, e.g. the custom domain *and* the `workers.dev` route, comma-separated). Redeploy via CI.
2. Log in (still single-factor at this point) and open **🛡️ 安全设置** (`/admin/security`). Add the key: the browser's `navigator.credentials.create()` dialog runs; on success the panel prints **10 one-time recovery codes** — copy them into a password manager *now*, they are never shown or recoverable again.
3. From this moment login is two-step: token → 安全密钥/恢复码 → session. **The Bearer master-token API path is closed** (`Authorization: Bearer <ADMIN_PANEL_TOKEN>` answers 401 on every admin API route). This is deliberate — a second factor that scripts can skip by moving the token into a header would be decoration. Any automation must either drive a real login (token + key / recovery code → `crm_session` cookie) or you must not enable 2FA.
4. Lockout / break-glass: if the key is lost, sign in with a recovery code (each burns after one use; the MFA page offers the form under "无法使用安全密钥？"). With a live session, `/admin/security` can register a replacement key or regenerate the code set (regeneration invalidates ALL previous codes, used and unused). If key and codes are both gone, the operator is locked out of the panel — recovery then requires removing the credential rows from D1 directly (`UPDATE webauthn_credentials SET revoked_at = CURRENT_TIMESTAMP;` via `wrangler d1 execute`) or a Time Travel restore to a pre-enrollment bookmark; runbook in `docs/backup-recovery.md` §4.
5. Turning 2FA off = removing the last credential in `/admin/security` (audited as `WEBAUTHN_REVOKE`). Bearer re-opens immediately. Unsetting `WEBAUTHN_RP_ID` also puts the feature back to sleep but leaves the credential rows in place — prefer the panel removal, which is explicit and audited.

## 7. Putting the admin panel behind Cloudflare Access (post-V2 Stage 35)

Cloudflare Access is an **outer perimeter** in front of the admin surface: the edge authenticates the caller against your identity provider and injects a signed `Cf-Access-Jwt-Assertion` into every request it forwards. It **composes with** (does not replace) the inner auth — callers still need a session, and WebAuthn 2FA still applies on top. Enabling it is a two-layer decision: the edge app (dashboard) plus the code-side gate (deploy state).

**Why the code-side gate exists**: edge enforcement alone is dashboard state — one mis-scoped or deleted Access application silently removes the perimeter. With `CF_ACCESS_TEAM` + `CF_ACCESS_AUD` set, the worker itself verifies every `/admin` request's assertion against the team's JWKS (audience pinned to your app's AUD, `iss` pinned to the team, `exp`/`nbf` checked, ES256/RS256 signatures verified, fail-closed on every error). The perimeter then lives in `wrangler.toml` + CI, where a change is reviewed and a removal is visible.

Sequence:

1. **Prerequisite**: the admin hostname must be a domain in a Cloudflare zone you control (edge Access does not cover `workers.dev` — see the note below). Point the zone's DNS/proxy at the worker route or custom domain first.
2. **Create the Access application**: Zero Trust dashboard → Access → Applications → *Add a self-hosted application*. Set the application domain to the admin hostname, path `/admin` (subpaths are covered). Configure the sign-in policy (your IdP, allowed emails/groups). Save.
3. **Copy the AUD tag**: on the application's page, note the **AUD tag** (a hex string).
4. **Set both vars** (`wrangler.toml [vars]`, uncommented) and redeploy via CI:
   - `CF_ACCESS_TEAM` — your Zero Trust team subdomain (the `<team>` in `https://<team>.cloudflareaccess.com`);
   - `CF_ACCESS_AUD` — the AUD tag from step 3.
   Set **both or neither**: a half-configured deploy answers **500 on every /admin request** (loud by design — a typo must never silently disable the perimeter).
5. **Smoke**: with the edge app active, a browser visit to `/admin` redirects to the IdP first, then the panel login. A direct request without an assertion gets a plain `401 {"detail":"Cloudflare Access authentication required"}` — that shape is the code gate talking; if you see it in a browser, the edge app's domain/path does not cover the URL being visited. `GET /health` is outside `/admin` and stays public (probes keep working).
6. **Automation / CI smoke against a perimeter-enabled deployment**: the assertion is only injected by the edge after Access authentication, so plain `curl` cannot pass. Use an Access **service token** (Zero Trust → Service Tokens): send `CF-Access-Client-Id` + `CF-Access-Client-Secret` headers on every request; the edge validates them and injects the assertion the code gate verifies. Alternatively, run the §3 smoke before enabling the perimeter.

Behavior notes:

- **Fail-closed everywhere**: missing/invalid/expired assertion, unknown signing key after a bounded rotation refetch, or an unreachable JWKS endpoint → `401`. The team's certs endpoint is fetched with a 10s timeout and cached for 1 hour (module-per-isolate); an unknown `kid` triggers at most one refetch per 60s.
- **Key rotation** is automatic: Access rotates signing keys rarely; the gate refetches the JWKS when a token carries a `kid` the cached keys lack (bounded, see above).
- **Audit posture**: perimeter rejections are `safeLog`-only (never an audit row) — they are internet-scanner noise, the same policy as the WebAuthn gate. Session-level events (login, 2FA) keep their audit rows.
- **`workers.dev` caveat**: without a zone you cannot create the edge app, so browser users have no way to obtain an assertion — do not enable the vars there. (If you must lock down a `workers.dev` deployment for scripts only, the code gate + service tokens technically work, but the recommended posture is a custom domain + edge app.)
- **Rollback / disable**: remove both vars and redeploy — the gate goes dormant, no data involved. The edge app can stay; it is harmless.
- **Order of gates on every /admin request**: Cloudflare Access (when configured) → origin guard → session auth (+ WebAuthn when active) → RBAC.
