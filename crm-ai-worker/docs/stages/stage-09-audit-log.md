# Stage 9 Report — Audit Log

Branch: `feature/security-v2` · Follows: Stage 8 (CSV import limits)

## Goal (spec §10)
Every important admin/cron operation must produce a tamper-evident trail
row, while §10.2 forbids secrets from ever landing in it. Stage 9 adds the
`audit_logs` table, a standalone `src/audit/audit-log.ts` writer with
metadata redaction and client-fingerprint hashing, and instruments every
§10.1 action across the admin API and the cron research pipeline.

## Changes

### `migrations/0008_audit_log.sql` (new) + `schema.sql`
- `audit_logs` table per spec §10: `id` (uuid PK), `actor_user_id`,
  `actor_role`, `action`, `resource_type`, `resource_id`, `request_id`,
  `metadata_json`, `ip_hash`, `user_agent_hash`, `created_at`.
- Indexes: `created_at` (timeline queries), `resource_type/resource_id`
  (per-object history), `actor_user_id` (per-actor history).
- Appended to `schema.sql` (CI runs it every deploy, so existing databases
  gain the table automatically); the numbered migration exists for
  manual/remote parity with all prior stages.

### `src/audit/audit-log.ts` (new, standalone — no dependency on admin.ts)
- `redactAuditMetadata(metadata)` — §10.2 enforcement, applied **before**
  serialization:
  - denylist key matching is normalization-based (lowercase, strip
    `-`/`_`/spaces), so `API-KEY`, `apiKey` and `refresh-token` all match;
    listed keys: apikey, privatekey, clientsecret, refreshtoken,
    accesstoken, password, sessiontoken, token, secret, credential(s),
    authorization, bearer, cookie → value replaced with `[REDACTED]`;
  - benign look-alikes (`key_hint`, `keys_added`, `token_count`) survive;
  - depth cap 4 (deep nesting collapses to `[REDACTED]`);
  - serialized JSON capped at 4096 bytes — oversized values get a second
    pass that clips string leaves to 200 chars, and if still oversized the
    metadata is replaced by `{truncated: true, original_bytes: n}` (row is
    always written, never dropped for size).
- `writeAuditLog(env, request, event)` — single INSERT:
  - `id = crypto.randomUUID()`, `created_at` as `YYYY-MM-DD HH:MM:SS`
    (matching the rest of the schema's timestamp style);
  - `ip_hash` / `user_agent_hash` = SHA-256 of `CF-Connecting-IP` /
    `User-Agent` — raw values never stored; absent (cron / null request)
    → NULL columns;
  - **fail-open** (spec: an audit failure must never break the business
    action): a `no such table: audit_logs` error (migration pending, test
    fixture without the table) is a *silent* no-op; any other failure is
    `console.error("[audit] write failed", …)` for `wrangler tail` and the
    business response proceeds untouched.

### `src/admin.ts` — instrumentation
- `auditAdminAction(env, request, auth, action, resourceType, resourceId,
  metadata)` helper wraps `writeAuditLog` with the authenticated actor
  (system events pass `auth.user = null`).
- **Auth lifecycle**: form + API login success → `LOGIN` (`via` metadata);
  wrong password → `LOGIN_FAILED` (never the attempted value); form logout
  authenticates *before* revoking so the trail knows who was revoked;
  API logout → `LOGOUT`.
- **Central authorization gate**: 401 on state-changing methods
  (non-GET/HEAD/OPTIONS) → `ACCESS_DENIED {reason: "unauthenticated"}`;
  403 → `ACCESS_DENIED {reason: "forbidden", permission, method}` with the
  resource path as `resource_id`. GET probes are deliberately not audited
  (a scanner must not be able to flood the trail). `ACCESS_DENIED` is an
  addition beyond the §10.1 list, required by §10.3's "failed
  authorization → audit row" test.
- The gate now passes its resolved `auth` into the four API handlers
  (`handleProviderKeysApi`, `handleCampaignApi`, `handleOutreachApi`,
  `handleAdminApi`) — the gate is the single point that already knows the
  actor; handlers no longer re-derive it.
- **Action sites** (metadata records field *names*, counts and enums —
  never values, since e.g. labels can carry hints):
  - API keys: `CREATE_API_KEY` (single: `resource_id` = new row id;
    bulk: `{provider, added, skipped, via: "bulk"}`),
    `UPDATE_API_KEY` (PATCH `{provider, fields: [...]}`;
    encrypt-all `{via, converted, remaining}`; clear-cooldowns; provider
    settings PUT recorded as `resource_type: provider_settings`),
    `DELETE_API_KEY`.
  - Gmail accounts: `CREATE_GMAIL_ACCOUNT {client_email, credential_type}`
    (the private key itself never enters metadata), `UPDATE_GMAIL_ACCOUNT
    {fields}`, `DELETE_GMAIL_ACCOUNT`, gmail encrypt-all.
  - Outreach: `GENERATE_EMAIL` (ad-hoc `{brand, limit, generated}` and
    campaign `{via: "campaign-generate", …}`), `SEND_EMAIL` (batch
    `{attempted, sent, failed}`, single `{ok}`, campaign send).
  - Campaigns: `CREATE_CAMPAIGN {brand, group_id, members, capped}`,
    `UPDATE_CAMPAIGN` (status), `DELETE_CAMPAIGN`.
  - Customers: `IMPORT_CSV` (`resource_id` = import id, `{file_name,
    inserted, matched, skipped, total_rows}` — CSV body never in the
    trail), `UPDATE_CUSTOMER {fields: [...]}`, pre-filter queue →
    `START_RESEARCH {via: "pre-filter", queued}`.

### `src/index.ts` — cron research lifecycle
- `processCustomer` now returns `{update, outcome: "completed" | "failed"
  | "retry", reason?}` (all four return sites wrapped, including the
  relevance-precheck skip).
- The scheduled handler: after `claimCustomers` each customer gets
  `START_RESEARCH {company_id, via: "cron"}` (actor = system, NULL
  fingerprints); **after** `env.DB.batch(...)` applies the updates,
  outcomes are written as `COMPLETE_RESEARCH` / `FAIL_RESEARCH` (reason
  sliced to 300 chars). Writing after the batch keeps the trail
  consistent with what the database actually accepted; retried rows are
  not audited (the next claim emits a fresh `START_RESEARCH`).

## Tests (+18 → 287 total)
`tests/audit-log.test.ts` — spec §10.3 list plus unit coverage:
- **§10.2 redaction unit**: null passthrough; benign metadata unchanged;
  every denylist key redacted nested and inside arrays; key-spelling
  normalization (`API-KEY`/`apiKey`/`refresh-token`); look-alike benign
  keys survive; depth cap; oversized metadata clipped to ≤4096 and still
  valid JSON.
- **`writeAuditLog` unit**: row shape (actor/action/resource/metadata);
  `ip_hash`/`user_agent_hash` are SHA-256 hex of the header values (raw
  IP never stored); null request → NULL fingerprints; timestamp format.
- **Fail-open unit**: a D1 INSERT failure resolves without throwing and
  logs via `console.error`; a database without the `audit_logs` table is
  a silent no-op (no console noise for migration-pending windows).
- **§10.3 through the real router**:
  - successful action → `IMPORT_CSV` row (actor `u_admin`/`super_admin`,
    outcome counts in metadata) and `UPDATE_CUSTOMER` row (field names
    recorded, edited *values* absent);
  - failed authorization → operator PATCH on a provider key → 403 +
    `ACCESS_DENIED` row carrying `permission: providers.write`;
  - unauthenticated POST → `ACCESS_DENIED {unauthenticated}` while an
    unauthenticated GET probe writes nothing;
  - `LOGIN`/`LOGOUT` rows for the API session lifecycle; `LOGIN_FAILED`
    row exists and the wrong-guess string appears in **no** column of
    **no** row (same scan asserts the real password and session token
    never leak after a successful login);
  - secret values never appear: creating an API key writes
    `CREATE_API_KEY` (provider + new id) and the key value appears
    nowhere in the trail;
  - pre-filter queue → `START_RESEARCH {via: "pre-filter", queued}`.

## Verification
- `npx tsc --noEmit`: pass
- `npm test`: **287/287 pass** (was 269, +18; 18 files)
- `node scripts/check-panel.mjs`: 4 panels clean
- `npx wrangler deploy --dry-run` (offline): pass

## Security Risks Fixed
- Baseline **#13 (P1)**: no audit log. Every §10.1 action, every
  authorization failure on state-changing routes, and the cron research
  lifecycle now produce rows with actor identity, redacted metadata and
  hashed (not raw) client fingerprints; the writer cannot take the
  business action down with it.

## Not audited (by design)
- `CREATE_CUSTOMER` / `DELETE_CUSTOMER`: no such endpoints exist —
  customers are only created via `IMPORT_CSV` (which is audited).
- 429 login throttling is not recorded as `LOGIN_FAILED` — only actual
  credential failures are (a locked-out probe tells no truth about the
  password).
- Gmail `/test` (a read-only connectivity probe), outreach email
  PATCH/DELETE and contact-group CRUD are outside the §10.1 action list;
  revisit when the spec grows them.
- `outcome: "retry"` is not audited (see rationale above).

## Forward links
- Stage 4's encrypt-all console lines now have their table: subsequent
  stages (and a future users-management surface per Stage 2's deferral
  note) write here via `auditAdminAction`.
- Stage 22's integration suite extends `audit-log.test.ts` with any
  actions added by Stages 10-21 (campaign send/gmail lifecycle events).
