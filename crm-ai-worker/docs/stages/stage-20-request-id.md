# Stage 20 — Request ID / Traceability (spec §21)

**Status: complete.** Commit: `security-v2: add request id traceability`
Test surface: 403/403 (6 new in `tests/request-id.test.ts`), tsc clean, dry-run 439.04 KiB, 4 panels clean.

## What the spec asked for (§21, 架构.txt L1419-1442)

Every Admin/API request generates an `X-Request-ID` (UUID format), threaded request → service → D1 → AI → Gmail → audit, so one can answer: “这一封邮件为什么被发送？”

## What already existed (audit findings — no rework needed)

- `audit_logs.request_id` column (schema.sql, Stage 9) and `AuditEvent.requestId` (audit-log.ts, added back then with the comment "Correlates with the Stage 20 request id once that middleware lands").
- `writeAuditLog` already persists `event.requestId ?? null`.
- `auditAdminAction(env, request, auth, …)` already receives the `Request` on every admin action — the carrier only needed a place to stash the id.
- `handleAdminRequest` already funnels **every** admin response (HTML, JSON, 303, 404) through one wrapper — the single mint/stamp point.

## Changes

- `crm-ai-worker/src/security/request-context.ts` (new) — `setRequestId(request, id)` / `getRequestId(request)`: a module-level `WeakMap<Request, string>`. Concurrency-safe (no "current id" global — Workers serves many requests in one isolate), zero function-signature churn, and the entry dies with its `Request`.
- `crm-ai-worker/src/admin.ts`:
  - `handleAdminRequest` mints `crypto.randomUUID()` (client-supplied `X-Request-ID` is **never** trusted — a spoofed id must not poison the audit chain), stores it in the context, and stamps every non-null response via `withRequestId()`.
  - `withRequestId(response, id)` rebuilds the `Response` (`new Headers(...)` + `new Response(response.body, …)`) instead of mutating — immune to `immutable`-guarded headers in any runtime. Ordered so `applySecurityHeaders` runs on the rebuilt response and its `has()`-checks preserve both the new header and existing CSP/nonce.
  - `auditAdminAction` injects `requestId: getRequestId(request)` — every admin audit row now lands in D1 with the same id the caller can read from the response header.
  - `internalErrorResponse(context, error, request?)` reuses the context id when available (falling back to a fresh UUID for non-request callers) so a 500's `request_id` body field, the `X-Request-ID` header and the `safeLog` error line all carry the same value; all 6 call sites (gmail-account-save, gmail-encrypt-all, outreach-api, campaign-api, admin-api, admin-router) pass their `request`.
- `crm-ai-worker/tests/request-id.test.ts` (new, 6 tests) — header present + UUID format on API responses; panel HTML carries it too; fresh id per request; client-supplied id ignored; `audit_logs.request_id` equals the response header id after a PATCH (UPDATE_CUSTOMER row); a forced 500 (D1 exploding on `api_configs`) has `body.request_id === header` and both are UUIDs.

## §21's six-layer chain — actual landing

| Layer | How the id reaches it |
|---|---|
| request | minted in `handleAdminRequest`, returned as `X-Request-ID` on every admin response |
| service | `request-context.ts` WeakMap — any handler/service holding the `Request` can `getRequestId()` |
| D1 | every admin audit row (`auditAdminAction`) stores it in `audit_logs.request_id`; cron/system rows keep `null` |
| AI | Gemini calls run inside a request whose id is in the audit row that brackets them (RESEARCH_*/CAMPAIGN_* events); the AI API itself carries no id |
| Gmail | Gmail API calls correlate via the CAMPAIGN_* audit rows written around them (outreach/send already logs per-customer results); Gmail's API has no request-id passthrough to populate |
| audit | `writeAuditLog` persists `event.requestId`; the 500 path prints the same id via `safeLog` |

Documented boundary: business rows (e.g., `outreach_emails`) are **not** tagged per-request — that would need schema changes; the audit chain (who triggered, which request, what the campaign decided) is the answering mechanism for “这封邮件为什么被发送”.

## Decisions

- **WeakMap keyed by `Request`, not a module-scoped "current id"** — concurrent requests in one isolate would clobber each other with a global; the WeakMap needs no cleanup and touches no existing signatures.
- **Server always mints** — trusting a client header would let an attacker forge correlation ids (log-poisoning / audit-row shadowing). Tested explicitly.
- **Rebuild the response instead of mutating headers** — some runtimes guard `Response.headers` against writes; `new Response(response.body, …)` is universally safe and streams the body unread.
- **500 path reuses the context id** — the operator greps one UUID and gets the response the caller saw, the audit row, and the log line.
- No changes to `audit-log.ts` — the Stage 9 hooks were designed for exactly this; Stage 20 only supplies the value.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **403/403 (29 files)**, including 6 new request-id tests.
- `npx wrangler deploy --dry-run --outdir dist-dryrun` — Total Upload 439.04 KiB.
- `node scripts/check-panel.mjs` — 4 panels clean.

Baseline #19 fully closed in `docs/security-v2-baseline.md` (response redaction Stage 18 + safe logging Stage 19 + request-id Stage 20).
