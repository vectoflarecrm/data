# Stage 4 Report — Credential Encryption V2

Branch: `feature/security-v2` · Follows: Stage 3 (secret management removal)

## Goal (spec §5)
Every API key / Gmail credential must end up encrypted-at-rest (`enc:v1:`),
legacy plaintext stays readable during migration, migration replaces a
plaintext row **only after verification**, and no API response leaks
credential plaintext.

## What already existed (audited, not rewritten)
The V1 encryption work predates Security V2 and is in good shape:
- `src/credential-crypto.ts` — AES-GCM + HKDF-derived cipher/fingerprint keys,
  `enc:v1:<iv>:<ct>` format, `key_hint` display form, HMAC fingerprints.
- All write paths already fail closed and encrypt: `POST /admin/api/keys`,
  `POST /admin/api/keys/bulk` (fingerprint dedupe), `POST /admin/api/gmail/accounts`.
  Neither PATCH endpoint can touch the credential column. Legacy plaintext
  rows remain readable (`decryptSecret` passthrough).
- `GET /admin/api/keys` masks `api_key` to a hint; `GET /admin/api/gmail/accounts`
  never selects `private_key`.

## Changes
- **`/admin/api/keys/encrypt-all`** now implements the full spec §5.2 flow:
  plaintext → encrypt → **verify decrypt roundtrip** → **verify fingerprint** →
  replace. A row that fails either check is skipped with a reason and keeps
  its working plaintext; a structured audit line
  (`[security-v2:credential-migration] table=… id=… event=encrypted-verified`)
  is logged per conversion — console until the Stage 9 `audit_logs` table
  lands, then it gains a DB sink.
- **`/admin/api/gmail/encrypt-all`** gets the same verification gate, an
  up-front `isEncryptionConfigured` fail-fast (previously a missing key threw
  mid-loop), and a `failed` array in its response.
- No schema changes: `api_configs.key_hint/key_fingerprint` and
  `gmail_accounts` already carry everything needed.

## Tests (+9 → 206 total)
- `tests/credential-crypto.test.ts` — original 19 tests kept verbatim; four
  Stage-4 edge tests added: tampered **IV** (GCM authenticates it), non-base64
  payload surviving the format check, `isEncryptionConfigured` non-throwing
  contract, `isEncrypted` nullish/empty edges. Spec §5.4 mapping: encrypt ✓
  decrypt ✓ wrong key ✓ (original) tampered ciphertext ✓ (body + IV) invalid
  format ✓ legacy plaintext ✓ migration ✓ (below).
- `tests/credential-api.test.ts` — new Gmail migration tests: fail-fast
  refuses without a key (rows untouched), converts both credential types with
  verification and stays idempotent, stored rows still decrypt via the real
  send-path helper; plus two §5.3 redaction pins: `GET /admin/api/gmail/accounts`
  never contains `private_key` (even for legacy plaintext rows),
  `GET /admin/api/keys` returns hint/marker/`encryption` state but never the
  stored value.

## Verification
- `npm run typecheck`: pass
- `npm test`: **206/206 pass** (was 197)
- `node scripts/check-panel.mjs`: 4 panels clean
- `npx wrangler deploy --dry-run` (offline): pass

## Security Risks Fixed
- Baseline P1: encrypt-all previously replaced a plaintext credential with
  ciphertext it had not verified (encrypt-then-blind-write). A transient
  crypto fault would have swapped a working key for an undecryptable one. Now
  the plaintext row is only replaced after a proven decrypt roundtrip and
  fingerprint match.
- Gmail pool migration could half-abort on a missing key; now fails before
  any write.

## Process note (self-correction)
An earlier draft of this stage accidentally overwrote the pre-existing
`tests/credential-crypto.test.ts` (19 tests from the baseline). It was
restored from `main` verbatim before commit and only the four genuinely new
edge tests were appended — no existing test was lost (206 = 197 + 4 + 5).

## Backward Compatibility
- No migrations; no API shapes changed beyond the additive `failed` array in
  the gmail encrypt-all response.
- Legacy plaintext rows keep serving; conversion stays operator-triggered and
  idempotent.

## Remaining Risks
- Audit lines are console-only until Stage 9 (`audit_logs`).
- `POST /admin/api/keys/encryption-key` returns a freshly **minted** key
  value by design (the operator must save it to Cloudflare; since Stage 3 the
  Worker cannot write its own secrets, so there is no other channel). It is a
  new credential being created, not a stored one — documented exception to
  the §5.3 redaction rule.
- Deep response-redaction enforcement (recursive scan of all responses) is
  Stage 14.
