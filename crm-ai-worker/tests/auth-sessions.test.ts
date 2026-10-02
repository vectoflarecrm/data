import { describe, it, expect } from "vitest";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";

/* Security V2 Stage 1: server-side admin sessions.
 *
 * The master ADMIN_PANEL_TOKEN must authenticate the login POST only; the
 * browser then holds an opaque random session token whose SHA-256 hash is
 * the only server-side copy. These tests pin the properties the stage spec
 * demands: hashed storage, expiry, revocation, rotation, fixation defense
 * and fail-closed behavior when the session tables are absent. */

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
    CREATE TABLE customers (id INTEGER PRIMARY KEY);
  `);
  return {
    db,
    env: { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN, ...overrides } as unknown as AdminEnv,
  };
}

function formLogin(token: string, ip = "1.2.3.4", cookie?: string): Request {
  const body = new FormData();
  body.set("token", token);
  const headers: Record<string, string> = { "CF-Connecting-IP": ip };
  if (cookie) headers.Cookie = cookie;
  return new Request("https://worker.example/admin/login", { method: "POST", headers, body });
}

function jsonLogin(password: string, ip = "1.2.3.4", cookie?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
  if (cookie) headers.Cookie = cookie;
  return new Request("https://worker.example/admin/api/auth/login", {
    method: "POST",
    headers,
    body: JSON.stringify({ password }),
  });
}

function sessionCookie(token: string): string {
  return `crm_session=${token}`;
}

function authed(path: string, token: string, init: RequestInit = {}): Request {
  return new Request(`https://worker.example${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Cookie: sessionCookie(token) },
  });
}

/** Pull the crm_session value out of a Set-Cookie header. */
function extractToken(res: Response): string {
  const cookie = res.headers.get("Set-Cookie") ?? "";
  const match = cookie.match(/crm_session=([^;]+)/);
  if (!match) throw new Error(`no crm_session cookie in "${cookie}"`);
  return match[1];
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function login(db: any, env: AdminEnv): Promise<string> {
  const res = await handleAdminRequest(formLogin(TOKEN), env);
  expect(res.status).toBe(303);
  return extractToken(res);
}

/* ── Login mints a hashed session ──────────────────────────────────────── */

describe("session login", () => {
  it("form login mints an opaque session cookie, never the master token", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(formLogin(TOKEN), env);
    expect(res.status).toBe(303);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("crm_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=3600");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain(TOKEN);
  });

  it("stores only the SHA-256 hash of the session token in D1", async () => {
    const { db, env } = await makeEnv();
    const token = await login(db, env);
    const raw = db.prepare("SELECT COUNT(*) AS n FROM admin_sessions").get() as { n: number };
    expect(raw.n).toBe(1);
    const row = db.prepare("SELECT token_hash FROM admin_sessions").get() as { token_hash: string };
    expect(row.token_hash).toBe(await sha256Hex(token));
    // The raw token must not appear anywhere in the table.
    const dump = JSON.stringify(db.prepare("SELECT * FROM admin_sessions").all());
    expect(dump).not.toContain(token);
  });

  it("the session cookie unlocks the panel and /admin/api/auth/me", async () => {
    const { db, env } = await makeEnv();
    const token = await login(db, env);
    const page = await handleAdminRequest(authed("/admin", token), env);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("管理面板");
    const me = await handleAdminRequest(authed("/admin/api/auth/me", token), env);
    expect(me.status).toBe(200);
    const body = await me.json() as { user_id: string; username: string; role: string; via: string };
    expect(body.user_id).toBe("u_admin");
    expect(body.username).toBe("admin");
    expect(body.role).toBe("super_admin");
    expect(body.via).toBe("session");
  });

  it("JSON login returns the user and sets the same cookie semantics", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(jsonLogin(TOKEN), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { user_id: string; role: string; expires_at: string };
    expect(body.user_id).toBe("u_admin");
    expect(body.role).toBe("super_admin");
    expect(body.expires_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const token = extractToken(res);
    const me = await handleAdminRequest(authed("/admin/api/auth/me", token), env);
    expect(me.status).toBe(200);
  });

  it("wrong credentials are rejected without minting a session", async () => {
    const { db, env } = await makeEnv();
    const res = await handleAdminRequest(formLogin("nope"), env);
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const rows = db.prepare("SELECT COUNT(*) AS n FROM admin_sessions").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("a session cookie is rejected as a login credential (only the master token logs in)", async () => {
    const { db, env } = await makeEnv();
    const token = await login(db, env);
    // Presenting the session token at the login form must NOT authenticate:
    // otherwise a leaked session cookie would be replayable as a master token.
    const res = await handleAdminRequest(formLogin(token), env);
    expect(res.status).toBe(401);
  });
});

/* ── Session validation ────────────────────────────────────────────────── */

describe("session validation", () => {
  it("rejects an unknown session token", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(authed("/admin/api/auth/me", "0".repeat(64)), env);
    expect(res.status).toBe(401);
  });

  it("rejects a malformed cookie", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(
      new Request("https://worker.example/admin", { headers: { Cookie: "crm_session=%00<script>garbage" } }),
      env,
    );
    expect(res.status).toBe(200); // unauthenticated page shows the login form…
    const body = await res.text();
    expect(body).not.toContain("管理面板\">"); // …not the panel
  });

  it("rejects an expired session", async () => {
    const { db, env } = await makeEnv();
    const token = await login(db, env);
    db.prepare("UPDATE admin_sessions SET expires_at = '2000-01-01 00:00:00'").run();
    const res = await handleAdminRequest(authed("/admin/api/auth/me", token), env);
    expect(res.status).toBe(401);
  });

  it("rejects a revoked session immediately", async () => {
    const { db, env } = await makeEnv();
    const token = await login(db, env);
    db.prepare("UPDATE admin_sessions SET revoked_at = '2026-01-01 00:00:00'").run();
    const res = await handleAdminRequest(authed("/admin/api/auth/me", token), env);
    expect(res.status).toBe(401);
  });

  it("rejects a session whose user has been disabled", async () => {
    const { db, env } = await makeEnv();
    const token = await login(db, env);
    db.prepare("UPDATE admin_users SET enabled = 0").run();
    const res = await handleAdminRequest(authed("/admin/api/auth/me", token), env);
    expect(res.status).toBe(401);
  });

  it("fails closed when the sessions table is missing (migration pending)", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE admin_login_attempts (
        scope TEXT NOT NULL, ident TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
        window_start TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, locked_until TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (scope, ident)
      );
    `);
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    const res = await handleAdminRequest(
      new Request("https://worker.example/admin/api/auth/me", {
        headers: { Cookie: sessionCookie("f".repeat(64)) },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("binds a session to exactly one user (no cross-user confusion)", async () => {
    const { db, env } = await makeEnv();
    const token = await login(db, env);
    db.prepare("INSERT INTO admin_users (id, username, role) VALUES ('u_other', 'other', 'readonly')").run();
    const me = await handleAdminRequest(authed("/admin/api/auth/me", token), env);
    const body = await me.json() as { user_id: string; username: string };
    expect(body.user_id).toBe("u_admin");
    expect(body.username).toBe("admin");
  });
});

/* ── Logout / rotation / revocation ────────────────────────────────────── */

describe("logout and rotation", () => {
  it("POST /admin/logout revokes the session server-side; the old cookie dies instantly", async () => {
    const { db, env } = await makeEnv();
    const token = await login(db, env);
    const res = await handleAdminRequest(
      new Request("https://worker.example/admin/logout", { method: "POST", headers: { Cookie: sessionCookie(token) } }),
      env,
    );
    expect(res.status).toBe(303);
    expect((res.headers.get("Set-Cookie") ?? "")).toContain("Max-Age=0");
    const row = db.prepare("SELECT revoked_at FROM admin_sessions").get() as { revoked_at: string };
    expect(row.revoked_at).not.toBeNull();
    // The acceptance criterion: an attacker holding the pre-logout session
    // value gets nothing after logout.
    const after = await handleAdminRequest(authed("/admin/api/auth/me", token), env);
    expect(after.status).toBe(401);
  });

  it("POST /admin/api/auth/logout revokes and clears the cookie", async () => {
    const { db, env } = await makeEnv();
    const token = await login(db, env);
    const res = await handleAdminRequest(authed("/admin/api/auth/logout", token, { method: "POST" }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; revoked: number };
    expect(body.ok).toBe(true);
    expect(body.revoked).toBe(1);
    const after = await handleAdminRequest(authed("/admin/api/auth/me", token), env);
    expect(after.status).toBe(401);
  });

  it("re-login rotates the token and revokes the presented session", async () => {
    const { db, env } = await makeEnv();
    const first = await login(db, env);
    // The browser re-logs-in while still holding its old session cookie.
    const res = await handleAdminRequest(formLogin(TOKEN, "1.2.3.4", sessionCookie(first)), env);
    expect(res.status).toBe(303);
    const second = extractToken(res);
    expect(second).not.toBe(first);
    const oldRes = await handleAdminRequest(authed("/admin/api/auth/me", first), env);
    expect(oldRes.status).toBe(401);
    const newRes = await handleAdminRequest(authed("/admin/api/auth/me", second), env);
    expect(newRes.status).toBe(200);
  });

  it("login ignores a client-supplied session id (cookie fixation)", async () => {
    const { db, env } = await makeEnv();
    // Attacker sets a cookie value first; the server must mint its own fresh
    // token rather than adopting anything the client sent.
    const res = await handleAdminRequest(formLogin(TOKEN, "1.2.3.4", sessionCookie("attacker-fixed-value")), env);
    expect(res.status).toBe(303);
    const token = extractToken(res);
    expect(token).not.toBe("attacker-fixed-value");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("POST /admin/api/auth/revoke kills every session of the user", async () => {
    const { db, env } = await makeEnv();
    const a = await login(db, env);
    const b = await login(db, env); // second browser/tab
    const res = await handleAdminRequest(authed("/admin/api/auth/revoke", a, { method: "POST" }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { revoked: number; remaining: number };
    expect(body.revoked).toBe(2);
    expect(body.remaining).toBe(0);
    expect((await handleAdminRequest(authed("/admin/api/auth/me", a), env)).status).toBe(401);
    expect((await handleAdminRequest(authed("/admin/api/auth/me", b), env)).status).toBe(401);
  });

  it("revoke can target a single session id owned by the user", async () => {
    const { db, env } = await makeEnv();
    const a = await login(db, env);
    await login(db, env);
    const rows = db.prepare("SELECT id, token_hash FROM admin_sessions ORDER BY created_at, id").all() as Array<{ id: string; token_hash: string }>;
    const aHash = await sha256Hex(a);
    const victim = rows.find((r) => r.token_hash === aHash)!;
    const res = await handleAdminRequest(
      authed("/admin/api/auth/revoke", a, { method: "POST", body: JSON.stringify({ session_id: victim.id }) }),
      env,
    );
    const body = await res.json() as { revoked: number; remaining: number };
    expect(body.revoked).toBe(1);
    expect(body.remaining).toBe(1);
    expect((await handleAdminRequest(authed("/admin/api/auth/me", a), env)).status).toBe(401);
  });
});

/* ── Bearer bootstrap path ─────────────────────────────────────────────── */

describe("Authorization: Bearer bootstrap credential", () => {
  it("the master token still works as an explicit Bearer header", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(
      new Request("https://worker.example/admin/api/auth/me", {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { role: string; via: string };
    expect(body.role).toBe("super_admin");
    expect(body.via).toBe("bootstrap");
  });

  it("a wrong Bearer token is rejected even when a session cookie exists", async () => {
    const { db, env } = await makeEnv();
    const token = await login(db, env);
    const res = await handleAdminRequest(
      new Request("https://worker.example/admin/api/auth/me", {
        headers: { Authorization: "Bearer wrong-value", Cookie: sessionCookie(token) },
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("a session cookie never authenticates when no Authorization header exists and the token is wrong", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(authed("/admin/api/auth/me", "deadbeef".repeat(8)), env);
    expect(res.status).toBe(401);
  });
});
