import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index";
import { pruneExpiredSessions, SESSION_PRUNE_GRACE_DAYS } from "../src/auth/session-hygiene";
import { makeDb, makeEnv, call, mintSession, FakeD1, TOKEN } from "./security/_helpers";

/* Post-V2 small-improvements stage — session inventory, admin-wide
 * revocation and expired-session hygiene (deferred item: "session
 * inventory/admin-wide revocation UI").
 *
 * The incident-response story: a super_admin can SEE every active session
 * (/admin/sessions), kill any single one, or flip the table with
 * revoke-all — which deliberately spares the caller's own session so the
 * responder is never locked out mid-response. Expired rows are vacuumed by
 * the 5-min cron after a 7-day inspection grace.
 */

const NOW = new Date("2026-10-05T12:00:00Z");
const DAY = 86_400_000;

describe("pruneExpiredSessions (hygiene unit)", () => {
  it("deletes only rows past the 7-day grace; recent and live rows survive", async () => {
    const db = makeDb();
    db.prepare("INSERT OR IGNORE INTO admin_users (id, username, role) VALUES ('u1', 'user_1', 'super_admin')").run();
    const insert = (id: string, expiresAt: string) =>
      db.prepare(
        `INSERT INTO admin_sessions (id, user_id, token_hash, role, created_at, expires_at) VALUES (?, 'u1', ?, 'super_admin', '2026-01-01 00:00:00', ?)`,
      ).run(id, `hash_${id}`, expiresAt);
    insert("ancient", "2026-09-01 00:00:00"); // 34 days past → delete
    insert("recent", "2026-10-03 12:00:00"); // 2 days past → inside grace, keep
    insert("live", "2026-11-01 00:00:00"); // future → keep
    expect(SESSION_PRUNE_GRACE_DAYS).toBe(7);
    await expect(pruneExpiredSessions({ DB: new FakeD1(db) }, NOW)).resolves.toBe(1);
    const ids = db.prepare("SELECT id FROM admin_sessions ORDER BY id").all().map((r: any) => r.id);
    expect(ids).toEqual(["live", "recent"]);
  });

  it("missing table is a silent 0; other D1 errors propagate", async () => {
    const bare = new DatabaseSync(":memory:");
    await expect(pruneExpiredSessions({ DB: new FakeD1(bare as any) }, NOW)).resolves.toBe(0);
    await expect(pruneExpiredSessions({ DB: new FakeD1(makeDb(), "DELETE FROM admin_sessions") }, NOW)).rejects.toThrow("D1 exploded");
  });
});

describe("scheduled cron vacuums expired sessions (fail-open)", () => {
  const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
  const controller = { cron: "*/5 * * * *", scheduledTime: 0 } as unknown as ScheduledController;

  it("old expired rows vanish on the tick; live sessions stay", async () => {
    const db = makeDb();
    db.prepare("INSERT OR IGNORE INTO admin_users (id, username, role) VALUES ('u1', 'user_1', 'super_admin')").run();
    db.prepare(
      `INSERT INTO admin_sessions (id, user_id, token_hash, role, created_at, expires_at) VALUES ('dead', 'u1', 'h_dead', 'super_admin', '2026-01-01 00:00:00', '2026-09-01 00:00:00')`,
    ).run();
    const token = await mintSession(db, "readonly"); // expires 2099 — must survive
    await worker.scheduled!(controller, { DB: new FakeD1(db), GEMINI_API_KEY: "x" } as any, ctx);
    expect(db.prepare("SELECT 1 FROM admin_sessions WHERE id = 'dead'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM admin_sessions WHERE token_hash IS NOT NULL AND role = 'readonly'").get()).toBeTruthy();
    expect(token.length).toBeGreaterThan(0);
  });

  it("a broken vacuum never breaks the research tick", async () => {
    const db = makeDb();
    await expect(
      worker.scheduled!(controller, { DB: new FakeD1(db, "DELETE FROM admin_sessions"), GEMINI_API_KEY: "x" } as any, ctx),
    ).resolves.toBeUndefined();
  });
});

describe("GET /admin/api/auth/sessions (super_admin inventory)", () => {
  it("lists every active session across users, marking the caller's own", async () => {
    const db = makeDb();
    const saToken = await mintSession(db, "super_admin");
    await mintSession(db, "readonly");
    await mintSession(db, "sender");
    const res = await call(makeEnv(db), "/admin/api/auth/sessions", { headers: { Cookie: `crm_session=${saToken}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.sessions).toHaveLength(3);
    const current = body.sessions.filter((s: any) => s.is_current);
    expect(current).toHaveLength(1);
    expect(current[0].user_id).toBe("u_super_admin");
    expect(body.sessions.map((s: any) => s.role).sort()).toEqual(["readonly", "sender", "super_admin"]);
    // No token material ever leaves the table.
    expect(JSON.stringify(body)).not.toContain("token_hash");
  });

  it("revoked and expired sessions are invisible", async () => {
    const db = makeDb();
    const saToken = await mintSession(db, "super_admin");
    const roToken = await mintSession(db, "readonly");
    db.prepare("UPDATE admin_sessions SET revoked_at = '2026-10-05 00:00:00' WHERE role = 'readonly'").run();
    db.prepare("UPDATE admin_sessions SET expires_at = '2020-01-01 00:00:00' WHERE role = 'sender'").run();
    await mintSession(db, "sender"); // a live replacement
    const body = await (await call(makeEnv(db), "/admin/api/auth/sessions", { headers: { Cookie: `crm_session=${saToken}` } })).json() as any;
    expect(body.sessions).toHaveLength(2); // super_admin + live sender; revoked ro + expired sender invisible
    expect(roToken.length).toBeGreaterThan(0);
  });

  it("non-super_admin gets 403 with an ACCESS_DENIED audit row", async () => {
    const db = makeDb();
    const roToken = await mintSession(db, "readonly");
    const res = await call(makeEnv(db), "/admin/api/auth/sessions", { headers: { Cookie: `crm_session=${roToken}` } });
    expect(res.status).toBe(403);
    const audit = db.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'ACCESS_DENIED'").get() as any;
    expect(JSON.parse(audit.metadata_json).requires).toBe("super_admin");
  });

  it("unauthenticated callers get 401", async () => {
    expect((await call(makeEnv(makeDb()), "/admin/api/auth/sessions")).status).toBe(401);
  });
});

describe("POST /admin/api/auth/sessions/revoke (single session, any user)", () => {
  it("super_admin revokes another user's session — it stops authenticating", async () => {
    const db = makeDb();
    const saToken = await mintSession(db, "super_admin");
    const senderToken = await mintSession(db, "sender");
    const sessionId = (db.prepare("SELECT id FROM admin_sessions WHERE role = 'sender'").get() as any).id;

    // The sender's session works before…
    expect((await call(makeEnv(db), "/admin/api/auth/me", { headers: { Cookie: `crm_session=${senderToken}` } })).status).toBe(200);

    const res = await call(makeEnv(db), "/admin/api/auth/sessions/revoke", {
      method: "POST",
      headers: { Cookie: `crm_session=${saToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).revoked).toBe(1);

    // …and is dead after.
    expect((await call(makeEnv(db), "/admin/api/auth/me", { headers: { Cookie: `crm_session=${senderToken}` } })).status).toBe(401);
    const audit = db.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'REVOKE_SESSION'").get() as any;
    expect(JSON.parse(audit.metadata_json).target_user_id).toBe("u_sender");
  });

  it("400 without session_id, 404 on unknown ids, idempotent on already-revoked", async () => {
    const db = makeDb();
    const saToken = await mintSession(db, "super_admin");
    const headers = { Cookie: `crm_session=${saToken}`, "Content-Type": "application/json" };
    expect((await call(makeEnv(db), "/admin/api/auth/sessions/revoke", { method: "POST", headers, body: "{}" })).status).toBe(400);
    expect((await call(makeEnv(db), "/admin/api/auth/sessions/revoke", { method: "POST", headers, body: JSON.stringify({ session_id: "nope" }) })).status).toBe(404);
    const roToken = await mintSession(db, "readonly");
    const sid = (db.prepare("SELECT id FROM admin_sessions WHERE role = 'readonly'").get() as any).id;
    const first = await (await call(makeEnv(db), "/admin/api/auth/sessions/revoke", { method: "POST", headers, body: JSON.stringify({ session_id: sid }) })).json() as any;
    const second = await (await call(makeEnv(db), "/admin/api/auth/sessions/revoke", { method: "POST", headers, body: JSON.stringify({ session_id: sid }) })).json() as any;
    expect(first.revoked).toBe(1);
    expect(second.revoked).toBe(0); // already revoked — no error, no double count
    expect(roToken.length).toBeGreaterThan(0);
  });

  it("readonly may not revoke anything (403 + audit)", async () => {
    const db = makeDb();
    const roToken = await mintSession(db, "readonly");
    await mintSession(db, "sender");
    const sid = (db.prepare("SELECT id FROM admin_sessions WHERE role = 'sender'").get() as any).id;
    const res = await call(makeEnv(db), "/admin/api/auth/sessions/revoke", {
      method: "POST",
      headers: { Cookie: `crm_session=${roToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sid }),
    });
    expect(res.status).toBe(403);
    expect(db.prepare("SELECT revoked_at FROM admin_sessions WHERE role = 'sender'").get()).toEqual({ revoked_at: null });
  });
});

describe("POST /admin/api/auth/revoke-all (admin-wide, keeps the responder)", () => {
  it("session caller: everyone else dies, the caller's own session survives", async () => {
    const db = makeDb();
    const saToken = await mintSession(db, "super_admin");
    await mintSession(db, "super_admin"); // second super_admin session
    const roToken = await mintSession(db, "readonly");
    const res = await call(makeEnv(db), "/admin/api/auth/revoke-all", { method: "POST", headers: { Cookie: `crm_session=${saToken}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.revoked).toBe(2); // other super_admin + readonly
    expect(body.remaining).toBe(1);
    // The responder is still logged in…
    expect((await call(makeEnv(db), "/admin/api/auth/me", { headers: { Cookie: `crm_session=${saToken}` } })).status).toBe(200);
    // …the readonly session is dead.
    expect((await call(makeEnv(db), "/admin/api/auth/me", { headers: { Cookie: `crm_session=${roToken}` } })).status).toBe(401);
    const audit = db.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'REVOKE_ALL_SESSIONS'").get() as any;
    expect(JSON.parse(audit.metadata_json)).toEqual({ revoked: 2, kept_current: true });
  });

  it("Bearer bootstrap caller (no session row): everything goes", async () => {
    const db = makeDb();
    await mintSession(db, "super_admin");
    await mintSession(db, "sender");
    const res = await call(makeEnv(db), "/admin/api/auth/revoke-all", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = await res.json() as any;
    expect(body.revoked).toBe(2);
    expect(body.remaining).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM admin_sessions WHERE revoked_at IS NULL").get() as any).n).toBe(0);
  });

  it("non-super_admin is denied", async () => {
    const db = makeDb();
    const roToken = await mintSession(db, "readonly");
    await mintSession(db, "sender");
    expect((await call(makeEnv(db), "/admin/api/auth/revoke-all", { method: "POST", headers: { Cookie: `crm_session=${roToken}` } })).status).toBe(403);
    expect((db.prepare("SELECT COUNT(*) AS n FROM admin_sessions WHERE revoked_at IS NULL").get() as any).n).toBe(2);
  });
});

describe("GET /admin/sessions (panel page)", () => {
  it("unauthenticated → login page; readonly → 403 JSON; super_admin → viewer", async () => {
    const db = makeDb();
    const anon = await call(makeEnv(db), "/admin/sessions");
    expect(anon.status).toBe(200);
    const html = await anon.text();
    expect(html).toContain("管理登录");
    expect(html).not.toContain("会话管理");

    const roToken = await mintSession(db, "readonly");
    const denied = await call(makeEnv(db), "/admin/sessions", { headers: { Cookie: `crm_session=${roToken}` } });
    expect(denied.status).toBe(403);

    const saToken = await mintSession(db, "super_admin");
    const ok = await call(makeEnv(db), "/admin/sessions", { headers: { Cookie: `crm_session=${saToken}` } });
    expect(ok.status).toBe(200);
    const pageHtml = await ok.text();
    expect(pageHtml).toContain("会话管理");
    expect(pageHtml).toContain("/admin/api/auth/sessions");
  });

  it("non-GET is rejected with 405", async () => {
    const db = makeDb();
    const saToken = await mintSession(db, "super_admin");
    expect((await call(makeEnv(db), "/admin/sessions", { method: "POST", headers: { Cookie: `crm_session=${saToken}` } })).status).toBe(405);
  });
});
