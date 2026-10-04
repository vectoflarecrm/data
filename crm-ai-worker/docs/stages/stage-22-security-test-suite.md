# Stage 22 — Security Test Suite (spec §23)

**Status: complete.** Commit: `security-v2: add security acceptance test suite`
Test surface: 475/475 (72 new across `tests/security/`), tsc clean, dry-run 439.08 KiB, 4 panels clean.

## What the spec asked for (§23, 架构.txt L1464-1481)

Create `tests/security/` with at least: auth, rbac, csrf, ssrf, credential-redaction, credential-encryption, csv-limits, headers, audit-log, prompt-injection test files.

## Deliverable

`crm-ai-worker/tests/security/` — the acceptance suite: 10 spec-named test files + `_helpers.ts` (shared FakeD1-over-schema.sql fixtures), **72 tests**. Positioning: the stage-by-stage suites (28 existing files) pin each stage's units; this suite drives every check end-to-end through the single public entry point (`handleAdminRequest` → origin guard → auth → RBAC gate → handler → redaction → headers), so it verifies the *composition* of the security layers, which is exactly what per-stage unit tests cannot see.

| File | Focus |
|---|---|
| auth.test.ts | unauthenticated panel/API get nothing (no data leak in login HTML, JSON 401s); wrong Bearer/cookie rejected; minted sessions work; 5 bad logins → 429 + Retry-After; LOGIN_FAILED audited without the attempted token; master token never echoed |
| rbac.test.ts | whole-matrix walk (every role × read/mutate); providers.write/credentials.write denials name the missing permission; unmapped routes 404 for all roles (no gate bypass); ACCESS_DENIED is itself audited; route→permission map pinned; unknown role fails closed at BOTH layers (schema CHECK + `roleHasPermission`) |
| csrf.test.ts | foreign-Origin POST dies before auth and before side effects (no customer row, no audit row); same-origin/missing-Origin pass; GET exempt; sandboxed `Origin: null` refused; unparseable Origin refused; the login form itself guarded |
| ssrf.test.ts | 27-case refusal battery (v4 private/loopback/metadata incl. shorthand/hex/integer forms, v6 loopback/link-local/ULA/v4-mapped, banned suffixes, bad schemes, garbage) + 4 allowed cases + substring non-over-blocking + malformed-IPv6 parser + **trailing-dot smuggling (found & fixed, see below)** |
| credential-redaction.test.ts | cross-stage sweep: seeded provider key + Gmail PEM are `enc:v1:` in D1 yet appear in **none** of 8 GET surfaces nor a 500 body nor any audit row; `key_hint` present, `api_key` field gone |
| credential-encryption.test.ts | save-through-API encrypts; decrypt round-trips; hint identifies without disclosing; missing key → 400 fail-closed with nothing stored; wrong key / tampered ciphertext rejected (GCM), never garbled; key-minting endpoint never echoes current key |
| csv-limits.test.ts | happy path imports (`inserted: 1`); byte cap via chunked stream without Content-Length; row/column/field caps via the API; non-string csv → 400 with nothing imported; import requires customers.write |
| headers.test.ts | full Stage-5 baseline on JSON, panel HTML (nonce CSP that the HTML actually uses), text 404, login 303, and 500s; no-store; X-Request-ID on API and 500; origin-guard rejection carries nosniff |
| audit-log.test.ts | PATCH → UPDATE_CUSTOMER row with `request_id === X-Request-ID` header; GETs write nothing; CREATE_API_KEY/DELETE_API_KEY audited without plaintext; audit-store failure does NOT block the action (fail-open) and the business effect still lands; session actor recorded (`actor_user_id`/`actor_role`) |
| prompt-injection.test.ts | layer 2 acceptance: hijacked model output in markdown/prose → rejected; contract fields enforced (no partial write); injected `score`/`send_email`/`recipient` fields dropped by typed reconstruction; entry bar drops non-qualifying "contacts"; prose-in-a-name stays inert data; genuine contacts not over-blocked; layer-1 framing still present on all three prompt surfaces |

## Two real defects the suite caught (both fixed)

1. **RBAC campaign-send misroute** (`src/auth/rbac.ts`): `requiredPermission` read the campaign action from `parts[4]` — the numeric id — instead of `parts[5]`, so `POST /admin/api/outreach/campaigns/:id/send` never matched `"send"` and was gated as `campaigns.write`. Consequence: the `sender` role (granted `outreach.send` by the Stage 2 matrix precisely so it can send) got 403 on campaign sends. Fail-closed direction (no hole), but the matrix was not being enforced as designed. Fixed to read `parts[5]`; pinned by the route-map test. Baseline #6 updated.
2. **SSRF trailing-root-label bypass** (`src/security/outbound-url.ts`): `https://localhost./` — DNS resolves the trailing-dot form to loopback, but the literal `host === "localhost"` comparison and the `.localhost` suffix check both missed it (the hostname ends with `.`, not `.localhost`). Hostnames now have trailing dots stripped before every check (`localhost.`, `127.0.0.1.`, `host.internal.` all refused). Baseline #11 updated.

Both are minimal, additive corrections in the fail-closed direction of each stage's intent; all 28 pre-existing test files pass unchanged.

## Decisions

- **Acceptance positioning, not duplication**: existing stage suites stay untouched (no test file was moved, renamed or weakened — the 严禁重写 rule); the new suite exists to test the composition of layers through the public entry point. Overlap with unit suites is intentional (the same invariant asserted at a different level); each file also adds edges the units lack (e.g. the throttled-login + audit pair, the whole-role×route matrix walk, the cross-surface redaction sweep, typed-reconstruction leak checks).
- **Shared `_helpers.ts`** (FakeD1 + schema.sql + session minting + `call()` through `handleAdminRequest`): 10 files would otherwise repeat ~100 lines of fixture each; the file is not a `.test.ts` so vitest ignores it as a suite. `makeEnv({explodeOn})` turns any SQL substring into a failure point — that is how the 500-path and audit-fail-open tests drive their faults without mocks of internal modules.
- **Fixture bugs found while writing** (fixed in the test files, not the product): audit column is `metadata_json`; a forged role cannot even be inserted (Stage 17 CHECK) so the fail-closed test asserts both layers instead of a impossible row; `EncryptedSecret.cipher` is the full stored value; undici needs `duplex: "half"` for stream bodies and recomputes Content-Length for string bodies (a lying Content-Length header cannot be constructed, so the 413-by-declared-length case stays covered by the existing stage-8 suite).
- **Prose-in-a-name is data, not a hole**: a hostile "first_name" survives the contact entry bar as an inert string. That is correct layer-2 behavior (the value can only be rendered escaped or stored; there is no path from a name field to a send/mutate decision) — the test documents this explicitly rather than demanding impossible sanitization.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **475/475 (38 files)**: 403 pre-existing + 72 new; 0 regressions from the two src fixes (rbac/ssrf/campaigns/campaign-lock suites re-run green).
- `npx wrangler deploy --dry-run --outdir dist-dryrun` — Total Upload 439.08 KiB.
- `node scripts/check-panel.mjs` — 4 panels clean.
