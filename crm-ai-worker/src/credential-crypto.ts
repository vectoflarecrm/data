/* Credential encryption for the D1 key pool.
 *
 * Why this exists: `api_configs.api_key` held every AI and search key in
 * cleartext, so a D1 leak — a Cloudflare credential compromise, an accidental
 * export, a log line — handed over the whole pool at once. The panel masked
 * keys on the way out, but masking a response does not protect the row.
 *
 * Scope, stated plainly: the encryption key lives in a Worker secret, whose
 * protection level is the same as ADMIN_PANEL_TOKEN — anyone holding it can
 * already run this Worker. So this does not defend against a compromised
 * panel. It defends the narrower and more likely case of D1 alone leaking.
 *
 * Format: `enc:v1:<base64 iv>:<base64 ciphertext+tag>`. The prefix is what
 * makes migration safe — a row without it is legacy cleartext, still readable,
 * and converted in place when the operator chooses. AES-GCM so a tampered row
 * fails loudly at decrypt rather than yielding a corrupted key.
 */

const PREFIX = "enc:v1:";
const IV_BYTES = 12;
const FINGERPRINT_HEX_CHARS = 32;

export interface EncryptedSecret {
  /** Full value to store in `api_configs.api_key`. */
  cipher: string;
  /** Display hint, e.g. `AIzaSy…x7f2`, safe to show and to log. */
  hint: string;
  /** Stable per-key digest, used to detect duplicates. Not reversible. */
  fingerprint: string;
}

/* One master secret yields two keys with different jobs. A single CryptoKey
 * cannot serve both — Web Crypto binds a key to one algorithm, and asking an
 * AES-GCM key to sign fails at runtime. Re-importing the same bytes for HMAC
 * would work, but reusing key material across ciphers is exactly the habit
 * that breaks when one of them leaks, so HKDF splits them instead. */
export interface CredentialKeys {
  cipher: CryptoKey;
  fingerprint: CryptoKey;
}

function requireKeys(keys: CredentialKeys | null): CredentialKeys {
  if (!keys) {
    throw new Error("CREDENTIAL_ENC_KEY 未配置：请在「🔑 AI Key 管理」中设置后再操作");
  }
  return keys;
}

async function importKeys(raw: unknown): Promise<CredentialKeys | null> {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let material: Uint8Array;
  try {
    material = base64ToBytes(raw.trim());
  } catch {
    throw new Error("CREDENTIAL_ENC_KEY 不是合法的 base64");
  }
  // 256 bits exactly. A short key is a silent downgrade, so refuse instead.
  if (material.length !== 32) {
    throw new Error(`CREDENTIAL_ENC_KEY 必须是 32 字节（256 位）base64，当前为 ${material.length} 字节`);
  }
  const master = await crypto.subtle.importKey("raw", material as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  // A fixed salt is fine here: HKDF's job is domain separation between the two
  // derived keys, and the master is already 32 bytes of uniform entropy.
  const salt = new Uint8Array(32);
  const derive = (info: string, algorithm: AesKeyGenParams | HmacKeyGenParams, usages: KeyUsage[]) =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: new TextEncoder().encode(info) },
      master,
      algorithm,
      false,
      usages,
    );
  const [cipher, fingerprint] = await Promise.all([
    derive("credential-ciphertext", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
    derive("credential-fingerprint", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]),
  ]);
  return { cipher, fingerprint };
}

/** Resolves the configured keys, or null when none is set. */
export async function getEncKeys(env: unknown): Promise<CredentialKeys | null> {
  return importKeys((env as Record<string, unknown>).CREDENTIAL_ENC_KEY);
}

/** Resolves the previous rotation key (CREDENTIAL_ENC_KEY_PREVIOUS), or
 * null when unset. Rotation keeps decryption working across a master-key
 * change: reads fall back to this key, and the admin reseal sweeps
 * (keys + gmail) re-seal rows onto the current key
 * (see docs/backup-recovery.md). */
export async function getPreviousEncKeys(env: unknown): Promise<CredentialKeys | null> {
  return importKeys((env as Record<string, unknown>).CREDENTIAL_ENC_KEY_PREVIOUS);
}

export async function requireEncKeys(env: unknown): Promise<CredentialKeys> {
  return requireKeys(await getEncKeys(env));
}

/** True when an encryption key is configured. */
export async function isEncryptionConfigured(env: unknown): Promise<boolean> {
  return (await getEncKeys(env)) !== null;
}

/** True when the stored value is already ciphertext. */
export function isEncrypted(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(PREFIX);
}

/** Short, non-reversible display form. Derived before encryption so the
 *  panel can keep showing something useful without being able to decrypt. */
export function hintFor(plain: string): string {
  if (plain.length <= 10) return "…";
  return `${plain.slice(0, 6)}…${plain.slice(-4)}`;
}

export async function encryptSecret(plain: string, env: unknown): Promise<EncryptedSecret> {
  const keys = await requireEncKeys(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    keys.cipher,
    new TextEncoder().encode(plain) as BufferSource,
  );
  return {
    cipher: `${PREFIX}${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ct))}`,
    hint: hintFor(plain),
    fingerprint: await fingerprintOf(plain, keys),
  };
}

/** Attempts decryption with one specific key set; null on any failure
 * (wrong key, tampered ciphertext, damaged format). Exported for the
 * rotation sweep, which must distinguish "sealed with the current key"
 * from "sealed with the previous one" without exceptions as control flow. */
export async function tryDecryptSecret(stored: string, keys: CredentialKeys): Promise<string | null> {
  try {
    const [, , ivPart, ctPart] = stored.split(":");
    if (!ivPart || !ctPart) return null;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(ivPart) as BufferSource },
      keys.cipher,
      base64ToBytes(ctPart) as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** Returns cleartext for both new ciphertext and legacy plain rows. During a
 * key rotation (CREDENTIAL_ENC_KEY_PREVIOUS set) rows sealed under the
 * previous master still decrypt; the reseal sweep then rewrites them onto
 * the current key so the fallback is a transition state, not a permanent
 * second key. */
export async function decryptSecret(stored: string, env: unknown): Promise<string> {
  if (!isEncrypted(stored)) return stored;
  // Format damage is distinct from a key mismatch: keep the original error
  // so a corrupted row stays diagnosable without any key material nearby.
  const [, , ivPart, ctPart] = stored.split(":");
  if (!ivPart || !ctPart) throw new Error("密文格式损坏");
  const keys = await requireEncKeys(env);
  const plain = await tryDecryptSecret(stored, keys);
  if (plain !== null) return plain;
  const previous = await getPreviousEncKeys(env);
  if (previous) {
    const legacyPlain = await tryDecryptSecret(stored, previous);
    if (legacyPlain !== null) return legacyPlain;
  }
  throw new Error("密文无法解密：与当前 CREDENTIAL_ENC_KEY 及备用密钥均不匹配");
}

/* HMAC rather than a bare hash: a plain SHA-256 of a short key is brute
 * forceable offline by anyone who reads the table, which would let them
 * confirm a guessed key without ever decrypting anything. */
async function fingerprintOf(plain: string, keys: CredentialKeys): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    keys.fingerprint,
    new TextEncoder().encode(plain) as BufferSource,
  );
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, FINGERPRINT_HEX_CHARS);
}

/** Public entry point for dedupe, which needs the fingerprint of a value it
 *  does not hold the key material for. */
export async function fingerprint(plain: string, env: unknown): Promise<string> {
  return fingerprintOf(plain, await requireEncKeys(env));
}

export async function suggestEncKey(): Promise<string> {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
