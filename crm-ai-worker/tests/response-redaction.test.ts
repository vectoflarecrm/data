import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest, jsonResponse } from "../src/admin";
import { invalidateProviderCache } from "../src/provider-keys";
import { sanitizeResponse, REDACTED } from "../src/security/redaction";

/* Security V2 Stage 18 — API response security (spec §19).
 *
 * Every JSON response flows through jsonResponse() → sanitizeResponse(), so
 * the §19 key names (api_key, private_key, access_token, refresh_token,
 * client_secret, password, session_token, cloudflare_token) can never reach
 * a caller. §19.1 acceptance: the six admin GET surfaces (customers,
 * settings, providers, Gmail, campaigns, research) carry no secret leakage.
 */

const SCHEMA_SQL = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function makeDb(): any {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}

describe("sanitizeResponse (unit)", () => {
  it("redacts every §19 key name", () => {
    const out = sanitizeResponse({
      api_key: "gsk_live_x",
      private_key: "-----PEM-----",
      access_token: "ya29.x",
      refresh_token: "1//x",
      client_secret: "cs",
      password: "hunter2",
      session_token: "st",
      cloudflare_token: "cf",
    }) as Record<string, unknown>;
    for (const key of ["api_key", "private_key", "access_token", "refresh_token", "client_secret", "password", "session_token", "cloudflare_token"]) {
      expect(out[key]).toBe(REDACTED);
    }
  });

  it("matches case- and underscore-insensitively (camelCase, UPPER, squashed)", () => {
    const out = sanitizeResponse({
      apiKey: "a", Api_Key: "b", API_KEY: "c",
      privateKey: "d", accessToken: "e", sessionToken: "f",
    }) as Record<string, unknown>;
    expect(Object.values(out).every((v) => v === REDACTED)).toBe(true);
  });

  it("recurses into nested objects and arrays", () => {
    const out = sanitizeResponse({
      ok: "visible",
      rows: [{ id: 1, api_key: "secret" }, { id: 2, safe: "yes" }],
      nested: { deep: { password: "p", keep: "k" } },
    }) as Record<string, unknown>;
    expect(out.ok).toBe("visible");
    const rows = out.rows as Array<Record<string, unknown>>;
    expect(rows[0].api_key).toBe(REDACTED);
    expect(rows[1].safe).toBe("yes");
    const nested = out.nested as Record<string, Record<string, unknown>>;
    expect(nested.deep.password).toBe(REDACTED);
    expect(nested.deep.keep).toBe("k");
  });

  it("leaves non-matching keys and primitives untouched, and never mutates the input", () => {
    const input = { key_hint: "gsk_li…3456", provider: "groq", n: 3, nothing: null };
    const snapshot = JSON.stringify(input);
    const out = sanitizeResponse(input) as Record<string, unknown>;
    expect(out).toEqual(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(sanitizeResponse("scalar")).toBe("scalar");
    expect(sanitizeResponse(null)).toBe(null);
    expect(sanitizeResponse(42)).toBe(42);
  });

  it("survives reference cycles", () => {
    const a: Record<string, unknown> = { api_key: "x" };
    const b: Record<string, unknown> = { back: a };
    a.self = b;
    const out = sanitizeResponse(a) as Record<string, unknown>;
    expect(out.api_key).toBe(REDACTED);
  });
});

describe("jsonResponse wiring (the single choke point)", () => {
  it("sanitizes before serializing", async () => {
    const res = jsonResponse({
      detail: "fine",
      api_key: "gsk_live_SECRET",
      nested: { private_key: "-----PEM-----", keep: "visible" },
    });
    const body = await res.json() as Record<string, unknown>;
    expect(body.detail).toBe("fine");
    expect(body.api_key).toBe(REDACTED);
    const nested = body.nested as Record<string, unknown>;
    expect(nested.private_key).toBe(REDACTED);
    expect(nested.keep).toBe("visible");
  });
});

/* ── §19.1: the six GET surfaces, seeded with real secret material ────── */

const RAW_KEY = "gsk_live_SUPERSECRET_123";
const CIPHER = "enc:v1:deadbeefcafe:0123456789abcdef";
const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq_super_secret_pem\n-----END PRIVATE KEY-----";

const TOKEN = "panel-token-for-tests";
const MASTER = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));

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

function makeEnv(db: any): AdminEnv {
  invalidateProviderCache();
  return { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN, CREDENTIAL_ENC_KEY: MASTER } as unknown as AdminEnv;
}

function call(env: AdminEnv, path: string) {
  return handleAdminRequest(
    new Request(`https://worker.example${path}`, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    }),
    env,
  ) as Promise<Response>;
}

function seed(db: any) {
  db.prepare(
    "INSERT INTO customers (company_id, display_id, domain, status, company_name, email, lead_score, data_completeness_score) VALUES ('c1', 'D-001', 'acme.com', 'completed', 'Acme', 'info@acme.com', 80, 70)",
  ).run();
  db.prepare(
    "INSERT INTO evidence (company_id, field_name, field_value, evidence_text, confidence) VALUES ('c1', 'industry', 'logistics', 'Home page says logistics', 0.9)",
  ).run();
  db.prepare(
    "INSERT INTO contacts (contact_id, company_id, seq, first_name, email) VALUES ('c1_001', 'c1', 1, 'Alice', 'alice@acme.com')",
  ).run();
  // One legacy cleartext key and one already-encrypted row.
  db.prepare(
    "INSERT INTO api_configs (provider, label, api_key, key_hint, key_fingerprint, is_active) VALUES ('groq', 'legacy', ?, 'gsk_l…3', 'fp-legacy', 1)",
  ).run(RAW_KEY);
  db.prepare(
    "INSERT INTO api_configs (provider, label, api_key, key_hint, key_fingerprint, is_active) VALUES ('gemini', 'enc', ?, 'AIzaS…9f', 'fp-enc', 1)",
  ).run(CIPHER);
  db.prepare(
    "INSERT INTO provider_settings (provider, default_model, rpm_total, enabled) VALUES ('groq', 'llama-3.3-70b', 60, 1)",
  ).run();
  db.prepare(
    "INSERT INTO api_key_health (provider, key_index, exhausted_until, last_error) VALUES ('groq', 'groq:1', datetime('now', '+1 hour'), '429 quota')",
  ).run();
  db.prepare(
    "INSERT INTO gmail_accounts (label, credential_type, client_email, private_key) VALUES ('main', 'service_account', 'svc@proj.iam.gserviceaccount.com', ?)",
  ).run(PEM);
  db.prepare(
    "INSERT INTO outreach_settings (brand_name, product_category, enabled) VALUES ('TestBrand', 'cat-a', 1)",
  ).run();
  db.prepare(
    "INSERT INTO outreach_campaigns (name, brand_name, status) VALUES ('camp-1', 'TestBrand', 'draft')",
  ).run();
  db.prepare("INSERT INTO outreach_campaign_members (campaign_id, customer_id, status) VALUES (1, 1, 'pending')").run();
}

/** Walks a parsed JSON body: collects every object key (canonical form) and
 * asserts none is a §19 name, and that none of the raw secrets appear
 * anywhere in the serialized body. */
function assertNoSecretLeakage(body: unknown, label: string) {
  const forbidden = new Set([
    "apikey", "privatekey", "accesstoken", "refreshtoken",
    "clientsecret", "password", "sessiontoken", "cloudflaretoken",
  ]);
  const seen: string[] = [];
  const walk = (v: unknown) => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
      seen.push(key.toLowerCase().replace(/_/g, ""));
      walk(val);
    }
  };
  walk(body);
  const hits = seen.filter((k) => forbidden.has(k));
  expect(hits, `${label}: forbidden key names present`).toEqual([]);
  const serialized = JSON.stringify(body);
  for (const secret of [RAW_KEY, CIPHER, PEM, TOKEN, MASTER]) {
    expect(serialized.includes(secret), `${label}: leaks ${secret.slice(0, 16)}…`).toBe(false);
  }
}

describe("§19.1 — six GET surfaces carry no secret leakage", () => {
  it("GET /admin/api/customers (list)", async () => {
    const db = makeDb();
    seed(db);
    const res = await call(makeEnv(db), "/admin/api/customers");
    expect(res.status).toBe(200);
    const body = await res.json();
    assertNoSecretLeakage(body, "customers list");
  });

  it("GET /admin/api/customers/:id (detail: contacts + evidence, the research surface)", async () => {
    const db = makeDb();
    seed(db);
    const res = await call(makeEnv(db), "/admin/api/customers/1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect((body as { evidence: unknown[] }).evidence.length).toBeGreaterThan(0);
    assertNoSecretLeakage(body, "customer detail");
  });

  it("GET /admin/api/keys (providers + settings + cooldowns + history)", async () => {
    const db = makeDb();
    seed(db);
    const res = await call(makeEnv(db), "/admin/api/keys");
    expect(res.status).toBe(200);
    const body = await res.json() as { keys: Array<Record<string, unknown>> };
    // The masked hint is still there — under its real name, not a §19 name.
    expect(body.keys.some((k) => k.key_hint === "gsk_l…3")).toBe(true);
    assertNoSecretLeakage(body, "provider keys");
  });

  it("GET /admin/api/gmail/accounts", async () => {
    const db = makeDb();
    seed(db);
    const res = await call(makeEnv(db), "/admin/api/gmail/accounts");
    expect(res.status).toBe(200);
    const body = await res.json() as { accounts: Array<Record<string, unknown>> };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].client_email).toBe("svc@proj.iam.gserviceaccount.com");
    assertNoSecretLeakage(body, "gmail accounts");
  });

  it("GET /admin/api/outreach/settings", async () => {
    const db = makeDb();
    seed(db);
    const res = await call(makeEnv(db), "/admin/api/outreach/settings");
    expect(res.status).toBe(200);
    const body = await res.json();
    assertNoSecretLeakage(body, "outreach settings");
  });

  it("GET /admin/api/outreach/campaigns", async () => {
    const db = makeDb();
    seed(db);
    const res = await call(makeEnv(db), "/admin/api/outreach/campaigns");
    expect(res.status).toBe(200);
    const body = await res.json();
    assertNoSecretLeakage(body, "campaigns");
  });
});
