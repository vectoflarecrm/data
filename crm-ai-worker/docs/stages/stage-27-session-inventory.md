# Stage 27 — Session inventory, admin-wide revocation, session hygiene (post-V2)

Closes the deferred item "session inventory/admin-wide revocation UI" (the
non-WebAuthn half of the 2FA/deferral line).

## What shipped

1. **Inventory** — `GET /admin/api/auth/sessions` (super_admin only): every
   active session across all users joined with `admin_users` — session id,
   user, role, created/expiry, last_seen, `ip_hash` — plus an `is_current`
   flag for the caller's own row. Revoked and expired rows are invisible;
   token material never leaves the table. Cap 200, newest first.
2. **Single-session revocation** — `POST /admin/api/auth/sessions/revoke`
   `{session_id}` (super_admin only): revokes ANY user's session (the
   existing `/admin/api/auth/revoke` only reaches the caller's own rows).
   400 without an id, 404 on unknown ids, idempotent on already-revoked
   rows; audit row `REVOKE_SESSION` with `target_user_id`.
3. **Admin-wide revocation** — `POST /admin/api/auth/revoke-all` (super_admin
   only): flips every active session. The session-cookie caller's OWN row is
   deliberately spared — an operator responding to an incident must not lock
   themselves out mid-response; the Bearer bootstrap path (no session row)
   revokes everything. Audit row `REVOKE_ALL_SESSIONS` `{revoked, kept_current}`.
   - All three endpoints do their own role check with the gate's
     ACCESS_DENIED audit shape (rbac maps `/admin/api/auth/*` to no
     permission by design — session lifecycle).
4. **Panel** — `/admin/sessions` (`SESSIONS_PANEL_HTML`, server-side 403 for
   non-super_admin before any HTML is served): live table with per-row
   revoke buttons and a confirmed "吊销其他所有会话" action. Same Stage 5
   escaping discipline.
5. **Hygiene** — `src/auth/session-hygiene.ts`: the 5-min cron deletes
   `admin_sessions` rows expired more than a fixed 7-day inspection grace
   ago (deliberately NOT configurable — vacuum, not policy; the grace keeps
   a just-expired session inspectable during an incident). Own fail-open
   envelope in `scheduled()` so neither prune job can break the other or
   the research tick; missing table → silent 0, other D1 errors → logged
   and swallowed by the caller.

## Verification

- `tests/session-inventory.test.ts` — 16 tests: prune unit matrix (grace
  boundary / missing table / error propagation), scheduled integrations
  (vacuum on tick, explodeOn fail-open), inventory (cross-user listing,
  is_current, revoked/expired invisible, no token_hash, readonly 403 +
  ACCESS_DENIED audit, anon 401), single revoke (kills another user's
  session — verified via /auth/me 401 —, 400/404/idempotent, readonly 403
  leaves rows untouched), revoke-all (session caller survives + others die
  + audit shape, Bearer revokes everything, non-super_admin denied), panel
  (soft wall / 403 / render / 405).
- Full suite 594/594 (50 files), `tsc` exit 0, dry-run 467.21 KiB / gzip
  116.66 KiB, 6 panels clean (check-panel picked up SESSIONS_PANEL_HTML).

## Notes for the operator

- Incident playbook: open `/admin/sessions` → identify the rogue row (ip_hash
  + login time) → revoke it, or flip the table with revoke-all (you stay
  logged in) → rotate the master token if the compromise is at the token
  level.
- Session rows survive 7 days past expiry for inspection, then the cron
  vacuums them.
