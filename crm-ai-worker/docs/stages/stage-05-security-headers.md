# Stage 5 Report — Security Headers, Panel XSS, D1 ID Removal

Branch: `feature/security-v2` · Follows: Stage 4 (credential encryption v2)

## Goal (spec §6)
Every `/admin` response carries the baseline header set (nosniff, DENY,
no-referrer, Permissions-Policy, HSTS), HTML responses get a nonce-based CSP
(no `unsafe-eval`), remaining panel XSS sinks are escaped, and the real D1
`database_id` leaves the repo. Residual CSP debt is recorded in the baseline
document, not silently kept.

## Changes

### 1. `src/security-headers.ts` (new)
- `applySecurityHeaders(response)` — merges the five static headers plus
  `Cache-Control: no-store` onto any response; headers already present win so
  the nonce CSP from `htmlResponse()` is never clobbered.
- `htmlCsp(nonce)` — `default-src 'self'`; `script-src`/`style-src` nonce-based;
  `object-src 'none'`; `base-uri`/`form-action 'self'`; `frame-ancestors 'none'`;
  `img-src 'self' data: blob:`.
- `jsonCsp()` — `default-src 'none'; frame-ancestors 'none'`, also the
  fail-closed fallback for any response reaching the wrapper without a CSP.
- Responses are mutated in place: every response in this module is a
  user-constructed `new Response(...)` (fetch-spec "response" guard, mutable)
  and no `Response.redirect()` is used.

### 2. `src/admin.ts` — central application point
- `handleAdminRequest` is now a thin wrapper: `routeAdminRequest` (the old
  body) produces the response, the wrapper stamps headers on everything
  except `null` (non-admin paths stay index.ts's business). HTML, JSON, 303
  redirects and the plain-text 404 all pass through.
- `htmlResponse()` mints a fresh `crypto.randomUUID()` nonce per response and
  rewrites every `<script>`/`<style>` tag (all tags in the templates are
  attribute-free, which the exact-string replaceAll relies on; verified by
  grep: 3 `<script>`, 4 `<style>`, zero other occurrences).

### 3. `src/admin.ts` — KEYS panel XSS (baseline risk #7)
The KEYS panel script had **no `esc()` helper at all** — every DB-sourced
string flowed raw into `innerHTML`:
- key rows: `k.label`, `k.model`, `k.last_error`, the `k.api_key` hint (sliced
  from raw key material, so pasted "keys" could contain HTML) and the provider
  cell;
- cooldown/history rows: `c.key_index`, `c.last_error`, the `until` timestamp
  (raw DB string on the `Date` parse fallback);
- settings rows: `s.default_model` / `s.rpm_total` interpolated into
  `value="…"` attributes (attribute breakout).
All now go through a new `esc()` helper (same implementation as the other
panels) and a `providerName()` wrapper that also handles unknown providers.
The outreach and main panels were re-audited line by line: they already escape
via their own `esc()` (the baseline's "campaign member name" finding referred
to pre-V2 line numbers; current campaign rendering is escaped).

### 4. `crm-ai-worker/wrangler.toml` — D1 ID removal (baseline risk #8)
- Real `database_id` (`fb20ea82-…`) replaced with
  `REPLACE_WITH_D1_DATABASE_ID`; a comment points local devs at
  `npx wrangler d1 list`.
- The CI "Configure D1 database ID" step previously *skipped* when the
  placeholder was missing (it was a no-op while the real id sat in the repo).
  It now **fails hard** if the placeholder is absent, so a real id cannot
  quietly re-enter the repo.
- Verified: `wrangler deploy --dry-run` passes with the placeholder in place
  (wrangler only resolves the id at real deploy time, which happens in CI
  after substitution). Repo-wide UUID scan finds no other real resource ids.

## CSP tech debt (recorded, per spec §6)
`style-src-attr 'unsafe-inline'` remains: the panels use `style=""` attributes
extensively and attributes cannot carry a nonce. CSS injection cannot execute
script, and Stage 5 also closes every dynamic innerHTML sink, so the residual
risk is defacement. Tracked in `docs/security-v2-baseline.md` (debt register);
full removal needs a class-based restyle, out of V2 scope.

## Tests (+15 → 221 total)
`tests/security-headers.test.ts`:
- header baseline: login HTML, authed panel HTML, JSON API (`auth/me`), 401
  failure, 303 redirect (Set-Cookie survives the wrapper), plain-text 404,
  and the null passthrough contract for non-admin paths;
- nonce CSP: every `<script>`/`<style>` tag carries the header's nonce, no
  un-nonces tag remains, nonce is fresh per response, `unsafe-eval` absent,
  `unsafe-inline` confined to `style-src-attr`, `object-src 'none'`;
- KEYS panel escaping: source pins that `esc()` is defined before row
  rendering and wraps label/model/last_error/key hint/key index/timestamps
  and the settings `value="…"` attributes.

## Verification
- `npx tsc --noEmit`: pass
- `npm test`: **221/221 pass** (was 206, +15)
- `node scripts/check-panel.mjs`: 4 panels clean (helper additions don't
  break the extracted scripts)
- `npx wrangler deploy --dry-run` (offline, placeholder id): pass

## Security Risks Fixed
- Baseline **#7 (P1)**: stored XSS in the KEYS panel — an upstream provider
  error string, a hostile key label, or even a pasted "key" containing HTML
  executed as script in the operator's session (which is an authenticated
  admin session). Now escaped at every sink; CSP nonce removes
  `unsafe-inline`/`unsafe-eval` as a safety net for future regressions.
- Baseline **#8 (P1)**: real D1 database id in a public repo (target
  enumeration for anyone with the Cloudflare account id). Removed; CI now
  enforces its absence.
- Baseline **#9 (P1)**: no CSP/HSTS/X-Frame-Options/nosniff/Referrer-Policy/
  Permissions-Policy. All present on every admin response; clickjacking
  (DENY + `frame-ancestors 'none'`), MIME sniffing, referrer leakage and
  permission grants are off the table.

## Not done (by design)
- No `Content-Security-Policy-Report-Only` rollout phase — the nonce injection
  is exercised by the full test suite and the panels are single-tenant admin
  tooling; a report-only phase would add a deploy cycle without adding signal.
- `style=""` attributes kept (see tech debt above); no restyle of panels.
