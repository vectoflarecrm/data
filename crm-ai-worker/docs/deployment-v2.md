# Deployment V2 — Safe Deployment & Production Smoke Tests

Security V2 spec §31/§32. This project has no staging environment, so this document defines the substitute pipeline that must be walked **every time** production changes, and the smoke procedure that follows every deploy. Standing rule (§31): never run `wrangler deploy` by hand over production — deploys go through CI.

## 1. The pipeline (spec §31)

```
local tests            migration validation           preview/staging         smoke test            production
(661 vitest tests,     (tsc --noEmit + wrangler       (none exists — the      (§32 below, with      (CI push of the
 tsc --noEmit,         deploy --dry-run proves the    dry-run build + CI      OUTREACH_DRY_RUN      reviewed branch;
 check-panel.mjs)      bundle builds and binds)       gate steps in the       on, then off)         CI runs schema.sql
                                                        workflow are the                              + column checks
                                                        substitute)                                   + deploy)
```

Concretely, before every deploy:

1. **Local tests** — `npm test` (661 tests: unit/stage suites + 72 security acceptance + 59 concurrency + dry-run/health + post-V2 suites), `npm run typecheck`, `node scripts/check-panel.mjs`. All must be green.
2. **Build validation** — `npx wrangler deploy --dry-run --outdir dist-dryrun` with `WRANGLER_SEND_METRICS=false`. Proves the bundle compiles and binds. Delete `dist-dryrun/` afterwards.
3. **Migration validation** — CI applies migrations idempotently and **verifies**: `schema.sql` runs with IF NOT EXISTS, then per-statement ALTER steps (duplicate-column tolerant), then `pragma_table_info` assertions that fail the deploy if any expected column is missing. A deploy cannot succeed with a half-migrated database. Forward-only per §29; every change is additive, so an old worker on a new schema keeps working (backward compatibility, §30 — business data is never touched).
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

- Pipeline gate as of this document: 661/661 tests (53 files), `tsc --noEmit` clean, dry-run build 530.25 KiB (gzip 130.59 KiB), 7 panels clean.
- Smoke-mechanism tests: `tests/health.test.ts` (probe contract), `tests/outreach-dry-run.test.ts` (dry-run guard).

## 6. Enabling WebAuthn 2FA (post-V2 Stage 29) — read before setting `WEBAUTHN_RP_ID`

2FA is **opt-in and dormant** until both of these are true: `WEBAUTHN_RP_ID` is set, and the operator has registered at least one security key / passkey. Sequence:

1. Set the vars (Dashboard → Worker → Settings → Variables, or `wrangler.toml [vars]`): `WEBAUTHN_RP_ID` = the bare domain users visit (no scheme/port); optionally `WEBAUTHN_RP_NAME`; optionally `WEBAUTHN_ORIGINS` (defaults to `https://<RP_ID>` — add every origin callers actually use, e.g. the custom domain *and* the `workers.dev` route, comma-separated). Redeploy via CI.
2. Log in (still single-factor at this point) and open **🛡️ 安全设置** (`/admin/security`). Add the key: the browser's `navigator.credentials.create()` dialog runs; on success the panel prints **10 one-time recovery codes** — copy them into a password manager *now*, they are never shown or recoverable again.
3. From this moment login is two-step: token → 安全密钥/恢复码 → session. **The Bearer master-token API path is closed** (`Authorization: Bearer <ADMIN_PANEL_TOKEN>` answers 401 on every admin API route). This is deliberate — a second factor that scripts can skip by moving the token into a header would be decoration. Any automation must either drive a real login (token + key / recovery code → `crm_session` cookie) or you must not enable 2FA.
4. Lockout / break-glass: if the key is lost, sign in with a recovery code (each burns after one use; the MFA page offers the form under "无法使用安全密钥？"). With a live session, `/admin/security` can register a replacement key or regenerate the code set (regeneration invalidates ALL previous codes, used and unused). If key and codes are both gone, the operator is locked out of the panel — recovery then requires removing the credential rows from D1 directly (`UPDATE webauthn_credentials SET revoked_at = CURRENT_TIMESTAMP;` via `wrangler d1 execute`) or a Time Travel restore to a pre-enrollment bookmark; runbook in `docs/backup-recovery.md` §4.
5. Turning 2FA off = removing the last credential in `/admin/security` (audited as `WEBAUTHN_REVOKE`). Bearer re-opens immediately. Unsetting `WEBAUTHN_RP_ID` also puts the feature back to sleep but leaves the credential rows in place — prefer the panel removal, which is explicit and audited.
