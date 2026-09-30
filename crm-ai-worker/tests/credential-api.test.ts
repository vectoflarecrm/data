import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";
import { invalidateProviderCache } from "../src/provider-keys";

/* End-to-end behaviour of the credential-encryption change against the real
 * router, with a real SQLite D1 stand-in. What matters here is not the AES
 * (covered in credential-crypto.test.ts) but the rollout properties:
 *
 *   1. existing cleartext keys keep serving the AI pipeline after deploy
 *   2. new writes are refused until an encryption key exists
 *   3. bulk import still dedupes, even though identical keys now encrypt
 *      differently
 *   4. encrypt-all converts in place and is idempotent
 */

const TOKEN = "panel-token-for-tests";
const MASTER_A = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const MASTER_B = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 255 - i)));

class FakeD1 {
  constructor(private db: any) {}
  prepare(sql: string) {
    const db = this.db;
    let bound: unknown[] = [];
    const stmt: any = {
      bind(...args: unknown[]) { bound = args; return stmt; },
      all: async () => ({ results: db.prepare(sql).all(...bound), success: true }),
      first: async () => db.prepare(sql).get(...bound) ?? undefined,
      run: async () => {
        const info = db.prepare(sql).run(...bound);
        return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
      },
    };
    return stmt;
  }
  async batch(stmts: any[]) {
    for (const s of stmts) await s.run();
    return [];
  }
}

function makeDb() {
  const db = new DatabaseSync(":memory:");
  // Post-migration shape: CI runs the ALTERs before the Worker deploys, so this
  // is the state production is in. makePreMigrationDb covers the other case.
  db.exec(`
    CREATE TABLE api_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL, label TEXT, api_key TEXT NOT NULL,
      key_hint TEXT, key_fingerprint TEXT,
      rpm_limit INTEGER, is_active INTEGER NOT NULL DEFAULT 1, model TEXT,
      last_error TEXT, last_used_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE api_key_health (provider TEXT, key_index TEXT, exhausted_until TIMESTAMP, last_error TEXT, updated_at TIMESTAMP);
    CREATE TABLE api_key_usage (provider TEXT, key_index TEXT, day TEXT, success_count INTEGER);
    CREATE TABLE provider_settings (provider TEXT PRIMARY KEY, default_model TEXT, rpm_total INTEGER, enabled INTEGER);
  `);
  return db;
}

/** The table as it exists if the CI migration step has not run yet. */
function makePreMigrationDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE api_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL, label TEXT, api_key TEXT NOT NULL,
      rpm_limit INTEGER, is_active INTEGER NOT NULL DEFAULT 1, model TEXT,
      last_error TEXT, last_used_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

function makeEnv(db: any, encKey?: string) {
  invalidateProviderCache();
  return { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN, CREDENTIAL_ENC_KEY: encKey } as unknown as AdminEnv;
}

function call(env: AdminEnv, path: string, init: RequestInit = {}) {
  return handleAdminRequest(
    new Request(`https://worker.example${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Cookie: `crm_admin_token=${TOKEN}`,
        ...(init.headers ?? {}),
      },
    }),
    env,
  ) as Promise<Response>;
}

const post = (path: string, body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const insertLegacy = (db: any, provider: string, key: string, label: string | null = null) =>
  db.prepare("INSERT INTO api_configs (provider, label, api_key) VALUES (?, ?, ?)")
    .run(provider, label, key);

describe("credential encryption: rollout safety", () => {
  it("keeps serving legacy cleartext keys with no encryption key configured", async () => {
    // The whole rollout hinges on this: 27 rows are cleartext at deploy time.
    // If decryptSecret threw on a missing key, getProviderState would drop
    // every one of them and the AI pipeline would stop mid-deploy.
    const { getProviderState } = await import("../src/provider-keys");
    const db = makeDb();
    insertLegacy(db, "tavily", "tvly-legacy-cleartext-1");
    insertLegacy(db, "tavily", "tvly-legacy-cleartext-2");

    const state = await getProviderState(makeEnv(db), "tavily");
    expect(state.keys.map((k) => k.key)).toEqual(["tvly-legacy-cleartext-1", "tvly-legacy-cleartext-2"]);
  });

  it("keeps serving keys encrypted under a configured key", async () => {
    const { getProviderState } = await import("../src/provider-keys");
    const db = makeDb();
    const env = makeEnv(db, MASTER_A);
    await call(env, "/admin/api/keys", post("", { provider: "groq", api_key: "gsk_live_abcdef123456" }));

    const state = await getProviderState(makeEnv(db, MASTER_A), "groq");
    expect(state.keys.map((k) => k.key)).toEqual(["gsk_live_abcdef123456"]);
  });

  it("drops a row encrypted under a different key instead of failing the provider", async () => {
    const { getProviderState } = await import("../src/provider-keys");
    const db = makeDb();
    await call(makeEnv(db, MASTER_A), "/admin/api/keys", post("", { provider: "groq", api_key: "gsk_live_abcdef123456" }));
    insertLegacy(db, "groq", "gsk_live_plaintext_fallback");

    // Operator rotated CREDENTIAL_ENC_KEY. The encrypted row is unreadable;
    // the plain row must still work, and the provider must not return empty.
    const state = await getProviderState(makeEnv(db, MASTER_B), "groq");
    expect(state.keys.map((k) => k.key)).toEqual(["gsk_live_plaintext_fallback"]);
  });

  it("gives each D1 key its own cooldown slot", async () => {
    // Regression guard: the query once omitted `id`, so every key in a provider
    // got keyId 0 and api_key_health's "<provider>:<id>" collapsed them into
    // one entry — one 429 cooled down the entire pool.
    const { getProviderState } = await import("../src/provider-keys");
    const db = makeDb();
    insertLegacy(db, "tavily", "tvly-a");
    insertLegacy(db, "tavily", "tvly-b");
    const state = await getProviderState(makeEnv(db), "tavily");
    expect(state.keys.map((k) => k.keyId)).toEqual([1, 2]);
    expect(new Set(state.keys.map((k) => k.keyId)).size).toBe(state.keys.length);
  });
});

describe("POST /admin/api/keys", () => {
  it("refuses to store a key when no encryption key is configured", async () => {
    // Fail closed, as chosen: silently writing cleartext would reintroduce the
    // exact state this feature exists to remove.
    const db = makeDb();
    const res = await call(makeEnv(db), "/admin/api/keys", post("", { provider: "groq", api_key: "gsk_live_abcdef123456" }));
    expect(res.status).toBe(400);
    expect((await res.json() as { detail: string }).detail).toMatch(/CREDENTIAL_ENC_KEY/);

    const rows = db.prepare("SELECT COUNT(*) n FROM api_configs").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("stores ciphertext, never the key itself", async () => {
    const db = makeDb();
    const env = makeEnv(db, MASTER_A);
    const res = await call(env, "/admin/api/keys", post("", { provider: "groq", api_key: "gsk_live_abcdef123456" }));
    expect(res.status).toBe(200);

    const row = db.prepare("SELECT * FROM api_configs").get() as Record<string, unknown>;
    expect(String(row.api_key)).toMatch(/^enc:v1:/);
    expect(JSON.stringify(row)).not.toContain("gsk_live_abcdef123456");
    expect(row.key_hint).toBe("gsk_li…3456");
    expect(row.key_fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  it("surfaces a plain vs encrypted marker to the panel without leaking the value", async () => {
    const db = makeDb();
    insertLegacy(db, "groq", "gsk_live_abcdef123456");
    const env = makeEnv(db, MASTER_A);
    const body = await (await call(env, "/admin/api/keys")).json() as {
      keys: Array<{ api_key: string; encrypted: boolean }>;
      encryption: { configured: boolean; plaintext_rows: number };
    };
    expect(body.keys[0].encrypted).toBe(false);
    expect(body.keys[0].api_key).toBe("gsk_li…3456");
    expect(body.encryption).toEqual({ configured: true, plaintext_rows: 1 });
  });

  it("reports an unconfigured encryption state so the panel can warn", async () => {
    const db = makeDb();
    const body = await (await call(makeEnv(db), "/admin/api/keys")).json() as {
      encryption: { configured: boolean };
    };
    expect(body.encryption.configured).toBe(false);
  });

  it("returns an actionable 400, not a redacted 500, when the key is missing", async () => {
    // Regression guard: encryptSecret throws here, and the router's catch-all
    // would turn that into a redacted 500 with only a request_id. The operator
    // would learn nothing about the one thing they need to do.
    const db = makeDb();
    const res = await call(makeEnv(db), "/admin/api/keys", post("", { provider: "groq", api_key: "gsk_x" }));
    expect(res.status).toBe(400);
    expect((await res.json() as { detail: string }).detail).toMatch(/CREDENTIAL_ENC_KEY/);
  });

  it("fails loudly if the migration has not run, rather than writing cleartext", async () => {
    // If CI's ALTER step is ever skipped, the INSERT would fail on the missing
    // column. That is the correct outcome: the key is not stored in the open.
    const db = makePreMigrationDb();
    const res = await call(makeEnv(db, MASTER_A), "/admin/api/keys",
      post("", { provider: "groq", api_key: "gsk_live_abcdef123456" }));
    expect(res.status).toBe(500);
    const rows = db.prepare("SELECT COUNT(*) n FROM api_configs").get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe("POST /admin/api/keys/bulk", () => {
  it("refuses the import when no encryption key is configured", async () => {
    const db = makeDb();
    const res = await call(makeEnv(db), "/admin/api/keys/bulk", post("", {
      provider: "tavily", keys: "tvly-aaaa1111\ntvly-bbbb2222",
    }));
    expect(res.status).toBe(400);
    const rows = db.prepare("SELECT COUNT(*) n FROM api_configs").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("skips keys already stored, despite identical keys encrypting differently", async () => {
    // The core migration hazard: a random IV means two rows holding the same
    // key have different api_key values, so a value-equality Set would let
    // every re-import duplicate the pool.
    const db = makeDb();
    const env = makeEnv(db, MASTER_A);
    const first = await (await call(env, "/admin/api/keys/bulk", post("", {
      provider: "tavily", keys: "tvly-aaaa1111,账号1\ntvly-bbbb2222,账号2",
    }))).json() as { added: number; skipped: number };
    expect(first).toMatchObject({ added: 2, skipped: 0 });

    const second = await (await call(env, "/admin/api/keys/bulk", post("", {
      provider: "tavily", keys: "tvly-aaaa1111\ntvly-cccc3333",
    }))).json() as { added: number; skipped: number };
    expect(second).toMatchObject({ added: 1, skipped: 1 });

    const rows = db.prepare("SELECT api_key FROM api_configs ORDER BY id").all() as Array<{ api_key: string }>;
    expect(rows).toHaveLength(3);
    // Proves the two duplicate rows are not byte-identical, i.e. dedupe really
    // did go through fingerprints rather than accidentally matching ciphertext.
    expect(new Set(rows.map((r) => r.api_key)).size).toBe(3);
  });

  it("detects duplicates against legacy cleartext rows that have no fingerprint", async () => {
    // A row written before the migration has key_fingerprint = NULL. Comparing
    // fingerprints alone would miss it and re-add the key.
    const db = makeDb();
    insertLegacy(db, "tavily", "tvly-legacy9999", "旧账号");
    const env = makeEnv(db, MASTER_A);
    const res = await (await call(env, "/admin/api/keys/bulk", post("", {
      provider: "tavily", keys: "tvly-legacy9999",
    }))).json() as { added: number; skipped: number };
    expect(res).toMatchObject({ added: 0, skipped: 1 });
    const rows = db.prepare("SELECT COUNT(*) n FROM api_configs").get() as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe("POST /admin/api/keys/encrypt-all", () => {
  it("refuses without a configured key and leaves rows untouched", async () => {
    const db = makeDb();
    insertLegacy(db, "tavily", "tvly-legacy-a");
    const res = await call(makeEnv(db), "/admin/api/keys/encrypt-all", { method: "POST" });
    expect(res.status).toBe(400);
    const row = db.prepare("SELECT api_key FROM api_configs").get() as { api_key: string };
    expect(row.api_key).toBe("tvly-legacy-a");
  });

  it("converts every cleartext row in place", async () => {
    const db = makeDb();
    insertLegacy(db, "tavily", "tvly-legacy-a", "a");
    insertLegacy(db, "exa", "exa-legacy-b", "b");
    const env = makeEnv(db, MASTER_A);

    const body = await (await call(env, "/admin/api/keys/encrypt-all", { method: "POST" })).json() as {
      ok: boolean; converted: number; remaining: number;
    };
    expect(body).toMatchObject({ ok: true, converted: 2, remaining: 0 });

    const rows = db.prepare("SELECT provider, api_key, key_hint, key_fingerprint FROM api_configs ORDER BY id").all();
    for (const row of rows as Array<Record<string, string>>) {
      expect(row.api_key).toMatch(/^enc:v1:/);
      expect(row.key_fingerprint).toMatch(/^[0-9a-f]{32}$/);
    }
    // The original values must be gone from the table entirely.
    expect(JSON.stringify(rows)).not.toContain("tvly-legacy-a");
    expect(JSON.stringify(rows)).not.toContain("exa-legacy-b");
  });

  it("is idempotent — a second run converts nothing", async () => {
    const db = makeDb();
    insertLegacy(db, "tavily", "tvly-legacy-a");
    const env = makeEnv(db, MASTER_A);
    await call(env, "/admin/api/keys/encrypt-all", { method: "POST" });
    const first = db.prepare("SELECT api_key FROM api_configs").get() as { api_key: string };

    const again = await (await call(env, "/admin/api/keys/encrypt-all", { method: "POST" })).json() as {
      converted: number; remaining: number;
    };
    expect(again).toMatchObject({ converted: 0, remaining: 0 });
    // Untouched: a re-encrypt would needlessly invalidate cached provider state.
    expect((db.prepare("SELECT api_key FROM api_configs").get() as { api_key: string }).api_key).toBe(first.api_key);
  });

  it("leaves keys readable by the provider afterwards", async () => {
    const { getProviderState } = await import("../src/provider-keys");
    const db = makeDb();
    insertLegacy(db, "tavily", "tvly-legacy-a");
    insertLegacy(db, "tavily", "tvly-legacy-b");
    await call(makeEnv(db, MASTER_A), "/admin/api/keys/encrypt-all", { method: "POST" });

    const state = await getProviderState(makeEnv(db, MASTER_A), "tavily");
    expect(state.keys.map((k) => k.key)).toEqual(["tvly-legacy-a", "tvly-legacy-b"]);
  });
});

describe("POST /admin/api/keys/encryption-key", () => {
  it("mints a usable 32-byte key", async () => {
    const db = makeDb();
    const body = await (await call(makeEnv(db), "/admin/api/keys/encryption-key", { method: "POST" })).json() as { value: string };
    expect(Buffer.from(body.value, "base64")).toHaveLength(32);
    // And it is not the key a second call would produce.
    const again = await (await call(makeEnv(db), "/admin/api/keys/encryption-key", { method: "POST" })).json() as { value: string };
    expect(again.value).not.toBe(body.value);
  });
});
