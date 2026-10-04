import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  tryDecryptSecret,
  requireEncKeys,
  getPreviousEncKeys,
} from "../src/credential-crypto";
import { makeDb, makeEnv, call, mintSession, MASTER_KEY, TOKEN } from "./security/_helpers";

/* Post-V2 small-improvements stage — CREDENTIAL_ENC_KEY rotation.
 *
 * Remaining Risks #6 closed: rotating the master key no longer means panel
 * re-entry of every credential. While CREDENTIAL_ENC_KEY_PREVIOUS holds the
 * old master, decryption falls back to it, and the reseal sweeps
 * (POST /admin/api/keys/reseal, POST /admin/api/gmail/reseal —
 * credentials.write, i.e. super_admin only) rewrite every row onto the
 * current key with the same Stage 4 verification gate as encrypt-all.
 */

/** A second, different 32-byte master. */
const OTHER_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff)));

function rotationEnv(db: any, current: string, previous: string | null): any {
  const env: Record<string, unknown> = makeEnv(db, { key: current });
  if (previous !== null) env.CREDENTIAL_ENC_KEY_PREVIOUS = previous;
  return env;
}

describe("decryptSecret during a rotation window", () => {
  it("still opens rows sealed under the previous master via the fallback", async () => {
    const oldEnv = { CREDENTIAL_ENC_KEY: MASTER_KEY };
    const sealed = await encryptSecret("rotation-secret", oldEnv);
    expect(sealed.cipher.startsWith("enc:v1:")).toBe(true);
    const rotated = { CREDENTIAL_ENC_KEY: OTHER_KEY, CREDENTIAL_ENC_KEY_PREVIOUS: MASTER_KEY };
    expect(await decryptSecret(sealed.cipher, rotated)).toBe("rotation-secret");
  });

  it("rows sealed under the current master decrypt without any fallback", async () => {
    const env = rotationEnv(makeDb(), MASTER_KEY, OTHER_KEY);
    const sealed = await encryptSecret("fresh-secret", env);
    expect(await decryptSecret(sealed.cipher, env)).toBe("fresh-secret");
  });

  it("rows matching neither key fail closed with a clear error", async () => {
    const strangerEnv = { CREDENTIAL_ENC_KEY: MASTER_KEY };
    const sealed = await encryptSecret("stranger", strangerEnv);
    const env = rotationEnv(makeDb(), OTHER_KEY, null);
    await expect(decryptSecret(sealed.cipher, env)).rejects.toThrow("无法解密");
  });

  it("legacy plaintext rows keep passing through untouched", async () => {
    const env = rotationEnv(makeDb(), MASTER_KEY, null);
    expect(await decryptSecret("plain-legacy-value", env)).toBe("plain-legacy-value");
  });

  it("tryDecryptSecret returns null instead of throwing (sweep's control flow)", async () => {
    const sealed = await encryptSecret("x", { CREDENTIAL_ENC_KEY: MASTER_KEY });
    const otherKeys = await requireEncKeys({ CREDENTIAL_ENC_KEY: OTHER_KEY });
    expect(await tryDecryptSecret(sealed.cipher, otherKeys)).toBeNull();
    const ownKeys = await requireEncKeys({ CREDENTIAL_ENC_KEY: MASTER_KEY });
    expect(await tryDecryptSecret(sealed.cipher, ownKeys)).toBe("x");
    expect(await tryDecryptSecret("enc:v1:broken", ownKeys)).toBeNull();
  });

  it("a malformed PREVIOUS value surfaces as an import error, not silence", async () => {
    await expect(getPreviousEncKeys({ CREDENTIAL_ENC_KEY_PREVIOUS: "not-base64!!" })).rejects.toThrow();
  });
});

describe("POST /admin/api/keys/reseal (rotation sweep)", () => {
  function seed(db: any): void {
    db.prepare(
      "INSERT INTO api_configs (provider, label, api_key, is_active, created_at, updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    ).run("gemini", "old-key-row", "enc-old-placeholder", 1);
    db.prepare(
      "INSERT INTO api_configs (provider, label, api_key, is_active, created_at, updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    ).run("groq", "current-key-row", "enc-current-placeholder", 1);
    db.prepare(
      "INSERT INTO api_configs (provider, label, api_key, is_active, created_at, updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    ).run("mistral", "plaintext-row", "plain-token-123", 1);
  }

  async function sealRowsUnder(db: any, provider: string, key: string, value: string): Promise<void> {
    const sealed = await encryptSecret(value, { CREDENTIAL_ENC_KEY: key });
    db.prepare("UPDATE api_configs SET api_key = ?, key_hint = ?, key_fingerprint = ? WHERE provider = ?")
      .run(sealed.cipher, sealed.hint, sealed.fingerprint, provider);
  }

  it("reseals previous-key and plaintext rows, counts current-key rows", async () => {
    const db = makeDb();
    seed(db);
    await sealRowsUnder(db, "gemini", MASTER_KEY, "gemini-secret-value"); // will become "previous"
    await sealRowsUnder(db, "groq", OTHER_KEY, "groq-secret-value"); // already under rotation target
    const token = await mintSession(db, "super_admin");
    const env = rotationEnv(db, OTHER_KEY, MASTER_KEY); // rotate: OTHER_KEY in force, MASTER_KEY previous

    const res = await call(env, "/admin/api/keys/reseal", {
      method: "POST",
      headers: { Cookie: `crm_session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.resealed).toBe(2); // gemini (previous) + mistral (plaintext)
    expect(body.already_current).toBe(1); // groq
    expect(body.failed).toEqual([]);
    expect(body.ok).toBe(true);
    expect(body.plaintext_remaining).toBe(0);

    // Every row now opens under the CURRENT key alone — rotation complete.
    const postEnv = rotationEnv(db, OTHER_KEY, null);
    const expected: Record<string, string> = {
      gemini: "gemini-secret-value",
      groq: "groq-secret-value",
      mistral: "plain-token-123",
    };
    const rows = db.prepare("SELECT provider, api_key FROM api_configs").all() as any[];
    for (const row of rows) {
      expect(row.api_key.startsWith("enc:v1:")).toBe(true);
      expect(await decryptSecret(row.api_key, postEnv)).toBe(expected[row.provider]);
    }
    // The sweep refreshed key_hint/key_fingerprint alongside the ciphertext.
    const geminiRow = rows.find((r) => r.provider === "gemini");
    const sealed = await encryptSecret("gemini-secret-value", postEnv);
    const stored = db.prepare("SELECT key_fingerprint FROM api_configs WHERE provider = 'gemini'").get() as any;
    expect(stored.key_fingerprint).toBe(sealed.fingerprint);

    // One audit row records the sweep — never the credential material.
    const audit = db.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'UPDATE_API_KEY'").get() as any;
    expect(JSON.parse(audit.metadata_json).via).toBe("reseal");
    expect(audit.metadata_json).not.toContain("gemini-secret-value");
  });

  it("is idempotent: a second run reports already_current for everything", async () => {
    const db = makeDb();
    seed(db);
    await sealRowsUnder(db, "gemini", MASTER_KEY, "gemini-secret-value");
    await sealRowsUnder(db, "groq", OTHER_KEY, "groq-secret-value");
    const token = await mintSession(db, "super_admin");
    const env = rotationEnv(db, OTHER_KEY, MASTER_KEY);
    await call(env, "/admin/api/keys/reseal", { method: "POST", headers: { Cookie: `crm_session=${token}` } });
    const again = await (await call(env, "/admin/api/keys/reseal", { method: "POST", headers: { Cookie: `crm_session=${token}` } })).json() as any;
    expect(again.resealed).toBe(0);
    expect(again.already_current).toBe(3);
  });

  it("undecryptable rows are kept and reported, never destroyed", async () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO api_configs (provider, label, api_key, is_active, created_at, updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
    ).run("gemini", "stranger-row", "enc:v1:AAAA:BBBB", 1);
    const token = await mintSession(db, "super_admin");
    const env = rotationEnv(db, OTHER_KEY, MASTER_KEY);
    const body = await (await call(env, "/admin/api/keys/reseal", { method: "POST", headers: { Cookie: `crm_session=${token}` } })).json() as any;
    expect(body.ok).toBe(false);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].reason).toContain("无法解密");
    const kept = db.prepare("SELECT api_key FROM api_configs WHERE label = 'stranger-row'").get() as any;
    expect(kept.api_key).toBe("enc:v1:AAAA:BBBB"); // 原值未动
  });

  it("fails closed without a current key (400) and rejects malformed PREVIOUS (400)", async () => {
    const db = makeDb();
    const token = await mintSession(db, "super_admin");
    const noKey = makeEnv(db, { key: null });
    expect((await call(noKey, "/admin/api/keys/reseal", { method: "POST", headers: { Cookie: `crm_session=${token}` } })).status).toBe(400);
    const badPrev = rotationEnv(db, MASTER_KEY, "not-base64!!");
    const res = await call(badPrev, "/admin/api/keys/reseal", { method: "POST", headers: { Cookie: `crm_session=${token}` } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).detail).toContain("CREDENTIAL_ENC_KEY_PREVIOUS");
  });

  it("credentials.write is super_admin only — readonly gets 403", async () => {
    const db = makeDb();
    const token = await mintSession(db, "readonly");
    const env = rotationEnv(db, MASTER_KEY, null);
    expect((await call(env, "/admin/api/keys/reseal", { method: "POST", headers: { Cookie: `crm_session=${token}` } })).status).toBe(403);
  });
});

describe("POST /admin/api/gmail/reseal (sender pool sweep)", () => {
  function seedGmail(db: any, label: string, privateKey: string): void {
    db.prepare(
      "INSERT INTO gmail_accounts (label, client_email, private_key, daily_limit, enabled) VALUES (?,?,?,?,1)",
    ).run(label, `${label}@example.com`, privateKey, 100);
  }

  it("reseals previous-key sender credentials in place", async () => {
    const db = makeDb();
    const sealedOld = await encryptSecret("-----BEGIN PRIVATE KEY-----old-----END PRIVATE KEY-----", { CREDENTIAL_ENC_KEY: MASTER_KEY });
    seedGmail(db, "old-sender", sealedOld.cipher);
    seedGmail(db, "plain-sender", "legacy-plain-key");
    const token = await mintSession(db, "super_admin");
    const env = rotationEnv(db, OTHER_KEY, MASTER_KEY);

    const body = await (await call(env, "/admin/api/gmail/reseal", { method: "POST", headers: { Cookie: `crm_session=${token}` } })).json() as any;
    expect(body.resealed).toBe(2);
    expect(body.failed).toEqual([]);
    expect(body.plaintext_remaining).toBe(0);

    const postEnv = rotationEnv(db, OTHER_KEY, null);
    const expectedKeys: Record<string, string> = {
      "old-sender": "-----BEGIN PRIVATE KEY-----old-----END PRIVATE KEY-----",
      "plain-sender": "legacy-plain-key",
    };
    for (const label of ["old-sender", "plain-sender"]) {
      const row = db.prepare("SELECT private_key FROM gmail_accounts WHERE client_email = ?").get(`${label}@example.com`) as any;
      expect(row.private_key.startsWith("enc:v1:")).toBe(true);
      expect(await decryptSecret(row.private_key, postEnv)).toBe(expectedKeys[label]);
    }
    const audit = db.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'UPDATE_GMAIL_ACCOUNT'").get() as any;
    expect(JSON.parse(audit.metadata_json).via).toBe("reseal");
  });

  it("master token (super_admin) may run the sweep; sender role may not", async () => {
    const db = makeDb();
    seedGmail(db, "sender-a", "plain-key-a");
    const env = rotationEnv(db, MASTER_KEY, null);
    const ok = await call(env, "/admin/api/gmail/reseal", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
    const senderToken = await mintSession(db, "sender");
    expect((await call(env, "/admin/api/gmail/reseal", { method: "POST", headers: { Cookie: `crm_session=${senderToken}` } })).status).toBe(403);
  });

  it("unauthenticated callers get 401", async () => {
    const env = rotationEnv(makeDb(), MASTER_KEY, null);
    expect((await call(env, "/admin/api/gmail/reseal", { method: "POST" })).status).toBe(401);
  });
});
