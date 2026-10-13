import { describe, it, expect, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";
import { redactAuditMetadata, writeAuditLog } from "../src/audit/audit-log";

/* Security V2 Stage 9 — audit log (spec §10).
 *
 * §10.3 test list:
 *   - successful action → audit row
 *   - failed authorization → audit row
 *   - secret values never appear
 * Plus unit coverage of the §10.2 redaction boundary and the fail-open
 * policy (an audit failure must never break the business action).
 */

const TOKEN = "audit-test-master-token";
const MASTER = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const BASE = "https://worker.example";

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
    const out: any[] = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

async function makeEnv(overrides: Record<string, unknown> = {}) {
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
    CREATE TABLE admin_login_attempts (
      scope TEXT NOT NULL, ident TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
      window_start TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, locked_until TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (scope, ident)
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, actor_user_id TEXT, actor_role TEXT,
      action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT,
      request_id TEXT, metadata_json TEXT, ip_hash TEXT, user_agent_hash TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY, company_id TEXT, display_id TEXT, domain TEXT,
      status TEXT, company_name TEXT, legal_name TEXT, trading_name TEXT, normalized_domain TEXT,
      first_name TEXT, last_name TEXT, full_name TEXT, title TEXT, department TEXT, linkedin_url TEXT,
      street_address TEXT, zip_city TEXT, country TEXT, country_code TEXT, region TEXT, city TEXT, postal_code TEXT,
      tel TEXT, email TEXT, cellphone TEXT, whatsapp TEXT, products_services TEXT, business_tag TEXT,
      industry TEXT, company_type TEXT, business_model TEXT, founded_year TEXT, employee_range TEXT,
      description TEXT, target_markets TEXT, is_manufacturer TEXT, is_importer TEXT, is_distributor TEXT,
      is_wholesaler TEXT, is_retailer TEXT, is_ecommerce TEXT, is_rental TEXT, is_oem TEXT, social_accounts TEXT,
      full_research_text TEXT, social_accounts_verified TEXT, customer_segment TEXT,
      product_categories TEXT, company_size TEXT, geographic_coverage TEXT,
      personas_and_solutions TEXT, remarks TEXT, updated_at TEXT,
      company_profile TEXT, outreach_context TEXT, buying_signals TEXT, lead_score INTEGER, source_import_id TEXT
    );
    CREATE TABLE customer_imports (
      import_id TEXT, file_name TEXT, row_number INTEGER, raw_json TEXT,
      mapped_company_id TEXT, dedup_status TEXT, request_id TEXT
    );
    CREATE TABLE api_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL, label TEXT, api_key TEXT NOT NULL,
      key_hint TEXT, key_fingerprint TEXT,
      rpm_limit INTEGER, is_active INTEGER NOT NULL DEFAULT 1, model TEXT,
      last_error TEXT, last_used_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    -- pre-filter action=queue 先作废旧研究（research_sources 置 is_current=0）
    -- 再重新入队，两条 UPDATE 同 batch；审计断言依赖 batch 的逐语句结果。
    CREATE TABLE research_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      research_run_id TEXT,
      customer_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_url TEXT,
      raw_text TEXT,
      content_hash TEXT,
      parser_version TEXT,
      fetched_at TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 1,
      valid_from TEXT,
      valid_until TEXT
    );
  `);
  db.prepare("INSERT INTO customers (id, company_id, domain, status, company_name, country, lead_score) VALUES (1, 'c1', 'acme.com', 'completed', 'Acme', 'US', 80)").run();
  return {
    db,
    env: { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN, CREDENTIAL_ENC_KEY: MASTER, ...overrides } as unknown as AdminEnv,
  };
}

/** Raw DB rows are objects keyed by column name; keep the type loose like D1. */
type AuditRow = {
  id: string; actor_user_id: string | null; actor_role: string | null;
  action: string; resource_type: string; resource_id: string | null;
  request_id: string | null; metadata_json: string | null;
  ip_hash: string | null; user_agent_hash: string | null; created_at: string;
};

function auditRows(db: any): AuditRow[] {
  return db.prepare("SELECT * FROM audit_logs ORDER BY rowid").all() as AuditRow[];
}

/** §10.2 helper: assert a candidate secret appears in NO column of NO row. */
function assertNothingContains(rows: AuditRow[], needle: string) {
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (typeof value === "string") {
        expect(value.includes(needle)).toBe(false);
      }
    }
  }
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

function call(env: AdminEnv, path: string, init: RequestInit = {}): Promise<Response> {
  return handleAdminRequest(
    new Request(`${BASE}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}) },
    }),
    env,
  ) as Promise<Response>;
}

const bearer = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ── §10.2 redaction boundary (unit) ───────────────────────────────────── */

describe("stage 9: redactAuditMetadata (§10.2 denylist)", () => {
  it("returns null for empty metadata", () => {
    expect(redactAuditMetadata(null)).toBeNull();
    expect(redactAuditMetadata(undefined)).toBeNull();
  });

  it("passes non-secret metadata through unchanged", () => {
    expect(redactAuditMetadata({ provider: "groq", added: 3, ok: true }))
      .toBe(JSON.stringify({ provider: "groq", added: 3, ok: true }));
  });

  it("redacts every §10.2 secret key name, nested and inside arrays", () => {
    const out = JSON.parse(redactAuditMetadata({
      api_key: "sk-live-1",
      nested: { private_key: "PEM", password: "hunter2", list: [{ refresh_token: "r1" }] },
      client_secret: "cs",
      access_token: "at",
      session_token: "st",
    }) as string);
    expect(out.api_key).toBe("[REDACTED]");
    expect(out.nested.private_key).toBe("[REDACTED]");
    expect(out.nested.password).toBe("[REDACTED]");
    expect(out.nested.list[0].refresh_token).toBe("[REDACTED]");
    expect(out.client_secret).toBe("[REDACTED]");
    expect(out.access_token).toBe("[REDACTED]");
    expect(out.session_token).toBe("[REDACTED]");
    expect(JSON.stringify(out).includes("sk-live-1")).toBe(false);
    expect(JSON.stringify(out).includes("hunter2")).toBe(false);
  });

  it("normalizes key spellings before matching (API-KEY, apiKey, refresh-token)", () => {
    const out = JSON.parse(redactAuditMetadata({
      "API-KEY": "x", apiKey: "x", "refresh-token": "x", Authorization: "x", Bearer: "x",
    }) as string);
    expect(Object.values(out).every((v) => v === "[REDACTED]")).toBe(true);
  });

  it("does not over-redact benign keys that merely resemble secret names", () => {
    const out = JSON.parse(redactAuditMetadata({
      key_hint: "…abc", keys_added: 5, token_count: 12, provider: "tavily",
    }) as string);
    expect(out.key_hint).toBe("…abc");
    expect(out.keys_added).toBe(5);
    expect(out.token_count).toBe(12);
    expect(out.provider).toBe("tavily");
  });

  it("collapses nesting beyond the depth cap", () => {
    const deep = { a: { b: { c: { d: { e: { f: "x" } } } } } };
    const out = JSON.parse(redactAuditMetadata(deep) as string);
    expect(out.a.b.c.d).toBe("[REDACTED]");
  });

  it("clips oversized metadata to a parseable, bounded JSON string", () => {
    const huge = { blob: "a".repeat(10_000) };
    const out = redactAuditMetadata(huge) as string;
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out).blob.length).toBeLessThanOrEqual(201);
  });
});

/* ── writeAuditLog unit: row shape + fail-open policy ──────────────────── */

describe("stage 9: writeAuditLog (row shape, hashing, fail-open)", () => {
  it("inserts a row with hashed client fingerprints (never raw)", async () => {
    const { db, env } = await makeEnv();
    const req = new Request(BASE + "/x", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.7", "User-Agent": "Mozilla/5.0 test-agent" },
    });
    await writeAuditLog(env, req, {
      actorUserId: "u_admin", actorRole: "super_admin",
      action: "LOGIN", resourceType: "admin_session", resourceId: null,
      metadata: { via: "api" },
    });
    const rows = auditRows(db);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.action).toBe("LOGIN");
    expect(row.actor_user_id).toBe("u_admin");
    expect(row.actor_role).toBe("super_admin");
    expect(row.metadata_json).toBe(JSON.stringify({ via: "api" }));
    // Fingerprints are SHA-256 hex of the raw values, never the raw values.
    expect(row.ip_hash).toBe(await sha256Hex("203.0.113.7"));
    expect(row.user_agent_hash).toBe(await sha256Hex("Mozilla/5.0 test-agent"));
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("stores null fingerprints for system (cron) events with no request", async () => {
    const { db, env } = await makeEnv();
    await writeAuditLog(env, null, {
      actorUserId: null, actorRole: "system",
      action: "START_RESEARCH", resourceType: "customer", resourceId: "42",
      metadata: { via: "cron" },
    });
    const row = auditRows(db)[0];
    expect(row.ip_hash).toBeNull();
    expect(row.user_agent_hash).toBeNull();
    expect(row.actor_role).toBe("system");
  });

  it("fail-open: a D1 failure is logged but never thrown", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      DB: {
        prepare() {
          return {
            bind() { return this; },
            run: async () => { throw new Error("D1 exploded"); },
          };
        },
      },
    } as unknown as AdminEnv;
    await expect(writeAuditLog(broken, null, {
      actorUserId: null, actorRole: null,
      action: "LOGIN", resourceType: "admin_session", resourceId: null,
    })).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("missing audit_logs table (migration pending) is a silent no-op", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE unrelated (id TEXT)");
    const env = { DB: new FakeD1(db) } as unknown as AdminEnv;
    await expect(writeAuditLog(env, null, {
      actorUserId: null, actorRole: null,
      action: "LOGIN", resourceType: "admin_session", resourceId: null,
    })).resolves.toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

/* ── §10.3 through the real router ─────────────────────────────────────── */

describe("stage 9: audit rows through the admin API (spec §10.3)", () => {
  it("successful action → audit row (IMPORT_CSV with outcome counts)", async () => {
    const { db, env } = await makeEnv();
    const res = await call(env, "/admin/api/customers/import", bearer({
      method: "POST",
      body: JSON.stringify({ csv: "company_name,country\nNewco,US\n", file_name: "seed.csv" }),
    }));
    expect(res.status).toBe(200);
    const rows = auditRows(db).filter((r) => r.action === "IMPORT_CSV");
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBe("u_admin");
    expect(rows[0].actor_role).toBe("super_admin");
    expect(rows[0].resource_type).toBe("customer_import");
    const meta = JSON.parse(rows[0].metadata_json as string);
    expect(meta.inserted).toBe(1);
    expect(meta.file_name).toBe("seed.csv");
  });

  it("successful action → audit row (UPDATE_CUSTOMER records fields, not values)", async () => {
    const { db, env } = await makeEnv();
    const res = await call(env, "/admin/api/customers/1", bearer({
      method: "PATCH",
      body: JSON.stringify({ remarks: "hand-edited note" }),
    }));
    expect(res.status).toBe(200);
    const rows = auditRows(db).filter((r) => r.action === "UPDATE_CUSTOMER");
    expect(rows).toHaveLength(1);
    expect(rows[0].resource_id).toBe("1");
    const meta = JSON.parse(rows[0].metadata_json as string);
    expect(meta.fields).toEqual(["remarks"]);
    expect(rows[0].metadata_json?.includes("hand-edited note")).toBe(false);
  });

  it("failed authorization → audit row (ACCESS_DENIED with the required permission)", async () => {
    const { db, env } = await makeEnv();
    const token = await mintSession(db, "operator");
    const res = await call(env, "/admin/api/keys/1", {
      method: "PATCH",
      headers: { Cookie: `crm_session=${token}` },
      body: JSON.stringify({ is_active: 0 }),
    });
    expect(res.status).toBe(403);
    const rows = auditRows(db).filter((r) => r.action === "ACCESS_DENIED");
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBe("u_operator");
    expect(rows[0].actor_role).toBe("operator");
    expect(rows[0].resource_id).toBe("/admin/api/keys/1");
    const meta = JSON.parse(rows[0].metadata_json as string);
    expect(meta.permission).toBe("providers.write");
    expect(meta.reason).toBe("forbidden");
  });

  it("unauthenticated state-changing attempt → ACCESS_DENIED; plain GET probe → no row", async () => {
    const { db, env } = await makeEnv();
    const post = await call(env, "/admin/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "groq", api_key: "x" }),
    });
    expect(post.status).toBe(401);
    const get = await call(env, "/admin/api/keys", { method: "GET" });
    expect(get.status).toBe(401);
    const rows = auditRows(db).filter((r) => r.action === "ACCESS_DENIED");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].metadata_json as string).reason).toBe("unauthenticated");
  });

  it("LOGIN / LOGOUT produce rows; LOGIN_FAILED produces one that never echoes the guess", async () => {
    const { db, env } = await makeEnv();

    const bad = await call(env, "/admin/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong-guess-" + "x".repeat(20) }),
    });
    expect(bad.status).toBe(401);
    const failedRows = auditRows(db).filter((r) => r.action === "LOGIN_FAILED");
    expect(failedRows).toHaveLength(1);
    assertNothingContains(auditRows(db), "wrong-guess-");

    const good = await call(env, "/admin/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: TOKEN }),
    });
    expect(good.status).toBe(200);
    const loginRow = auditRows(db).filter((r) => r.action === "LOGIN").pop();
    expect(loginRow).toBeDefined();
    expect(loginRow.actor_user_id).toBe("u_admin");
    // §10.2: the credential that just succeeded never lands in the trail.
    assertNothingContains(auditRows(db), TOKEN);

    const cookie = (good.headers.get("Set-Cookie") ?? "").split(";")[0];
    const out = await call(env, "/admin/api/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(out.status).toBe(200);
    const logoutRow = auditRows(db).filter((r) => r.action === "LOGOUT").pop();
    expect(logoutRow).toBeDefined();
    expect(logoutRow.actor_user_id).toBe("u_admin");
    // The session token value must not appear either.
    assertNothingContains(auditRows(db), cookie.split("=")[1]);
  });

  it("secret values never appear: creating an API key audits the fact, not the key", async () => {
    const { db, env } = await makeEnv();
    const secret = "sk-live-audit-secret-987654321";
    const res = await call(env, "/admin/api/keys", bearer({
      method: "POST",
      body: JSON.stringify({ provider: "groq", api_key: secret, label: "main" }),
    }));
    expect(res.status).toBe(200);
    const rows = auditRows(db).filter((r) => r.action === "CREATE_API_KEY");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].metadata_json as string).provider).toBe("groq");
    expect(rows[0].resource_id).toBe("1");
    assertNothingContains(auditRows(db), secret);
  });

  it("pre-filter re-queue is audited as START_RESEARCH with the queued count", async () => {
    const { db, env } = await makeEnv();
    const res = await call(env, "/admin/api/customers/pre-filter?action=queue&countries=US", bearer());
    expect(res.status).toBe(200);
    const rows = auditRows(db).filter((r) => r.action === "START_RESEARCH");
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0].metadata_json as string);
    expect(meta.via).toBe("pre-filter");
    expect(meta.queued).toBe(1);
  });
});
