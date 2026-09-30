import { describe, it, expect } from "vitest";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";

/* Two hardening fixes, both aimed at the fact that this repository is public:
 * /admin/login is trivially discoverable and its 500s were echoing whatever
 * D1 or an upstream provider happened to say. */

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

const TOKEN = "correct-horse-battery-staple";

async function makeEnv(overrides: Record<string, unknown> = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE admin_login_attempts (
      scope TEXT NOT NULL, ident TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
      window_start TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, locked_until TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (scope, ident)
    );
    -- Enough for the segment preview to run and reach a business-rule error.
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

function loginReq(token: string, ip?: string): Request {
  const body = new FormData();
  body.set("token", token);
  // Let Request derive the multipart Content-Type itself; forcing
  // urlencoded here would make formData() fail and every attempt would
  // "fail" for the wrong reason.
  const headers: Record<string, string> = {};
  if (ip) headers["CF-Connecting-IP"] = ip;
  return new Request("https://worker.example/admin/login", { method: "POST", headers, body });
}

/* ── Login throttling ──────────────────────────────────────────────────── */

describe("POST /admin/login brute-force throttling", () => {
  it("rejects a wrong token without mentioning what was wrong", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(loginReq("wrong", "1.2.3.4"), env);
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).toContain("授权失败");
    // The panel token must never appear in a response, valid or not.
    expect(text).not.toContain(TOKEN);
  });

  it("locks the caller out after a run of failures", async () => {
    const { env } = await makeEnv();
    for (let i = 0; i < 5; i++) {
      const res = await handleAdminRequest(loginReq(`guess-${i}`, "1.2.3.4"), env);
      expect(res.status).toBe(401);
    }
    const locked = await handleAdminRequest(loginReq("guess-6", "1.2.3.4"), env);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("refuses the CORRECT token while locked, without confirming it is correct", async () => {
    const { env } = await makeEnv();
    for (let i = 0; i < 5; i++) await handleAdminRequest(loginReq(`guess-${i}`, "1.2.3.4"), env);
    const res = await handleAdminRequest(loginReq(TOKEN, "1.2.3.4"), env);
    expect(res.status).toBe(429);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    // A throttled caller learns nothing about the value it is holding.
    expect(text).not.toMatch(/授权失败/);
  });

  it("counts each IP separately", async () => {
    const { env } = await makeEnv();
    for (let i = 0; i < 5; i++) await handleLogin(env, `guess-${i}`, "1.2.3.4");
    // A different address is unaffected by someone else's run.
    const other = await handleLogin(env, TOKEN, "9.9.9.9");
    expect(other.status).toBe(303);
  });

  it("lets the operator back in after a slip, rather than locking them out", async () => {
    const { db, env } = await makeEnv();
    for (let i = 0; i < 4; i++) await handleAdminRequest(loginReq("typo", "1.2.3.4"), env);
    // The 5th try is the real token: success must clear the counter, or the
    // operator locks themselves out of their own panel.
    const res = await handleAdminRequest(loginReq(TOKEN, "1.2.3.4"), env);
    expect(res.status).toBe(303);
    const row = db
      .prepare("SELECT failures FROM admin_login_attempts WHERE scope = 'ip' AND ident = '1.2.3.4'")
      .get();
    expect(row).toBeUndefined();
  });

  it("throttles a distributed spray that rotates source addresses", async () => {
    const { env } = await makeEnv();
    // Each IP only ever fails once, so a per-IP limit alone would never trip.
    for (let i = 0; i < 30; i++) {
      const res = await handleLogin(env, "guess", `10.0.0.${i + 1}`);
      expect(res.status).toBe(401);
    }
    const res = await handleLogin(env, "guess", "10.0.0.200");
    expect(res.status).toBe(429);
  });

  it("collapses forged or missing IP headers into one shared bucket", async () => {
    const { db, env } = await makeEnv();
    // Without this, junk headers would mint a fresh row per attempt and the
    // table would grow without bound while the throttle never engaged.
    for (let i = 0; i < 5; i++) {
      await handleLogin(env, `guess-${i}`, `not-an-ip-${i}`.slice(0, 40));
    }
    const res = await handleLogin(env, "guess", "still not an ip");
    expect(res.status).toBe(429);
    const rows = db.prepare("SELECT COUNT(*) n FROM admin_login_attempts WHERE scope = 'ip'").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("still returns 503 when the panel token is unconfigured", async () => {
    const { env } = await makeEnv({ ADMIN_PANEL_TOKEN: undefined });
    const res = await handleAdminRequest(loginReq("anything", "1.2.3.4"), env);
    expect(res.status).toBe(503);
  });
});

async function handleLogin(env: AdminEnv, token: string, ip: string): Promise<Response> {
  return handleAdminRequest(loginReq(token, ip), env);
}

/* ── Error redaction ───────────────────────────────────────────────────── */

describe("500 responses do not leak internals", () => {
  it("redacts a D1 failure and returns a correlatable request id", async () => {
    const { env } = await makeEnv();
    // Force a throw from inside a handler that would otherwise be reachable.
    const broken = {
      ...env,
      DB: {
        prepare() {
          throw new Error("D1_ERROR: no such table: api_configs");
        },
      },
    } as unknown as AdminEnv;

    const res = await handleAdminRequest(
      new Request("https://worker.example/admin/api/keys", {
        headers: { "Cookie": `crm_admin_token=${TOKEN}` },
      }),
      broken,
    );
    expect(res.status).toBe(500);
    const body = await res.json() as { detail: string; request_id: string };
    expect(body.detail).not.toContain("api_configs");
    expect(body.detail).not.toContain("D1_ERROR");
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps operator-fixable 400s readable", async () => {
    const { env } = await makeEnv();
    // An empty group name is rejected by our own validation with a message
    // written for the operator. Redaction must not swallow these: turning
    // "名称不能为空" into a request id would make the panel unactionable.
    const res = await handleAdminRequest(
      new Request("https://worker.example/admin/api/outreach/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cookie": `crm_admin_token=${TOKEN}` },
        body: JSON.stringify({ name: "   ", filters: {} }),
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { detail: string };
    expect(body.detail).toMatch(/不能为空/);
  });
});
