import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";

/* Security V2 Stage 5 — every response leaving handleAdminRequest carries the
 * full header set (spec 6.1), HTML gets a per-response nonce CSP, and the
 * KEYS panel no longer renders DB strings raw (baseline risk #7). */

const TOKEN = "correct-horse-battery-staple";

class FakeD1 {
  constructor(private db: any) {}

  prepare(sql: string) {
    const db = this.db;
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

  async batch(stmts: any[]) {
    for (const s of stmts) await s.run();
    return [];
  }
}

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
      id INTEGER PRIMARY KEY, status TEXT, country TEXT, email TEXT,
      customer_segment TEXT, product_categories TEXT, products_services TEXT,
      company_name TEXT, description TEXT, business_tag TEXT, lead_score INTEGER,
      display_id TEXT, company_id TEXT
    );
    CREATE TABLE outreach_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, company_id TEXT,
      display_id TEXT, company_name TEXT, brand_name TEXT, status TEXT
    );
    CREATE TABLE outreach_settings (brand_name TEXT PRIMARY KEY, company_intro TEXT, enabled INTEGER);
  `);
  return {
    db,
    env: { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN, ...overrides } as unknown as AdminEnv,
  };
}

const BASE = "https://worker.example";

function get(pathname: string, headers: Record<string, string> = {}): Request {
  return new Request(BASE + pathname, { headers });
}

/** The five headers every /admin response must carry, verbatim. */
const REQUIRED_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

function expectBaselineHeaders(res: Response) {
  for (const [name, value] of Object.entries(REQUIRED_HEADERS)) {
    expect(res.headers.get(name), name).toBe(value);
  }
  expect(res.headers.get("Cache-Control")).toBe("no-store");
}

function nonceFrom(csp: string): string {
  const m = /'nonce-([^']+)'/.exec(csp);
  expect(m, "CSP must carry a nonce").not.toBeNull();
  return m![1];
}

/* ── Header baseline ───────────────────────────────────────────────────── */

describe("stage 5: security headers on every admin response", () => {
  it("sends the full header set on the login page (unauthed HTML)", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(get("/admin"), env);
    expect(res.status).toBe(200);
    expectBaselineHeaders(res);
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("sends them on the authed panel HTML too", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(get("/admin", { Authorization: `Bearer ${TOKEN}` }), env);
    expect(res.status).toBe(200);
    expectBaselineHeaders(res);
    const csp = res.headers.get("Content-Security-Policy") || "";
    expect(csp).toContain("script-src 'self' 'nonce-");
  });

  it("sends them on JSON API responses with a deny-all CSP", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(
      get("/admin/api/auth/me", { Authorization: `Bearer ${TOKEN}` }),
      env,
    );
    expect(res.status).toBe(200);
    expectBaselineHeaders(res);
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it("sends them on 401 failures — errors are responses too", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(get("/admin/api/auth/me"), env);
    expect(res.status).toBe(401);
    expectBaselineHeaders(res);
  });

  it("sends them on the 303 login redirect, keeping Set-Cookie intact", async () => {
    const { env } = await makeEnv();
    const body = new FormData();
    body.set("token", TOKEN);
    const res = await handleAdminRequest(
      new Request(BASE + "/admin/login", {
        method: "POST",
        headers: { "CF-Connecting-IP": "1.2.3.4" },
        body,
      }),
      env,
    );
    expect(res.status).toBe(303);
    expectBaselineHeaders(res);
    expect(res.headers.get("Location")).toBeTruthy();
    expect(res.headers.get("Set-Cookie")).toContain("crm_session=");
  });

  it("sends them on the plain-text 404 for unknown /admin paths", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(get("/admin/nope"), env);
    expect(res.status).toBe(404);
    expectBaselineHeaders(res);
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it("still returns null untouched for non-admin paths (index.ts owns those)", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(get("/health"), env);
    expect(res).toBeNull();
  });
});

/* ── Nonce CSP ─────────────────────────────────────────────────────────── */

describe("stage 5: nonce-based CSP for panel HTML", () => {
  it("injects the CSP nonce into every inline <script> and <style> tag", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(get("/admin"), env);
    const html = await res.text();
    const nonce = nonceFrom(res.headers.get("Content-Security-Policy") || "");
    // Login page: has a <style>, no <script>. Panel page: both.
    expect(html).not.toContain("<style>");
    expect(html).not.toContain("<script>");
    expect(html).toContain(`<style nonce="${nonce}">`);
  });

  it("nonces every script tag of the authed panel and matches the header nonce", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(get("/admin", { Authorization: `Bearer ${TOKEN}` }), env);
    const html = await res.text();
    const nonce = nonceFrom(res.headers.get("Content-Security-Policy") || "");
    const nonced = html.match(/<script nonce="[^"]+">/g) || [];
    expect(nonced.length).toBeGreaterThan(0);
    for (const tag of nonced) expect(tag).toBe(`<script nonce="${nonce}">`);
    const styles = html.match(/<style nonce="[^"]+">/g) || [];
    expect(styles.length).toBeGreaterThan(0);
    for (const tag of styles) expect(tag).toBe(`<style nonce="${nonce}">`);
  });

  it("mints a fresh nonce per response", async () => {
    const { env } = await makeEnv();
    const first = await handleAdminRequest(get("/admin"), env);
    const second = await handleAdminRequest(get("/admin"), env);
    const n1 = nonceFrom(first.headers.get("Content-Security-Policy") || "");
    const n2 = nonceFrom(second.headers.get("Content-Security-Policy") || "");
    expect(n1).not.toBe(n2);
  });

  it("keeps unsafe-eval and unsafe-inline out entirely", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(get("/admin"), env);
    const csp = res.headers.get("Content-Security-Policy") || "";
    expect(csp).not.toContain("unsafe-eval");
    // Stage 30: panels carry no style="" attributes any more, so the whole
    // policy is nonce-based — 'unsafe-inline' must not appear anywhere.
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("style-src-attr");
    expect(csp).toMatch(/script-src 'self' 'nonce-/);
    expect(csp).toMatch(/style-src 'self' 'nonce-/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });
});

/* ── KEYS panel escaping (baseline risk #7) ────────────────────────────── */

describe("stage 5: KEYS panel escapes DB-sourced strings", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "..", "src", "admin.ts"), "utf8");
  // The KEYS panel script is the third <script> block in the templates.
  const keysScript = src.slice(src.indexOf("var PROVIDER_NAMES="));

  it("defines an esc() helper before any row rendering uses it", () => {
    const escAt = keysScript.indexOf("var esc=function");
    const renderAt = keysScript.indexOf("tr.innerHTML=");
    expect(escAt).toBeGreaterThan(-1);
    expect(renderAt).toBeGreaterThan(escAt);
  });

  it("escapes operator labels, model names, upstream errors and key hints", () => {
    // Key row: label/model/last_error come from the operator or upstream
    // providers; key_hint is a hint sliced out of raw key material (Stage 18
    // renamed the response field off the §19-forbidden api_key name).
    expect(keysScript).toMatch(/esc\(k\.label\|\|'-'\)/);
    expect(keysScript).toMatch(/esc\(k\.model\|\|'-'\)/);
    expect(keysScript).toMatch(/esc\(k\.last_error\|\|'-'\)/);
    expect(keysScript).toMatch(/var keyCell=esc\(k\.key_hint\)/);
    expect(keysScript).toMatch(/providerName\(k\.provider\)/);
  });

  it("escapes cooldown and history rows (key index, error text, timestamps)", () => {
    expect(keysScript).toMatch(/esc\(c\.key_index\|\|''\)/);
    expect(keysScript).toMatch(/esc\(c\.last_error\|\|'限流'\)/);
    expect(keysScript).toMatch(/esc\(until\)/);
  });

  it("escapes settings values placed into input value attributes", () => {
    expect(keysScript).toMatch(/value="'\+esc\(s\.default_model\|\|''\)\+'"/);
  });
});
