# Stage 29 — WebAuthn 2FA for the admin panel (post-V2)

Closes the 2FA/WebAuthn half of the final report's deferred-improvements
entry (Cloudflare Access remains deferred as the alternative path).

## Threat model

The panel's single factor is the `ADMIN_PANEL_TOKEN` — a static bearer
secret held by one operator. Phishing, log leakage, or a stolen copy of
the token is full compromise. Stage 29 adds a second factor the operator
*holds* (a security key / passkey) with a printed-code break-glass path,
without inventing a user-management surface the project does not have.

## Semantics

- **2FA is active for a user ⟺ they hold ≥ 1 active `webauthn_credentials`
  row AND `WEBAUTHN_RP_ID` is configured.** Dormant by default: unset the
  var and nothing changes for anyone.
- While active, login is two-step: master token → 202 assert challenge
  (JSON API) or the MFA step page (form login) → authenticator signature
  or recovery code → session cookie.
- **The Bearer master-token path is closed while the bootstrap user has an
  active credential** (src/admin.ts `authenticate()`). A second factor that
  scripts can skip by moving the token into an `Authorization` header would
  be decoration. Rejection is `safeLog`-only, never an audit row — a
  hammering automation client must not be able to flood `audit_logs`.
  Credential-lookup failure also fails closed.
- Removing the last credential (audited `WEBAUTHN_REVOKE`) turns 2FA off
  and re-opens Bearer immediately.

## What shipped

- `migrations/0017_webauthn.sql` (+ schema.sql): `webauthn_credentials`,
  `webauthn_challenges`, `webauthn_recovery_codes` — all FK → `admin_users`,
  additive, backward compatible.
- `src/auth/webauthn.ts` — the crypto core, no dependencies:
  - strict CBOR decoder (definite lengths only; floats/tags/indefinite/
    duplicate map keys rejected; node/depth/byte caps),
  - authenticator-data parser (AT/UP/UV/ED flags, credential-id bounds),
  - COSE→JWK for ES256 (-7, EC2 P-256) and RS256 (-257) only,
  - P1363↔DER signature normalization — **verified on Node 24: webcrypto
    ECDSA emits and accepts raw P1363, not DER**; `verifyWebCrypto` tries
    the wire format first, then DER, so both runtime conventions pass,
  - registration verification (fmt must be `"none"` with empty attStmt,
    rpIdHash/UP/AT checked, credential-id uniqueness) and assertion
    verification (owner check, challenge/origin/rpIdHash, UP, real
    WebCrypto verify, clone rule: reject only when both counters are
    nonzero and the new one did not advance; a 0 report never lowers the
    stored counter — passkey-safe),
  - challenge store: single-use via conditional DELETE (parallel double-
    spend of a flow is impossible), TTL 300 s, cron vacuum
    (`cleanupExpiredChallenges`, missing-table ⇒ 0),
  - recovery codes: 10 × 64-bit hex `xxxx-xxxx-xxxx-xxxx`, stored as
    SHA-256, compared constant-time, single-use via conditional UPDATE.
- `src/admin.ts` — seven endpoints (all `/admin/api/auth/*`, so the RBAC
  gate maps them to no permission; role checks live in the handlers):
  `POST /mfa/assert`, `POST /mfa/recovery`,
  `POST /webauthn/register/options`, `POST /webauthn/register/verify`,
  `GET /webauthn/credentials[?user_id=]`,
  `DELETE /webauthn/credentials/{id}[?user_id=]`,
  `POST /webauthn/recovery/regenerate`.
  Cross-user listing/revocation is super_admin-only and audited
  (`ACCESS_DENIED` otherwise). Failed MFA attempts share the login
  throttle (ip + global buckets) and audit `LOGIN_FAILED {via, reason}`;
  `LOGIN {via: mfa|recovery}` on success. Expired flows answer 410.
- `/admin/security` (soft-walled like the other panels): credential list,
  add (browser `navigator.credentials.create()`), remove, recovery-code
  generation with copy-to-clipboard. The MFA step page is a function
  (`mfaChallengePage`) carrying the challenge in a
  `<script type="application/json">` data block (`<` escaped), so the
  nonce CSP set is untouched.
- `src/index.ts`: `WEBAUTHN_RP_ID/RP_NAME/ORIGINS` on Env + third
  fail-open cron envelope for the challenge vacuum.

## Deliberate scope cuts

- Attestation conveyance is `"none"` — no attStmt trust-chain parsing,
  no vendor allowlist surface.
- No username/password store: the master token remains factor 1
  (knowledge); WebAuthn/recovery codes are factor 2 (possession). With a
  single-operator panel this is the honest scope.
- alg whitelist ES256/RS256 — fewer algorithms, fewer pitfalls.

## Verification

- `tests/webauthn-helpers.ts` — test-side CBOR **encoder** + real P-256
  fixtures (registrations/assertions are genuinely signed; the src side
  verifies them for real — a pass means the crypto path works end to end).
- `tests/webauthn-unit.test.ts` — 20 tests: b64u round-trip, CBOR accept/
  reject matrix (duplicate map keys hand-encoded — the `Map` constructor
  would dedupe), authenticator-data parse matrix, COSE→JWK (+ live verify),
  P1363→DER structure, rpConfig, recovery-code shape.
- `tests/webauthn-flow.test.ts` — 28 tests: enrollment options shape,
  first-credential recovery-code mint, second enrollment (no new codes,
  excludeCredentials, cookie-auth — Bearer is already closed), duplicate
  credential id, foreign origin, packed-attestation rejection, 503/401,
  cross-user flow 403 + audit; Bearer closed while active / re-opened
  after last-credential removal; 202 + allowCredentials, assert → working
  session + `LOGIN via mfa` + sign_count/last_used_at, flow replay 401,
  origin/challenge/credential/rpIdHash/signature failures 401 + throttle +
  audited reasons, expired flow 410, malformed body 400, clone-counter
  rejection + zero-counter passkey pass, disabled user 401, 5 failures →
  429 (flows pre-issued: a successful token login clears the ip bucket),
  direct login when dormant per-user and when RP unconfigured, recovery
  happy/normalization/reuse/regeneration, super_admin cross-user list +
  revoke vs readonly 403s, cron vacuum + missing-table 0, soft-walled
  `/admin/security` + MFA page data block.
- Full suite **642/642 (52 files)**, `tsc --noEmit` clean, dry-run
  520.55 KiB / gzip 127.65 KiB, `check-panel.mjs` 7 panels clean
  (SECURITY_PANEL_HTML: 12 ids).

## Operational notes

- Rollout, Bearer-closure implications for scripts, and lockout break-
  glass: `docs/deployment-v2.md` §6, `docs/backup-recovery.md` §4,
  `wrangler.toml` comments.
- Audit vocabulary added: `WEBAUTHN_REGISTER {first_credential}`,
  `WEBAUTHN_REVOKE {target_user_id, was_last_credential}`,
  `WEBAUTHN_RECOVERY_REGEN {count}`, `LOGIN {via: mfa|recovery}`,
  `LOGIN_FAILED {via, reason}` (reasons: origin_rejected,
  challenge_mismatch, credential_unknown, rpid_mismatch, bad_signature,
  clone_suspected, user_disabled, recovery_code_invalid, flow_expired,
  flow_unknown).
- Migration order: 0017 is pure CREATE TABLE/INDEX + one INSERT OR IGNORE
  bootstrap guard — idempotent, forward-only, old-worker safe.
