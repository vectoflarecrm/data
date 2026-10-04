import { describe, it, expect } from "vitest";
import { makeDb, makeEnv, call, bearer, MASTER_KEY } from "./_helpers";

/* Security V2 Stage 22 (spec §23) — CREDENTIAL REDACTION acceptance.
 *
 * Cross-stage sweep (Stages 4 + 18 + 19 + 20 combined): once a provider key
 * and a Gmail credential are stored, their plaintexts must never appear in
 * ANY admin response body — every GET surface is fetched and swept, and the
 * 500 path is checked too. The plaintexts DO exist inside D1 as enc:v1:
 * ciphertext — that is the invariant pair: encrypted at rest, redacted in
 * flight. */

const API_KEY_PLAIN = "sk-super-secret-provider-key-DO-NOT-LEAK";
const GMAIL_KEY_PLAIN = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";

async function seedCredentials(db: any, env: ReturnType<typeof makeEnv>): Promise<void> {
  const key = await call(env, "/admin/api/keys", {
    method: "POST",
    body: JSON.stringify({ provider: "gemini", api_key: API_KEY_PLAIN }),
    headers: bearer(),
  });
  expect(key.status).toBe(200);
  const gmail = await call(env, "/admin/api/gmail/accounts", {
    method: "POST",
    body: JSON.stringify({
      client_email: "svc@project.iam.gserviceaccount.com",
      private_key: GMAIL_KEY_PLAIN,
      delegated_domain: "afarer.com",
      daily_limit: 50,
    }),
    headers: bearer(),
  });
  expect(gmail.status).toBe(200);
}

describe("credential redaction acceptance", () => {
  it("stored credentials are enc:v1: ciphertext in D1 — never plaintext at rest", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    await seedCredentials(db, env);
    const keyRow = db.prepare("SELECT api_key FROM api_configs LIMIT 1").get() as { api_key: string };
    expect(keyRow.api_key.startsWith("enc:v1:")).toBe(true);
    expect(keyRow.api_key).not.toContain(API_KEY_PLAIN);
    const gmailRow = db.prepare("SELECT private_key FROM gmail_accounts LIMIT 1").get() as { private_key: string };
    expect(gmailRow.private_key.startsWith("enc:v1:")).toBe(true);
    expect(gmailRow.private_key).not.toContain(GMAIL_KEY_PLAIN);
  });

  it("no GET surface ever returns the plaintexts", async () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO customers (company_id, display_id, domain, company_name, status) VALUES ('c1', 'C-0001', 'acme.com', 'Acme Co', 'completed')",
    ).run();
    const env = makeEnv(db);
    await seedCredentials(db, env);
    const surfaces = [
      "/admin/api/keys",
      "/admin/api/gmail/accounts",
      "/admin/api/customers",
      "/admin/api/customers/1",
      "/admin/api/outreach/settings",
      "/admin/api/outreach/campaigns",
      "/admin/api/auth/me",
      "/admin",
    ];
    for (const path of surfaces) {
      const res = await call(env, path, { headers: bearer() });
      expect(res.status, path).toBe(200);
      const body = await res.text();
      expect(body, `${path} leaked the provider key`).not.toContain(API_KEY_PLAIN);
      expect(body, `${path} leaked the gmail key`).not.toContain(GMAIL_KEY_PLAIN);
      expect(body, `${path} leaked PEM material`).not.toContain("BEGIN PRIVATE KEY");
    }
  });

  it("the masked hint is present instead — identification without disclosure", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    await seedCredentials(db, env);
    const res = await call(env, "/admin/api/keys", { headers: bearer() });
    const body = await res.json() as { keys?: Array<Record<string, unknown>> };
    expect(Array.isArray(body.keys)).toBe(true);
    const row = body.keys![0]!;
    expect(typeof row.key_hint).toBe("string");
    expect((row.key_hint as string).length).toBeGreaterThan(0);
    expect(row.key_hint).not.toContain(API_KEY_PLAIN);
    // The old forbidden field name is gone from the wire format (Stage 18).
    expect("api_key" in row).toBe(false);
  });

  it("a 500 response body carries no credential material", async () => {
    const db = makeDb();
    await seedCredentials(db, makeEnv(db));
    const env = makeEnv(db, { explodeOn: "FROM api_configs" });
    const res = await call(env, "/admin/api/keys", { headers: bearer() });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(API_KEY_PLAIN);
    expect(text).not.toContain("D1 exploded"); // internals stay in the log, not the body
    const body = JSON.parse(text) as { request_id: string };
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("audit rows written while storing credentials carry no plaintext", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    await seedCredentials(db, env);
    const rows = db.prepare("SELECT action, metadata_json FROM audit_logs").all() as Array<{ action: string; metadata_json: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.metadata_json ?? "").not.toContain(API_KEY_PLAIN);
      expect(row.metadata_json ?? "").not.toContain(GMAIL_KEY_PLAIN);
    }
  });

  it("the encryption key itself never appears anywhere", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    await seedCredentials(db, env);
    const res = await call(env, "/admin/api/keys", { headers: bearer() });
    const text = await res.text();
    expect(text).not.toContain(MASTER_KEY);
  });
});
