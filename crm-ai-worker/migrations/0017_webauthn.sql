-- Post-V2 Stage 29: WebAuthn (FIDO2/passkey) second factor for admin login.
--
-- Applies to: existing online D1 databases (fresh databases get these tables
-- from schema.sql directly). Idempotent — safe to re-run.
-- Run: npx wrangler d1 execute crm-ai-db --remote --file=./migrations/0017_webauthn.sql
--
-- Feature semantics: 2FA is active for a user iff they hold >= 1 credential
-- row with revoked_at IS NULL. While the bootstrap super_admin (u_admin) has
-- an active credential, the Bearer master-token path is DISABLED — the
-- second factor must gate every entry, or it is decoration. Removing the
-- last credential turns 2FA (and the Bearer lockout) back off.
--
-- Rollback (forward-only policy): DROP TABLE webauthn_credentials,
-- webauthn_challenges, webauthn_recovery_codes. Session and audit data are
-- untouched; the panel falls back to master-token-only login.

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,                -- credential id, base64url (authenticator-generated)
  user_id TEXT NOT NULL,
  public_key_jwk TEXT NOT NULL,       -- canonical JWK (WebCrypto-importable); never the private key
  alg INTEGER NOT NULL,               -- COSE alg: -7 (ES256) | -257 (RS256)
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                    -- comma list the browser reported (internal, hybrid, ...)
  name TEXT,                          -- operator-assigned label
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES admin_users (id)
);

CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id);

-- Pending challenge / MFA flows. A row is born at login (assert) or at
-- enrollment (register), is single-use (consumed rows are deleted), and
-- expires after 5 minutes. The cron vacuums expired rows.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,                -- flow id handed to the client
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'assert')),
  challenge TEXT NOT NULL,            -- base64url of 32 random bytes
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES admin_users (id)
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expiry ON webauthn_challenges(expires_at);

-- Break-glass codes for a lost authenticator: 128-bit random, stored as
-- SHA-256 hex, single use (used_at set). Shown to the operator exactly once
-- at generation. A code plus the master token mints a session without the
-- authenticator, so losing the device never locks the operator out.
CREATE TABLE IF NOT EXISTS webauthn_recovery_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES admin_users (id)
);

CREATE INDEX IF NOT EXISTS idx_webauthn_recovery_user ON webauthn_recovery_codes(user_id);
