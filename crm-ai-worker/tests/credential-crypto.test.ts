import { describe, it, expect, beforeEach } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  fingerprint,
  getEncKeys,
  suggestEncKey,
  hintFor,
} from "../src/credential-crypto";

/* api_configs.api_key held every AI and search key in cleartext, so a D1 leak
 * handed over the whole pool. These tests pin the properties that make
 * encryption safe to turn on: legacy rows keep working, a lost key fails
 * loudly rather than silently, and duplicate detection survives the fact that
 * the same key encrypts differently every time. */

const KEY = "tvly-abcdefghijklmnopqrstuvwxyz0123456789";
const encEnv = (key = MASTER_A) => ({ CREDENTIAL_ENC_KEY: key });

// Two distinct fixed masters. Deterministic so failures reproduce, but
// different from each other — comparing one env against itself would make
// "different key" assertions pass or fail for the wrong reason.
const MASTER_A = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const MASTER_B = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 255 - i)));

describe("credential encryption", () => {
  it("round-trips a key through encrypt and decrypt", async () => {
    const env = encEnv();
    const { cipher } = await encryptSecret(KEY, env);
    expect(isEncrypted(cipher)).toBe(true);
    expect(cipher).not.toContain(KEY);
    expect(await decryptSecret(cipher, env)).toBe(KEY);
  });

  it("keeps legacy cleartext rows readable without a key configured", async () => {
    // This is what makes the rollout non-breaking: 27 existing keys keep
    // working before the operator has set CREDENTIAL_ENC_KEY or clicked
    // encrypt-all. If this regresses, the AI pipeline goes down on deploy.
    expect(await decryptSecret(KEY, {})).toBe(KEY);
    expect(isEncrypted(KEY)).toBe(false);
  });

  it("produces different ciphertext for the same key each time", async () => {
    // Random IV. This is exactly why bulk import can no longer dedupe by
    // comparing api_key values.
    const env = encEnv();
    const a = await encryptSecret(KEY, env);
    const b = await encryptSecret(KEY, env);
    expect(a.cipher).not.toBe(b.cipher);
    expect(await decryptSecret(a.cipher, env)).toBe(await decryptSecret(b.cipher, env));
  });

  it("refuses to write when no encryption key is configured", async () => {
    // Fail closed: silently falling back to cleartext would put the value back
    // into D1 in the open, defeating the whole feature.
    await expect(encryptSecret(KEY, {})).rejects.toThrow(/CREDENTIAL_ENC_KEY/);
  });

  it("rejects a key that is not 32 bytes instead of downgrading silently", async () => {
    const short = btoa("too short");
    await expect(getEncKeys({ CREDENTIAL_ENC_KEY: short })).rejects.toThrow(/32 字节/);
  });

  it("rejects a key that is not base64", async () => {
    await expect(getEncKeys({ CREDENTIAL_ENC_KEY: "not base64 !!!" })).rejects.toThrow(/base64/);
  });

  it("returns null rather than throwing when no key is set", async () => {
    // The read path polls this on every GET /admin/api/keys; it must not be
    // an exception, just an answer.
    expect(await getEncKeys({})).toBeNull();
    expect(await getEncKeys({ CREDENTIAL_ENC_KEY: "   " })).toBeNull();
  });

  it("derives a cipher key and a fingerprint key that are not the same", async () => {
    // Web Crypto binds a key to one algorithm: asking the AES-GCM key to sign
    // throws InvalidAccessError. Reusing the bytes for HMAC would pass tests
    // while leaving one key doing two jobs, so HKDF splits them instead.
    const keys = await getEncKeys(encEnv()) as { cipher: CryptoKey; fingerprint: CryptoKey };
    expect(keys.cipher.algorithm.name).toBe("AES-GCM");
    expect(keys.fingerprint.algorithm.name).toBe("HMAC");
    expect(keys.cipher.usages).toContain("encrypt");
    expect(keys.fingerprint.usages).toContain("sign");
    // Non-extractable: the panel can use the keys but cannot read them back.
    expect(keys.cipher.extractable).toBe(false);
    expect(keys.fingerprint.extractable).toBe(false);
  });

  it("cannot read ciphertext with a different key", async () => {
    const cipher = (await encryptSecret(KEY, encEnv())).cipher;
    // Simulates an operator rotating CREDENTIAL_ENC_KEY: existing rows become
    // unreadable, which is why the panel warns about losing the key. The row is
    // dropped, not passed through as garbage that would fail at the provider.
    await expect(decryptSecret(cipher, encEnv(MASTER_B))).rejects.toThrow();
  });

  it("rejects a tampered ciphertext rather than returning wrong plaintext", async () => {
    // AES-GCM is authenticated: flipping a byte in the body must fail, not
    // yield a subtly wrong API key that fails 1000 requests upstream.
    const env = encEnv();
    const { cipher } = await encryptSecret(KEY, env);
    const parts = cipher.split(":");
    const body = Buffer.from(parts[3], "base64");
    body[0] ^= 0xff;
    parts[3] = body.toString("base64");
    await expect(decryptSecret(parts.join(":"), env)).rejects.toThrow();
  });

  it("rejects a truncated or malformed ciphertext", async () => {
    await expect(decryptSecret("enc:v1:only-two", encEnv())).rejects.toThrow(/损坏/);
  });

  it("generates a 32-byte key in base64", async () => {
    const generated = await suggestEncKey();
    expect(Buffer.from(generated, "base64")).toHaveLength(32);
    expect(await getEncKeys({ CREDENTIAL_ENC_KEY: generated })).not.toBeNull();
  });
});

describe("fingerprints (duplicate detection)", () => {
  it("is stable for the same key, so dedupe works across rows", async () => {
    const env = encEnv();
    expect(await fingerprint(KEY, env)).toBe(await fingerprint(KEY, env));
  });

  it("differs for different keys", async () => {
    const env = encEnv();
    expect(await fingerprint(KEY, env)).not.toBe(await fingerprint(`${KEY}x`, env));
  });

  it("differs across encryption keys, so rotating invalidates old fingerprints", async () => {
    expect(await fingerprint(KEY, encEnv())).not.toBe(
      await fingerprint(KEY, encEnv(MASTER_B)),
    );
  });

  it("does not reveal the key it was derived from", async () => {
    const env = encEnv();
    const fp = await fingerprint(KEY, env);
    expect(fp).not.toContain(KEY);
    // Fixed width, so a fingerprint row is not a variable-length oracle.
    expect(fp).toHaveLength(32);
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("key_hint (display value)", () => {
  it("captures a recognisable prefix and suffix", () => {
    expect(hintFor("AIzaSyD-1234567890abcdefghijklmnop")).toBe("AIzaSy…mnop");
  });

  it("does not reproduce a short key", () => {
    // A 10-char key would otherwise be fully visible under the old slicing
    // rule, since prefix + suffix can cover the whole value.
    expect(hintFor("short")).toBe("…");
  });

  it("keeps the hint identical for identical keys, unlike the ciphertext", async () => {
    const env = encEnv();
    const a = await encryptSecret(KEY, env);
    const b = await encryptSecret(KEY, env);
    expect(a.hint).toBe(b.hint);
    expect(a.cipher).not.toBe(b.cipher);
  });
});
