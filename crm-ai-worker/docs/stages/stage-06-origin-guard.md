# Stage 6 Report — CSRF / Origin Protection

Branch: `feature/security-v2` · Follows: Stage 5 (security headers + panel XSS)

## Goal (spec §7)
On top of the existing `SameSite=Strict` session cookie, every state-changing
`/admin` request (POST/PUT/PATCH/DELETE) must prove it is same-origin: check
`Origin` against `Host`; same-origin passes, foreign-origin gets 403, and the
missing-Origin case gets an explicit, documented policy (spec §7.1).

## Changes

### `src/security/origin-guard.ts` (new)
- `originGuardRejection(request)` — returns a 403 response for
  state-changing requests carrying a foreign `Origin`; `null` otherwise.
- Comparison is full-origin (`scheme://host:port` via `new URL(...).origin`),
  derived from `request.url` (built by the runtime from `Host`), so scheme and
  port mismatches are rejected alongside host mismatches.
- `Origin: null` (sandboxed frames) and unparseable Origin values are treated
  as foreign; a request whose own URL cannot be parsed fails closed.
- The 403 carries `Vary: Origin` and the standard JSON error shape; the Stage
  5 wrapper still stamps the full security-header set on it.

### `src/admin.ts` — single enforcement point
Wired at the top of `routeAdminRequest`, immediately after the `/admin` path
check and **before** routing, authentication, RBAC, or any handler side
effect. A foreign-origin caller learns nothing about credentials (403 even
without any) and no handler runs.

### Missing-Origin policy (deliberate, documented)
Allowed. Rationale: every browser that can attach the session cookie
(SameSite-capable, i.e. all of them) sends `Origin` on non-GET requests per
the Fetch spec — so an Origin-less state-changing request is a non-browser
client (curl, scripts, tests) whose credentials are explicit (Bearer header
or body token) and therefore not CSRF-able. `Referer` is deliberately not
consulted: this Worker answers `Referrer-Policy: no-referrer`, so its own
panel sends no Referer — `Origin` is the only header that survives our own
policy.

## Tests (+18 → 239 total)
`tests/csrf.test.ts`:
- **same-origin passes**: Bearer POST to `auth/logout` → 200 `{ok:true}`;
  form login POST → 303; PATCH to a nonexistent customer → 404 (business
  answer, not the gate's 403); passing responses keep the Stage 5 headers.
- **foreign rejected**: POST with `Origin: https://evil.example` → 403
  (with and without credentials — the gate leaks no auth state); PUT/PATCH/
  DELETE all gated; `Origin: null`, scheme mismatch (`http://` on an `https://`
  host), port mismatch (`:8443`), and unparseable Origin all → 403; the 403
  carries `Vary: Origin` + full header set; foreign-origin form login → 403
  and never echoes the operator's token.
- **missing-Origin policy pinned**: Origin-less POST passes (explicit
  credentials), Origin-less POST without credentials still fails auth (401,
  not the gate's 403).
- **safe methods never gated**: GET `/admin` and GET `auth/me` serve
  normally with a foreign Origin; HEAD/OPTIONS untouched.

## Verification
- `npx tsc --noEmit`: pass
- `npm test`: **239/239 pass** (was 221, +18; no existing test needed an
  Origin header, confirming the allow-policy for programmatic clients)
- `npx wrangler deploy --dry-run` (offline): pass

## Security Risks Fixed
- Baseline **#10 (P1)**: the admin API relied solely on `SameSite=Strict`.
  Any future cookie-scope slip, browser quirk, or SameSite downgrade would
  have left state-changing routes open to cross-site requests from
  authenticated browsers. Now a foreign `Origin` is rejected independently,
  before auth or side effects — two unrelated layers must both fail before
  CSRF is possible.

## Not done (by design)
- No CSRF-token mechanism: double-submit tokens would break the
  Bearer-authenticated programmatic API surface and add nothing over
  Origin + SameSite=Strict for fetch-based panel calls.
- Non-admin routes need no gate: index.ts routes everything else to a
  plain 404 (verified — the Worker's only HTTP surface is the admin router
  plus cron).
