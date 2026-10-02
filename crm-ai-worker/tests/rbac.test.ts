import { describe, it, expect } from "vitest";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";
import { ROLE_PERMISSIONS, roleHasPermission } from "../src/auth/rbac";

/* Security V2 Stage 2: RBAC. Roles are server-side enforced at the central
 * /admin/api/* gate; the panels can hide buttons but never grant anything. */

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

async function makeEnv() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(`
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
    CREATE TABLE outreach_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, description TEXT,
      filters TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE outreach_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, company_id TEXT,
      display_id TEXT, company_name TEXT, email_to TEXT, product_category TEXT,
      brand_name TEXT, subject TEXT, body TEXT, status TEXT,
      sent_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE outreach_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, brand_name TEXT NOT NULL UNIQUE,
      product_category TEXT NOT NULL, company_intro TEXT, sender_email TEXT,
      sender_name TEXT, company_entity TEXT, signature TEXT, gmail_account TEXT,
      enabled INTEGER DEFAULT 0, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE gmail_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT,
      credential_type TEXT NOT NULL DEFAULT 'service_account',
      client_email TEXT NOT NULL UNIQUE, private_key TEXT NOT NULL,
      delegated_domain TEXT, daily_limit INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
      last_error TEXT, cooldown_until TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE gmail_send_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, outreach_email_id INTEGER,
      recipient TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'sent',
      detail TEXT, sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    `);
  return { db, env: { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: "test-master-token" } as unknown as AdminEnv };
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Insert a user with the given role and mint a live session cookie value. */
async function mintSession(db: any, role: string): Promise<string> {
  const userId = `u_${role}`;
  db.prepare("INSERT OR IGNORE INTO admin_users (id, username, role) VALUES (?, ?, ?)")
    .run(userId, `user_${role}`, role);
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  db.prepare(
    `INSERT INTO admin_sessions (id, user_id, token_hash, role, created_at, expires_at)
     VALUES (?, ?, ?, ?, '2026-01-01 00:00:00', '2099-01-01 00:00:00')`,
  ).run(`s_${role}_${crypto.randomUUID()}`, userId, await sha256Hex(token), role);
  return token;
}

function call(env: AdminEnv, path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return handleAdminRequest(
    new Request(`https://worker.example${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Cookie: `crm_session=${token}` },
    }),
    env,
  ) as Promise<Response>;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/* ── Spec-mandated role boundaries ─────────────────────────────────────── */

describe("RBAC: role boundaries (server-side enforced)", () => {
  it("operator cannot update an API key", async () => {
    const { db, env } = await makeEnv();
    const token = await mintSession(db, "operator");
    const res = await call(env, "/admin/api/keys/1", token, { method: "PATCH", body: JSON.stringify({ is_active: 0 }) });
    expect(res.status).toBe(403);
    const body = await res.json() as { detail: string };
    expect(body.detail).toContain("providers.write");
  });

  it("researcher cannot send email", async () => {
    const { db, env } = await makeEnv();
    const token = await mintSession(db, "researcher");
    const res = await call(env, "/admin/api/outreach/send-batch", token, json({ count: 5 }));
    expect(res.status).toBe(403);
    expect((await res.json() as { detail: string }).detail).toContain("outreach.send");
  });

  it("sender cannot create, modify or delete a Gmail account", async () => {
    const { db, env } = await makeEnv();
    const token = await mintSession(db, "sender");
    const create = await call(env, "/admin/api/gmail/accounts", token, json({ client_email: "x@y.iam", private_key: "k" }));
    expect(create.status).toBe(403);
    expect((await create.json() as { detail: string }).detail).toContain("credentials.write");
    const patch = await call(env, "/admin/api/gmail/accounts/1", token, { method: "PATCH", body: JSON.stringify({ daily_limit: 100 }) });
    expect(patch.status).toBe(403);
    const del = await call(env, "/admin/api/gmail/accounts/1", token, { method: "DELETE" });
    expect(del.status).toBe(403);
  });

  it("sender cannot touch provider keys; Worker self-secret management is gone entirely", async () => {
    const { db, env } = await makeEnv();
    const token = await mintSession(db, "sender");
    const keys = await call(env, "/admin/api/keys", token, json({ provider: "groq", api_key: "gsk_x" }));
    expect(keys.status).toBe(403);
    // Stage 3 removed /admin/api/secrets — the Worker can no longer rewrite
    // its own Cloudflare secrets, so the route 404s for every role.
    const secrets = await call(env, "/admin/api/secrets", token);
    expect(secrets.status).toBe(404);
  });

  it("readonly cannot modify a customer", async () => {
    const { db, env } = await makeEnv();
    const token = await mintSession(db, "readonly");
    const res = await call(env, "/admin/api/customers/1", token, { method: "PATCH", body: JSON.stringify({ country: "Spain" }) });
    expect(res.status).toBe(403);
    expect((await res.json() as { detail: string }).detail).toContain("customers.write");
  });

  it("nobody can manage Cloudflare Worker secrets — endpoint removed (Stage 3)", async () => {
    const { db, env } = await makeEnv();
    // Every role, super_admin included: the route is gone, not just gated.
    for (const role of ["super_admin", "operator", "researcher", "sender", "readonly"]) {
      const token = await mintSession(db, role);
      const get = await call(env, "/admin/api/secrets", token);
      expect(get.status).toBe(404);
      const update = await call(env, "/admin/api/secrets/update", token, json({ updates: [{ name: "GROQ_API_KEY", value: "gsk_x" }] }));
      expect(update.status).toBe(404);
      const bootstrap = await call(env, "/admin/api/secrets/bootstrap", token, json({ api_token: "cf_x", account_id: "acc" }));
      expect(bootstrap.status).toBe(404);
    }
  });

  it("the /admin/secrets page is gone for every role", async () => {
    const { db, env } = await makeEnv();
    for (const role of ["super_admin", "operator", "sender"]) {
      const token = await mintSession(db, role);
      const res = await call(env, "/admin/secrets", token);
      expect(res.status).toBe(404);
    }
  });
});

/* ── Positive paths: permitted actions still reach the handler ─────────── */

describe("RBAC: permitted actions reach the handler", () => {
  it("readonly can list customers but the gate still blocks mutations", async () => {
    const { db, env } = await makeEnv();
    const token = await mintSession(db, "readonly");
    const res = await call(env, "/admin/api/customers?limit=10", token);
    expect(res.status).toBe(200);
  });

  it("sender passes the gate for send-batch (outreach.send granted)", async () => {
    const { db, env } = await makeEnv();
    const token = await mintSession(db, "sender");
    const res = await call(env, "/admin/api/outreach/send-batch", token, json({ count: 1 }));
    // Not 403 ⇒ permission granted; the handler's own business response follows.
    expect(res.status).not.toBe(403);
  });

  it("operator passes the gate for group mutations (campaigns.write granted)", async () => {
    const { db, env } = await makeEnv();
    const token = await mintSession(db, "operator");
    const res = await call(env, "/admin/api/outreach/groups", token, json({ name: "  ", filters: {} }));
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400); // validation error from inside the handler
  });

  it("unknown roles fail closed", async () => {
    const { db, env } = await makeEnv();
    const token = await mintSession(db, "evil-genius");
    const res = await call(env, "/admin/api/customers/1", token, { method: "PATCH", body: JSON.stringify({}) });
    expect(res.status).toBe(403);
  });
});

/* ── Matrix sanity ─────────────────────────────────────────────────────── */

describe("RBAC: permission matrix", () => {
  it("every role's grants are a subset of super_admin's, and every role can read customers", () => {
    const root = ROLE_PERMISSIONS.super_admin;
    for (const [role, grants] of Object.entries(ROLE_PERMISSIONS)) {
      for (const p of grants) {
        expect(root.has(p)).toBe(true);
      }
      expect(roleHasPermission(role, "customers.read")).toBe(true);
    }
  });

  it("sender has exactly the narrow send surface", () => {
    const sender = ROLE_PERMISSIONS.sender;
    expect(sender.has("outreach.send")).toBe(true);
    expect(sender.has("outreach.read")).toBe(true);
    expect(sender.has("customers.read")).toBe(true);
    expect(sender.size).toBe(3);
  });
});
