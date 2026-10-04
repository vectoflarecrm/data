# Stage 26 — CREDENTIAL_ENC_KEY rotation (post-V2 improvement)

Closes final-report Remaining Risks #6 and the "Automated
CREDENTIAL_ENC_KEY rotation (re-encryption sweep) instead of panel
re-entry" deferred item.

## What shipped

1. **Rotation window support** (`src/credential-crypto.ts`):
   - New optional secret `CREDENTIAL_ENC_KEY_PREVIOUS` (the old master
     during a rotation). `getPreviousEncKeys()` imports it with the same
     32-byte/base64 validation as the current key.
   - `decryptSecret` tries the current key first, then falls back to the
     previous one. Format damage keeps the original `密文格式损坏` error
     (distinct from a key mismatch); a row matching neither key fails
     closed with a new explicit message.
   - New `tryDecryptSecret(stored, keys)` — null on failure instead of
     throwing — exported so the sweeps can discriminate "sealed with the
     current key" from "sealed with the previous one" without exceptions
     as control flow.
2. **Rotation sweeps** (credentials.write, i.e. super_admin only):
   - `POST /admin/api/keys/reseal` — rewrites EVERY `api_configs` row not
     sealed under the current master: previous-key rows AND leftover
     legacy plaintext (a rotation visit must not leave plaintext behind).
     Same Stage 4 verification gate as encrypt-all (roundtrip + fingerprint
     before replacing a live row); refreshes `key_hint`/`key_fingerprint`
     (fingerprints are HMAC-derived from the master, so they MUST be
     recomputed under the new key); invalidates provider caches.
   - `POST /admin/api/gmail/reseal` — same contract over
     `gmail_accounts.private_key` (no fingerprint columns there, so the
     gate is the roundtrip alone).
   - Both are idempotent (current-key rows counted as `already_current`,
     never touched), report `resealed` / `already_current` /
     `plaintext_remaining` / `failed[]` (undecryptable rows are kept and
     reported loudly, never destroyed), and write one audit row each
     (`via: "reseal"`, never credential material). A malformed
     `CREDENTIAL_ENC_KEY_PREVIOUS` surfaces as 400 configuration feedback,
     not a 500.
3. **Docs**: `docs/backup-recovery.md` §4 rotation row now spells out the
   5-step procedure (set PREVIOUS → rotate current → both reseal sweeps →
   verify/audit → delete PREVIOUS); `docs/deployment-v2.md` §2 checklist
   gains `CREDENTIAL_ENC_KEY_PREVIOUS` (transition state, remove after) and
   `AUDIT_RETENTION_DAYS` rows.

## Verification

- `tests/key-rotation.test.ts` — 14 tests: fallback decrypts old-master
  rows / current-only rows unaffected / neither-key fails closed / legacy
  plaintext passthrough / tryDecryptSecret null semantics / malformed
  PREVIOUS import error; keys sweep (mixed pool: previous+plaintext+current
  → resealed 2, already_current 1, hints+fingerprints refreshed, audit row
  without material, post-rotation decrypt under current key alone),
  idempotency (second run → already_current 3), undecryptable rows kept
  verbatim, 400s (no current key / malformed previous), readonly 403;
  gmail sweep (previous-key PEM + plaintext resealed, audit row), Bearer
  master allowed / sender role 403, unauthenticated 401.
- Full suite: **576/576 (48 files)** — including the untouched stage-4
  `credential-crypto.test.ts` (the `密文格式损坏` contract is preserved).
- `tsc --noEmit` exit 0; dry-run build 456.28 KiB / gzip 115.15 KiB;
  `scripts/check-panel.mjs`: 5 panels clean.

## Notes for the operator

- The PREVIOUS key is a transition state: after both sweeps report
  `failed: []` and `plaintext_remaining: 0`, delete the secret — the
  design intent is exactly one master in force.
- While PREVIOUS is set, dedupe fingerprints of not-yet-resealed rows are
  computed under the old master; run the sweeps immediately after rotating
  so import-dedupe comparisons stay consistent.
