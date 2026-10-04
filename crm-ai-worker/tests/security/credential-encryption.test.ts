import { describe, it, expect } from "vitest";
import { makeDb, makeEnv, call, bearer, MASTER_KEY } from "./_helpers";
import { isEncrypted, hintFor, encryptSecret, decryptSecret } from "../../src/credential-crypto";

/* Security V2 Stage 22 (spec §23) — CREDENTIAL ENCRYPTION acceptance.
 *
 * AES-GCM at rest (Stage 4): save-through-the-API encrypts, decrypt
 * round-trips, the hint identifies without disclosing, a missing or wrong
 * key fails closed, and tampered ciphertext is detected rather than
 * decrypted to garbage. */

describe("credential encryption acceptance", () => {
  it("saving a provider key through the API stores enc:v1: ciphertext", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const res = await call(env, "/admin/api/keys", {
      method: "POST",
      body: JSON.stringify({ provider: "gemini", api_key: "sk-live-abc123" }),
      headers: bearer(),
    });
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT api_key FROM api_configs LIMIT 1").get() as { api_key: string };
    expect(isEncrypted(row.api_key)).toBe(true);
    expect(row.api_key.startsWith("enc:v1:")).toBe(true);
  });

  it("decrypt round-trips the stored value to the original plaintext", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    await call(env, "/admin/api/keys", {
      method: "POST",
      body: JSON.stringify({ provider: "gemini", api_key: "sk-live-roundtrip" }),
      headers: bearer(),
    });
    const row = db.prepare("SELECT api_key FROM api_configs LIMIT 1").get() as { api_key: string };
    const plain = await decryptSecret(row.api_key, env);
    expect(plain).toBe("sk-live-roundtrip");
  });

  it("a direct encryptSecret/decryptSecret round-trip with the key material", async () => {
    const env = makeEnv(makeDb());
    const stored = await encryptSecret("yet-another-plaintext", env);
    expect(isEncrypted(stored.cipher)).toBe(true);
    expect(await decryptSecret(stored.cipher, env)).toBe("yet-another-plaintext");
  });

  it("the hint identifies the key without disclosing it", async () => {
    const hint = hintFor("sk-live-abc123");
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).not.toContain("sk-live-abc123");
    expect(hint.startsWith("sk-")).toBe(true); // prefix hint, tail redacted
  });

  it("saving without CREDENTIAL_ENC_KEY fails closed — 400, nothing stored", async () => {
    const db = makeDb();
    const env = makeEnv(db, { key: null });
    const res = await call(env, "/admin/api/gmail/accounts", {
      method: "POST",
      body: JSON.stringify({
        client_email: "svc@project.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      }),
      headers: bearer(),
    });
    expect(res.status).toBe(400);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM gmail_accounts").get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it("a wrong key never decrypts — tampered or foreign ciphertext is rejected, not garbled", async () => {
    const envA = makeEnv(makeDb());
    const stored = await encryptSecret("plaintext-under-key-A", envA);
    // A DIFFERENT key (the GCM tag cannot validate under it).
    const envB = makeEnv(makeDb(), { key: btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 11 + 1) & 0xff))) });
    await expect(decryptSecret(stored.cipher, envB)).rejects.toThrow();
    // A corrupted ciphertext under the right key is equally rejected.
    const tampered = stored.cipher.slice(0, -4) + (stored.cipher.endsWith("AAAA") ? "BBBB" : "AAAA");
    await expect(decryptSecret(tampered, envA)).rejects.toThrow();
  });

  it("minting a candidate key never echoes the current key material", async () => {
    const env = makeEnv(makeDb());
    const res = await call(env, "/admin/api/keys/encryption-key", { method: "POST", headers: bearer() });
    const text = await res.text();
    expect(text).not.toContain(MASTER_KEY);
  });
});
