import { describe, it, expect } from "vitest";
import { makeDb, makeEnv, call, bearer, mintSession } from "./_helpers";

/* Security V2 Stage 22 (spec §23) — AUDIT LOG acceptance.
 *
 * Stage 9's trail, end-to-end: every state-changing admin action lands as
 * a row correlated with the request id (Stage 20), reads land nothing,
 * denials are themselves audited, an audit-store failure never blocks the
 * business action (fail-open by design), and credential material never
 * enters the trail. */

describe("audit log acceptance", () => {
  it("PATCH customer writes an UPDATE_CUSTOMER row correlated with the X-Request-ID header", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    db.prepare(
      "INSERT INTO customers (company_id, domain, status) VALUES ('c1', 'acme.com', 'completed')",
    ).run();
    const res = await call(env, "/admin/api/customers/1", {
      method: "PATCH",
      body: JSON.stringify({ status: "pending" }),
      headers: bearer(),
    });
    expect(res.status).toBe(200);
    const row = db.prepare(
      "SELECT action, resource_type, resource_id, request_id FROM audit_logs ORDER BY created_at DESC LIMIT 1",
    ).get() as { action: string; resource_type: string; resource_id: string; request_id: string | null };
    expect(row.action).toBe("UPDATE_CUSTOMER");
    expect(row.resource_type).toBe("customer");
    expect(row.resource_id).toBe("1");
    expect(row.request_id).toBe(res.headers.get("X-Request-ID"));
  });

  it("GET requests write no audit rows", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    db.prepare(
      "INSERT INTO customers (company_id, domain, status) VALUES ('c1', 'acme.com', 'completed')",
    ).run();
    for (const path of ["/admin/api/customers", "/admin/api/customers/1", "/admin/api/keys", "/admin/api/gmail/accounts"]) {
      const res = await call(env, path, { headers: bearer() });
      expect(res.status, path).toBe(200);
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get() as { n: number }).n).toBe(0);
  });

  it("storing a provider key is audited with the hint, never the key", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const res = await call(env, "/admin/api/keys", {
      method: "POST",
      body: JSON.stringify({ provider: "gemini", api_key: "sk-audit-trail-secret" }),
      headers: bearer(),
    });
    expect(res.status).toBe(200);
    const row = db.prepare(
      "SELECT action, metadata_json FROM audit_logs ORDER BY created_at DESC LIMIT 1",
    ).get() as { action: string; metadata_json: string | null };
    expect(row.action).toBe("CREATE_API_KEY");
    expect(row.metadata_json ?? "").not.toContain("sk-audit-trail-secret");
  });

  it("a deletion is audited too (DELETE_API_KEY)", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const create = await call(env, "/admin/api/keys", {
      method: "POST",
      body: JSON.stringify({ provider: "gemini", api_key: "sk-to-be-deleted" }),
      headers: bearer(),
    });
    expect(create.status).toBe(200);
    const res = await call(env, "/admin/api/keys/1", { method: "DELETE", headers: bearer() });
    expect([200, 400, 404]).toContain(res.status);
    const row = db.prepare(
      "SELECT action FROM audit_logs ORDER BY created_at DESC LIMIT 1",
    ).get() as { action: string };
    expect(row.action).toBe("DELETE_API_KEY");
  });

  it("an audit-store failure never blocks the business action (fail-open)", async () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO customers (company_id, domain, status) VALUES ('c1', 'acme.com', 'completed')",
    ).run();
    // Everything works except writes into audit_logs.
    const env = makeEnv(db, { explodeOn: "INSERT INTO audit_logs" });
    const res = await call(env, "/admin/api/customers/1", {
      method: "PATCH",
      body: JSON.stringify({ status: "pending" }),
      headers: bearer(),
    });
    expect(res.status).toBe(200);
    // And the business effect happened.
    const row = db.prepare("SELECT status FROM customers WHERE id = 1").get() as { status: string };
    expect(row.status).toBe("pending");
  });

  it("the actor is recorded: a session-cookie actor is named in the row", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    db.prepare(
      "INSERT INTO customers (company_id, domain, status) VALUES ('c1', 'acme.com', 'completed')",
    ).run();
    const token = await mintSession(db, "super_admin");
    const res = await call(env, "/admin/api/customers/1", {
      method: "PATCH",
      body: JSON.stringify({ status: "pending" }),
      headers: { Cookie: `crm_session=${token}` },
    });
    expect(res.status).toBe(200);
    const row = db.prepare(
      "SELECT actor_user_id, actor_role FROM audit_logs ORDER BY created_at DESC LIMIT 1",
    ).get() as { actor_user_id: string | null; actor_role: string | null };
    expect(row.actor_user_id).toBe("u_super_admin");
    expect(row.actor_role).toBe("super_admin");
  });
});
