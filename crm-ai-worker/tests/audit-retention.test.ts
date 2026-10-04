import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index";
import {
  DEFAULT_AUDIT_RETENTION_DAYS,
  pruneAuditLogs,
  resolveAuditRetentionDays,
  toSqlUtc,
} from "../src/audit/audit-retention";
import { makeDb, makeEnv, call, mintSession, FakeD1 } from "./security/_helpers";

/* Post-V2 small-improvements stage — audit retention + read-only audit view.
 *
 * Remaining Risks #5 closed the loop: audit_logs no longer grows unbounded
 * (cron prune) and the trail became inspectable from the panel
 * (GET /admin/api/audit-logs, audit.read) instead of only via wrangler d1.
 */

const NOW = new Date("2026-10-05T12:00:00Z");
const DAY = 86_400_000;

function insertAudit(
  db: any,
  id: string,
  createdAt: string,
  action = "LOGIN_FAILURE",
  metadataJson: string | null = null,
): void {
  db.prepare(
    `INSERT INTO audit_logs (id, actor_user_id, actor_role, action, resource_type, resource_id, request_id, metadata_json, created_at)
     VALUES (?, 'u1', 'super_admin', ?, 'customer', '42', 'req_1', ?, ?)`,
  ).run(id, action, metadataJson, createdAt);
}

describe("resolveAuditRetentionDays", () => {
  it("unset / empty falls back to the 180-day default", () => {
    expect(resolveAuditRetentionDays({})).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(resolveAuditRetentionDays({ AUDIT_RETENTION_DAYS: "" })).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(resolveAuditRetentionDays({ AUDIT_RETENTION_DAYS: "   " })).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
  });

  it('"0" disables pruning (explicit opt-out)', () => {
    expect(resolveAuditRetentionDays({ AUDIT_RETENTION_DAYS: "0" })).toBeNull();
  });

  it("positive integers are honored, with whitespace tolerated", () => {
    expect(resolveAuditRetentionDays({ AUDIT_RETENTION_DAYS: "90" })).toBe(90);
    expect(resolveAuditRetentionDays({ AUDIT_RETENTION_DAYS: "  60 " })).toBe(60);
  });

  it("garbage and negatives fail SAFE: default, never more aggressive", () => {
    expect(resolveAuditRetentionDays({ AUDIT_RETENTION_DAYS: "abc" })).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
    expect(resolveAuditRetentionDays({ AUDIT_RETENTION_DAYS: "-5" })).toBe(DEFAULT_AUDIT_RETENTION_DAYS);
  });
});

describe("pruneAuditLogs", () => {
  it("deletes rows strictly older than the horizon and reports the count", async () => {
    const db = makeDb();
    insertAudit(db, "old", toSqlUtc(new Date(NOW.getTime() - 40 * DAY)));
    insertAudit(db, "edge", toSqlUtc(new Date(NOW.getTime() - 30 * DAY))); // exactly at cutoff
    insertAudit(db, "fresh", toSqlUtc(new Date(NOW.getTime() - 29 * DAY)));
    const env = { DB: new FakeD1(db) };
    expect(await pruneAuditLogs(env, 30, NOW)).toBe(1);
    const ids = db.prepare("SELECT id FROM audit_logs ORDER BY id").all().map((r: any) => r.id);
    expect(ids).toEqual(["edge", "fresh"]); // boundary row survives: strict <
  });

  it("missing audit_logs table is a silent no-op (pre-migration stance)", async () => {
    const bare = new DatabaseSync(":memory:"); // schema never applied
    expect(await pruneAuditLogs({ DB: new FakeD1(bare as any) }, 30, NOW)).toBe(0);
  });

  it("other D1 failures propagate — the cron caller owns the fail-open policy", async () => {
    const env = { DB: new FakeD1(makeDb(), "DELETE FROM audit_logs") };
    await expect(pruneAuditLogs(env, 30, NOW)).rejects.toThrow("D1 exploded");
  });
});

describe("scheduled cron tick hosts the prune (fail-open)", () => {
  const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
  const controller = { cron: "*/5 * * * *", scheduledTime: 0 } as unknown as ScheduledController;

  function seedOldAndFresh(db: any): void {
    insertAudit(db, "old-row", toSqlUtc(new Date(Date.now() - 40 * DAY)), "LOGIN_FAILURE");
    insertAudit(db, "fresh-row", toSqlUtc(new Date()), "LOGIN_SUCCESS");
  }

  it("prunes before the claim early-return and writes its own AUDIT_PRUNE row", async () => {
    const db = makeDb();
    seedOldAndFresh(db); // no queued customers: claimCustomers returns []
    const env: any = { DB: new FakeD1(db), AUDIT_RETENTION_DAYS: "30", GEMINI_API_KEY: "x" };
    await worker.scheduled!(controller, env, ctx);
    const ids = db.prepare("SELECT id FROM audit_logs ORDER BY id").all().map((r: any) => r.id);
    expect(ids).toContain("fresh-row");
    expect(ids).not.toContain("old-row");
    const prune = db.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'AUDIT_PRUNE'").get() as any;
    expect(prune).toBeTruthy();
    expect(JSON.parse(prune.metadata_json)).toEqual({ pruned: 1, retention_days: 30 });
  });

  it('AUDIT_RETENTION_DAYS="0" keeps every row', async () => {
    const db = makeDb();
    seedOldAndFresh(db);
    const env: any = { DB: new FakeD1(db), AUDIT_RETENTION_DAYS: "0", GEMINI_API_KEY: "x" };
    await worker.scheduled!(controller, env, ctx);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get() as any).n).toBe(2);
    expect(db.prepare("SELECT 1 FROM audit_logs WHERE action = 'AUDIT_PRUNE'").get()).toBeUndefined();
  });

  it("a broken prune never breaks the research tick (fail-open)", async () => {
    const db = makeDb();
    seedOldAndFresh(db);
    const env: any = { DB: new FakeD1(db, "DELETE FROM audit_logs"), AUDIT_RETENTION_DAYS: "30", GEMINI_API_KEY: "x" };
    await expect(worker.scheduled!(controller, env, ctx)).resolves.toBeUndefined();
  });
});

describe("GET /admin/api/audit-logs (read-only view, audit.read)", () => {
  async function seedAndLogin(role: string): Promise<{ env: any; db: any; token: string }> {
    const db = makeDb();
    insertAudit(db, "a3", "2026-10-05 10:00:00", "LOGIN_SUCCESS", '{"ok":true}');
    insertAudit(db, "a2", "2026-10-05 09:00:00", "ACCESS_DENIED", "not-json-at-all");
    insertAudit(db, "a1", "2026-10-04 09:00:00", "LOGIN_SUCCESS", null);
    const token = await mintSession(db, role);
    return { env: makeEnv(db), db, token };
  }

  it("lists newest-first with parsed metadata and no fingerprint columns", async () => {
    const { env, token } = await seedAndLogin("super_admin");
    const res = await call(env, "/admin/api/audit-logs", { headers: { Cookie: `crm_session=${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.logs.map((l: any) => l.id)).toEqual(["a3", "a2", "a1"]);
    expect(body.logs[0].metadata).toEqual({ ok: true });
    expect(body.logs[1].metadata).toBeNull(); // unparseable metadata_json degrades to null
    expect(body.logs[2].metadata).toBeNull();
    expect(body.next_before).toBeNull(); // short page → end of trail
    expect(JSON.stringify(body)).not.toContain("ip_hash");
    expect(JSON.stringify(body)).not.toContain("user_agent_hash");
  });

  it("readonly role may read the trail; sender may not (no audit.read)", async () => {
    const ro = await seedAndLogin("readonly");
    expect((await call(ro.env, "/admin/api/audit-logs", { headers: { Cookie: `crm_session=${ro.token}` } })).status).toBe(200);
    const sender = await seedAndLogin("sender");
    const denied = await call(sender.env, "/admin/api/audit-logs", { headers: { Cookie: `crm_session=${sender.token}` } });
    expect(denied.status).toBe(403);
  });

  it("requires authentication", async () => {
    const env = makeEnv(makeDb());
    expect((await call(env, "/admin/api/audit-logs")).status).toBe(401);
  });

  it("clamps limit and pages via the before cursor", async () => {
    const { env, token } = await seedAndLogin("super_admin");
    const headers = { Cookie: `crm_session=${token}` };
    const page1 = await (await call(env, "/admin/api/audit-logs?limit=0", { headers })).json() as any;
    expect(page1.logs).toHaveLength(1); // limit=0 clamps up to 1
    const page2 = await (await call(env, "/admin/api/audit-logs?limit=2", { headers })).json() as any;
    expect(page2.logs.map((l: any) => l.id)).toEqual(["a3", "a2"]);
    expect(page2.next_before).toBe("2026-10-05 09:00:00");
    const page3 = await (await call(env, `/admin/api/audit-logs?limit=2&before=${encodeURIComponent(page2.next_before)}`, { headers })).json() as any;
    expect(page3.logs.map((l: any) => l.id)).toEqual(["a1"]);
    expect(page3.next_before).toBeNull();
  });

  it("filters by exact action and ignores malformed before values", async () => {
    const { env, token } = await seedAndLogin("super_admin");
    const headers = { Cookie: `crm_session=${token}` };
    const filtered = await (await call(env, "/admin/api/audit-logs?action=ACCESS_DENIED", { headers })).json() as any;
    expect(filtered.logs.map((l: any) => l.id)).toEqual(["a2"]);
    const weird = await (await call(env, "/admin/api/audit-logs?before=garbage", { headers })).json() as any;
    expect(weird.logs).toHaveLength(3); // malformed cursor ignored, no WHERE added
  });

  it("no mutation surface: POST 404s", async () => {
    const { env, token } = await seedAndLogin("super_admin");
    const res = await call(env, "/admin/api/audit-logs", { method: "POST", headers: { Cookie: `crm_session=${token}` }, body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/audit (panel page)", () => {
  it("unauthenticated visitors get the login page, not the trail (soft wall, like /admin/keys)", async () => {
    const res = await call(makeEnv(makeDb()), "/admin/audit");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("管理登录");
    expect(html).not.toContain("/admin/api/audit-logs");
  });

  it("authenticated operators get the read-only viewer", async () => {
    const db = makeDb();
    const token = await mintSession(db, "super_admin");
    const res = await call(makeEnv(db), "/admin/audit", { headers: { Cookie: `crm_session=${token}` } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("审计日志");
    expect(html).toContain("/admin/api/audit-logs");
  });

  it("non-GET is rejected with 405", async () => {
    const db = makeDb();
    const token = await mintSession(db, "super_admin");
    const res = await call(makeEnv(db), "/admin/audit", { method: "POST", headers: { Cookie: `crm_session=${token}` } });
    expect(res.status).toBe(405);
  });
});
