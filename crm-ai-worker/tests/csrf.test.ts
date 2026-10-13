import { describe, it, expect } from "vitest";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";

/* Security V2 Stage 6 — Origin guard on state-changing /admin requests.
 *
 * SameSite=Strict cookies are the first CSRF layer; this is the second:
 * POST/PUT/PATCH/DELETE with a foreign Origin must die before any handler
 * runs. Missing Origin is deliberately allowed (policy documented in
 * src/security/origin-guard.ts): browsers that can attach the session cookie
 * always send Origin on non-GET requests, so Origin-less writers are
 * non-browser clients with explicit, non-ambient credentials. */

const TOKEN = "correct-horse-battery-staple";
const BASE = "https://worker.example";
const FOREIGN = "https://evil.example";

async function makeEnv(overrides: Record<string, unknown> = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE admin_login_attempts (
      scope TEXT NOT NULL, ident TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
      window_start TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, locked_until TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (scope, ident)
    );
    CREATE TABLE admin_users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'super_admin', enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE admin_sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      last_seen_at TEXT, revoked_at TEXT, ip_hash TEXT, user_agent_hash TEXT
    );
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY, company_id TEXT, display_id TEXT, domain TEXT,
      status TEXT, company_name TEXT, legal_name TEXT, trading_name TEXT,
      normalized_domain TEXT, first_name TEXT, last_name TEXT, full_name TEXT,
      title TEXT, department TEXT, linkedin_url TEXT, street_address TEXT,
      zip_city TEXT, country TEXT, country_code TEXT, region TEXT, city TEXT,
      postal_code TEXT, tel TEXT, email TEXT, cellphone TEXT, whatsapp TEXT,
      products_services TEXT, business_tag TEXT, industry TEXT, company_type TEXT,
      business_model TEXT, founded_year TEXT, employee_range TEXT, description TEXT,
      target_markets TEXT, is_manufacturer INTEGER, is_importer INTEGER,
      is_distributor INTEGER, is_wholesaler INTEGER, is_retailer INTEGER,
      is_ecommerce INTEGER, is_rental INTEGER, is_oem INTEGER, social_accounts TEXT,
      full_research_text TEXT, social_accounts_verified TEXT, customer_segment TEXT,
      product_categories TEXT, company_size TEXT, geographic_coverage TEXT,
      personas_and_solutions TEXT, remarks TEXT, updated_at TEXT,
      company_profile TEXT, outreach_context TEXT, buying_signals TEXT,
      lead_score INTEGER, source_import_id TEXT
    );
    CREATE TABLE outreach_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, company_id TEXT,
      display_id TEXT, company_name TEXT, brand_name TEXT, status TEXT
    );
    CREATE TABLE outreach_settings (brand_name TEXT PRIMARY KEY, company_intro TEXT, enabled INTEGER);
  `);
  return {
    db,
    env: { DB: { prepare: (sql: string) => fakeStmt(db, sql) }, ADMIN_PANEL_TOKEN: TOKEN, ...overrides } as unknown as AdminEnv,
  };
}

/* Minimal FakeD1: the origin gate fires before any handler, so positive
 * cases only touch endpoints that need no tables (auth/logout with Bearer). */
function fakeStmt(db: any, sql: string) {
  let bound: unknown[] = [];
  return {
    bind(...args: unknown[]) {
      bound = args;
      return this;
    },
    async all<T>() {
      return { results: db.prepare(sql).all(...bound) as T[], success: true };
    },
    async first<T>() {
      return (db.prepare(sql).get(...bound) ?? undefined) as T | undefined;
    },
    async run() {
      const info = db.prepare(sql).run(...bound);
      return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
    },
  };
}

function req(
  method: string,
  pathname: string,
  opts: { origin?: string | null; bearer?: boolean; cookie?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined && opts.origin !== null) headers["Origin"] = opts.origin;
  if (opts.bearer) headers["Authorization"] = `Bearer ${TOKEN}`;
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  return new Request(BASE + pathname, { method, headers, body });
}

describe("stage 6: same-origin state-changing requests pass", () => {
  it("accepts a same-origin POST (Bearer)", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(req("POST", "/admin/api/auth/logout", { origin: BASE, bearer: true }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("accepts a same-origin form login POST", async () => {
    const { env } = await makeEnv();
    const form = new FormData();
    form.set("token", TOKEN);
    const res = await handleAdminRequest(
      new Request(BASE + "/admin/login", {
        method: "POST",
        headers: { "Origin": BASE, "CF-Connecting-IP": "1.2.3.4" },
        body: form,
      }),
      env,
    );
    // The gate must not be what stops a legit operator login (303 = success).
    expect(res.status).toBe(303);
  });

  it("accepts an opaque-origin (Origin: 'null') form login — pre-V2 client compatibility", async () => {
    const { env } = await makeEnv();
    const form = new FormData();
    form.set("token", TOKEN);
    const res = await handleAdminRequest(
      new Request(BASE + "/admin/login", {
        method: "POST",
        headers: { "Origin": "null", "CF-Connecting-IP": "1.2.3.4" },
        body: form,
      }),
      env,
    );
    // 2026-10-13 amendment: the operator's browser serializes its form-POST
    // Origin as the literal "null"; the gate treats it like a missing Origin
    // and the login proceeds to token verification (303 = success).
    expect(res.status).toBe(303);
  });

  it("accepts a same-origin PATCH (past the gate; business logic decides)", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(req("PATCH", "/admin/api/customers/1", { origin: BASE, bearer: true, body: { status: "pending" } }), env);
    // Past the gate with a valid role: the handler answers (404 = no such
    // customer row in this fixture), never the gate's 403.
    expect(res.status).toBe(404);
  });

  it("still applies security headers to responses that passed the gate", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(req("POST", "/admin/api/auth/logout", { origin: BASE, bearer: true }), env);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});

describe("stage 6: foreign origins are rejected before any handler runs", () => {
  it("rejects a foreign-origin POST with 403", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(req("POST", "/admin/api/auth/logout", { origin: FOREIGN, bearer: true }), env);
    expect(res.status).toBe(403);
    const body = await res.json() as { detail: string };
    expect(body.detail).toContain("跨域");
  });

  it("rejects even without credentials — the gate leaks no auth state", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(req("POST", "/admin/api/auth/logout", { origin: FOREIGN }), env);
    expect(res.status).toBe(403);
  });

  it("guards PUT, PATCH and DELETE as well", async () => {
    const { env } = await makeEnv();
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await handleAdminRequest(req(method, "/admin/api/keys/settings/gemini", { origin: FOREIGN, bearer: true, body: {} }), env);
      expect(res.status, method).toBe(403);
    }
  });

  it("treats the literal Origin 'null' like a missing Origin (opaque-origin browser clients)", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(req("POST", "/admin/api/auth/logout", { origin: "null", bearer: true }), env);
    // 2026-10-13 amendment: the operator's browser serializes its form-POST
    // Origin as the literal "null"; the gate no longer treats it as foreign.
    expect(res.status).toBe(200);
  });

  it("rejects a scheme mismatch on the same host", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(req("POST", "/admin/api/auth/logout", { origin: "http://worker.example", bearer: true }), env);
    expect(res.status).toBe(403);
  });

  it("rejects a port mismatch on the same host", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(req("POST", "/admin/api/auth/logout", { origin: `${BASE}:8443`, bearer: true }), env);
    expect(res.status).toBe(403);
  });

  it("rejects an unparseable Origin value", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(req("POST", "/admin/api/auth/logout", { origin: "not a url", bearer: true }), env);
    expect(res.status).toBe(403);
  });

  it("answers the 403 with the full security-header set", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(req("POST", "/admin/api/auth/logout", { origin: FOREIGN, bearer: true }), env);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  it("rejects a foreign-origin form login too — login CSRF is not exempt", async () => {
    const { env } = await makeEnv();
    const form = new FormData();
    form.set("token", TOKEN);
    const res = await handleAdminRequest(
      new Request(BASE + "/admin/login", {
        method: "POST",
        headers: { "Origin": FOREIGN, "CF-Connecting-IP": "1.2.3.4" },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(403);
    // And the operator's token must not appear anywhere in the rejection.
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
  });
});

describe("stage 6: missing-Origin policy (deliberate allow)", () => {
  it("lets Origin-less POSTs through — non-browser clients carry explicit credentials", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(req("POST", "/admin/api/auth/logout", { bearer: true }), env);
    expect(res.status).toBe(200);
  });

  it("an Origin-less request without credentials still fails auth (401, not the gate's 403)", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(req("POST", "/admin/api/auth/logout"), env);
    expect(res.status).toBe(401);
  });
});

describe("stage 6: safe methods are never gated", () => {
  it("serves GET with a foreign Origin — no side effect to protect", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(req("GET", "/admin", { origin: FOREIGN }), env);
    expect(res.status).toBe(200);
  });

  it("serves GET /admin/api/auth/me with a foreign Origin", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(req("GET", "/admin/api/auth/me", { origin: FOREIGN, bearer: true }), env);
    expect(res.status).toBe(200);
  });

  it("leaves HEAD and OPTIONS alone", async () => {
    const { env } = await makeEnv();
    for (const method of ["HEAD", "OPTIONS"]) {
      const res = await handleAdminRequest(req(method, "/admin", { origin: FOREIGN, bearer: true }), env);
      expect(res.status, method).not.toBe(403);
    }
  });
});
