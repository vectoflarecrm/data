# Stage 1 Report — Authentication Session Upgrade

Branch: `feature/security-v2` · Follows: Stage 0 (baseline)

## Files Changed
- `src/admin.ts` — replaced master-token cookie auth with server-side sessions; new `/admin/api/auth/*` endpoints; login mints sessions; logout revokes server-side.

## Files Added
- `migrations/0007_auth_sessions.sql` — `admin_users` + `admin_sessions` (forward-only, idempotent).
- `tests/auth-sessions.test.ts` — 22 tests.

## Migration Added
`0007_auth_sessions.sql`. CI applies `schema.sql` (which now carries the same tables + `INSERT OR IGNORE` bootstrap user) on every deploy, so the tables exist before the new Worker code goes live. Rollback limitation: forward-only; rolling back drops all sessions (operators re-login) but touches no business data.

## Implementation
- Cookie `crm_session=<256-bit random hex>`; `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=3600` (spec cap).
- D1 stores **only** `SHA-256(token)` (`admin_sessions.token_hash`); IP and User-Agent are also stored hashed.
- `authenticate()` is the single entry point: explicit `Authorization: Bearer <ADMIN_PANEL_TOKEN>` maps to a synthetic super_admin context (bootstrap/migration credential — browsers never attach Authorization headers automatically, so it cannot act as a persistent browser session); otherwise the session cookie resolves via D1 (revoked / expired / disabled-user ⇒ 401).
- Session lookup failures (e.g. table missing pre-migration) **fail closed** (401 + log), never 500.
- Login still throttled per-IP + global (`admin_login_attempts`, unchanged).
- Rotation: re-login presenting an old session cookie revokes it and mints a fresh token (cookie-fixation defense: server always generates the token).
- New endpoints: `POST /admin/api/auth/login` (JSON), `POST /admin/api/auth/logout`, `GET /admin/api/auth/me`, `POST /admin/api/auth/revoke` (all sessions of the user, or one by `{session_id}`).
- `/admin/logout` (form) now revokes server-side, not just cookie-clearing.
- `crm_admin_token` cookie removed entirely — the master token no longer rides in a cookie.

## Tests Added (22, all passing)
valid form+JSON login · hashed storage (raw token absent from DB) · session unlocks panel + /auth/me · wrong credentials mint nothing · session cookie rejected as login credential · unknown token 401 · malformed cookie 401 · expired 401 · revoked 401 · disabled user 401 · missing-table fail-closed 401 · single-user binding · form logout revokes instantly (acceptance criterion) · API logout · rotation · cookie fixation · revoke-all · revoke-one · Bearer works · wrong Bearer beats cookie · wrong cookie 401.

Existing test suites updated to authenticate via `Authorization: Bearer` (admin-hardening ×2, credential-api, facets) and session tables added to the admin-hardening fixture.

## Verification
- `npm test`: **184/184 pass** (was 162; +22)
- `npm run typecheck`: pass
- `node scripts/check-panel.mjs`: 5 panels clean
- `npx wrangler deploy --dry-run`: pass

## Security Risks Fixed
- Master token was the long-lived browser session (P0 #1 in baseline): any cookie leak = permanent root compromise with no revocation path. Now: opaque short-lived sessions, hashed at rest, instantly revocable.

## Backward Compatibility
- One-time operator impact: existing `crm_admin_token` cookies stop working after deploy; a single re-login is required.
- `Authorization: Bearer <ADMIN_PANEL_TOKEN>` programmatic access unchanged.
- No API route shapes, business tables, or panel behavior changed.

## Remaining Risks
- Sessions are absolute 1h (no sliding renewal): operator re-logs hourly. Spec-mandated (Max-Age ≤ 3600); sliding renewal tracked as deferred improvement.
- Single hard-coded operator (`u_admin`); additional users/roles arrive with Stage 2 RBAC.
- Session validation adds one indexed D1 read per admin request (by design — revocation must be immediate, so no isolate cache).
