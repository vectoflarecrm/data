# Stage 35 — Cloudflare Access perimeter, enforced in code (post-V2)

The last item on the deferred list: Cloudflare Access. The decision this
stage makes explicit: Access is a **complementary outer perimeter**, not a
replacement for the self-managed auth — and for it to be a real security
boundary rather than dashboard wishful thinking, the worker enforces it in
code.

## The problem with edge-only enforcement

Cloudflare Access sits in front of the admin hostname: the edge
authenticates the caller against the IdP and injects a signed
`Cf-Access-Jwt-Assertion` JWT into every request it forwards. Edge
enforcement alone, however, is **dashboard state** — the Access
application's scope lives in the Zero Trust console, not in git. One
mis-scoped or deleted application silently removes the perimeter; nothing
in the deploy pipeline would notice. (Stage 29 made the same argument from
the other side: a second factor scripts can skip would be decoration. An
edge perimeter dashboards can silently delete is the same decoration.)

## The design

When `CF_ACCESS_TEAM` + `CF_ACCESS_AUD` are both set, every `/admin`
request must carry an assertion that verifies in the worker:

- **JWKS**: fetched from `https://<team>.cloudflareaccess.com/cdn-cgi/
  access/certs` (10s timeout), parsed strictly (only EC/RSA keys with a
  `kid` are kept), cached per-isolate for 1 hour. An unknown `kid` — the
  signature of a key rotation — triggers one bounded refetch per 60s, so
  rotation recovers automatically while a garbage-kid flood cannot hammer
  the endpoint.
- **Claims**: `iss` pinned to the team, `aud` pinned to the application's
  AUD tag (string or array claim), `exp`/`nbf` with a 60s clock-skew
  allowance, `alg` allowlisted to ES256/RS256 (`none` and friends
  rejected).
- **Signatures**: verified with WebCrypto over the exact
  `header.payload` bytes. Compact-JWS ES256 signatures are raw r||s
  (P1363) — exactly what WebCrypto's ECDSA verify expects, so no DER
  wrangling; RS256 is PKCS#1 v1.5 over SHA-256. Zero new dependencies —
  `b64uDecode` is shared with the Stage 29 WebAuthn verifier.
- **Fail-closed on every error class**: missing assertion, malformed
  token, bad signature, expired, wrong audience, unreachable JWKS → 401.
  A **half-configured env (exactly one var set) → 500, loud**: a typo
  must never silently disable the perimeter — the same fail-safe
  direction as the retention knobs. An invalid team name → 500 too.
- **Audit posture**: safeLog only, never an audit row — perimeter
  rejections are internet-scanner noise, the Stage 29 policy (the gate
  sits before the request-id-minted session layer but rejections still
  leave through the standard response pipeline, so they carry
  X-Request-ID and the security headers for log correlation).
- **Dormant by default**: both vars unset → zero behavior change; the
  existing suite (which never sets them) runs through the same code path.

## Gate order

`routeAdminRequest` now runs, for every `/admin` path (pages, API,
unknown routes alike — a perimeter rejection must not disclose routes):

    Cloudflare Access (when configured) → origin guard → session auth
    (+ WebAuthn when active) → RBAC → handler

The perimeter says nothing about accounts or routes: generic
`{"detail":"Cloudflare Access authentication required"}` 401s, specific
reasons only in the worker log.

## Why this is not decoration

- The perimeter becomes **deploy state**: enabling/removing it means
  editing `wrangler.toml` and going through CI review — visible, diff-able,
  gated by the test suite.
- It composes: an attacker needs Access identity **and** panel session
  **and** (if enabled) the WebAuthn key.
- It works even where the edge cannot: on a `workers.dev` deployment no
  zone exists to attach an Access app to, but the code gate + service
  tokens still give scripts-only deployments a real assertion requirement
  (the runbook recommends the custom-domain posture for humans).

## Changes

- `src/security/cf-access.ts` — the module: strict JWS parsing + claim
  checks + WebCrypto verification (`verifyAccessToken` pure core), JWKS
  fetch/cache/rotation-refetch, and `checkCloudflareAccess` (the gate:
  returns allow/reject; rejections are safeLogged internally, rendered by
  the caller).
- `src/admin.ts` — gate wired into `routeAdminRequest` before the origin
  guard; `AdminEnv` gains `CF_ACCESS_TEAM?`/`CF_ACCESS_AUD?`.
- `src/index.ts` — `Env` gains the same optional fields.
- `wrangler.toml` — commented vars block documenting both keys and the
  both-or-neither rule.
- `docs/deployment-v2.md` §7 — the operator runbook: Access app creation,
  AUD tag, service tokens for CI smoke, workers.dev caveat, rollback.

## Tests — `tests/cf-access.test.ts` (26)

Fixtures mint **real JWTs with WebCrypto** (EC P-256 and RSA keypairs,
subtle.sign), so signature paths run end to end; the JWKS endpoint is an
injected fetcher (no test touches the network).

- Core (`verifyAccessToken`, 12): valid ES256 / valid RS256 / aud-as-array
  / within-skew expiry accepted; tampered payload, imposter key under a
  declared kid, wrong aud, wrong iss, expired beyond skew, future nbf,
  unknown kid, `alg=none` + malformed shapes, kid-exists-but-wrong-kty
  rejected.
- Gate (`checkCloudflareAccess`, 11): dormant when unset; 500 on
  half-configuration and invalid team name; 401 on missing assertion with
  **zero fetches**; allow via injected JWKS; JWKS cache survives a broken
  endpoint (1 fetch, second request allowed); fail-closed 401 on
  unreachable endpoint and on garbage responses; rotation recovery (new
  key rejected while refetch is bounded, allowed after the 60s bound with
  exactly 2 fetches); garbage-kid flood never exceeds 1 fetch per bound
  window.
- Integration (3): the admin surface returns the standard rejection shape
  (JSON detail + X-Request-ID + security headers) with the perimeter on;
  500 through the surface on a half-configured env; the login page is
  untouched with the perimeter off.

## Verification

- `npm test`: **708/708** (57 files; +26 vs Stage 34's 682/56).
- `tsc --noEmit`: clean.
- `wrangler deploy --dry-run`: 541.05 KiB / gzip 133.16 KiB
  (+8.13 / +1.92 KiB — the new module; the gate is one await on an
  already-hot path).
- `node scripts/check-panel.mjs`: 7 panels clean.
- Docs: final report (Stage 35 bullet, gate order, deferred item struck,
  audit-table row), deployment-v2.md (§7 runbook, pipeline gate), this
  report.

## Deferred list — status

Everything self-contained is now closed: DO rate limiter (32), per-row
request_id (33), FK rebuild (34), Cloudflare Access (35). What remains is
architecture-scale by design: Phase 3 (customers-table normalization /
research-engine restructuring) and Phase 4 (AI intelligence pipeline) —
both require a scope decision, not a deferred engineering item.
