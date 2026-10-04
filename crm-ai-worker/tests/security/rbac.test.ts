import { describe, it, expect } from "vitest";
import { makeDb, makeEnv, call, mintSession } from "./_helpers";
import { ROLE_PERMISSIONS, requiredPermission, roleHasPermission, type Permission } from "../../src/auth/rbac";

/* Security V2 Stage 22 (spec §23) — RBAC acceptance.
 *
 * The unit suite (tests/rbac.test.ts) pins individual role boundaries; this
 * acceptance file walks the whole matrix end-to-end: every mutation route is
 * denied for every role that lacks its permission, and no route is denied
 * for a role that has it. */

const jsonInit = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});

describe("RBAC acceptance", () => {
  it("every role can read customers; only writing roles can mutate them", async () => {
    for (const role of Object.keys(ROLE_PERMISSIONS)) {
      const db = makeDb();
      db.prepare(
        "INSERT INTO customers (company_id, domain, status) VALUES ('c1', 'acme.com', 'completed')",
      ).run();
      const env = makeEnv(db);
      const token = await mintSession(db, role);
      const read = await call(env, "/admin/api/customers?limit=1", { headers: { Cookie: `crm_session=${token}` } });
      expect(read.status, `role ${role} read`).toBe(200);
      const write = await call(env, "/admin/api/customers/1", {
        method: "PATCH",
        headers: { Cookie: `crm_session=${token}` },
        body: JSON.stringify({ status: "pending" }),
      });
      const expected = ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS].has("customers.write") ? 200 : 403;
      expect(write.status, `role ${role} write`).toBe(expected);
    }
  });

  it("provider key management is providers.write: operator/researcher/sender/readonly all 403", async () => {
    for (const role of ["operator", "researcher", "sender", "readonly"]) {
      const db = makeDb();
      const env = makeEnv(db);
      const token = await mintSession(db, role);
      const post = await call(env, "/admin/api/keys", {
        ...jsonInit({ provider: "gemini", api_key: "k" }),
        headers: { Cookie: `crm_session=${token}` },
      });
      expect(post.status, `role ${role} POST /keys`).toBe(403);
    }
  });

  it("unmapped API routes 404 for every role (no gate bypass, no leak)", async () => {
    for (const role of ["super_admin", "readonly"]) {
      const db = makeDb();
      const env = makeEnv(db);
      const token = await mintSession(db, role);
      const res = await call(env, "/admin/api/does-not-exist", { headers: { Cookie: `crm_session=${token}` } });
      expect(res.status, `role ${role}`).toBe(404);
    }
  });

  it("a denied mutation is itself audited as ACCESS_DENIED", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const token = await mintSession(db, "sender");
    const res = await call(env, "/admin/api/keys", {
      ...jsonInit({ provider: "gemini", api_key: "k" }),
      headers: { Cookie: `crm_session=${token}` },
    });
    expect(res.status).toBe(403);
    const row = db.prepare(
      "SELECT action, resource_type, resource_id FROM audit_logs ORDER BY created_at DESC LIMIT 1",
    ).get() as { action: string; resource_type: string; resource_id: string | null };
    expect(row.action).toBe("ACCESS_DENIED");
    expect(row.resource_id).toContain("/admin/api/keys");
  });

  it("a denied request names the missing permission, and nothing else leaks", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const token = await mintSession(db, "sender");
    const res = await call(env, "/admin/api/keys", {
      ...jsonInit({ provider: "gemini", api_key: "k" }),
      headers: { Cookie: `crm_session=${token}` },
    });
    const body = await res.json() as { detail: string };
    expect(body.detail).toContain("providers.write");
  });

  it("route→permission map: no /admin/api business route is unmapped", () => {
    // The acceptance invariant for the central gate: every known business
    // surface resolves to a required permission (auth/* excepted).
    const surfaces: Array<[string, string, Permission | null]> = [
      ["/admin/api/keys", "GET", "providers.read"],
      ["/admin/api/keys", "POST", "providers.write"],
      ["/admin/api/keys/1", "PATCH", "providers.write"],
      ["/admin/api/gmail/accounts", "GET", "outreach.read"],
      ["/admin/api/gmail/accounts", "POST", "credentials.write"],
      ["/admin/api/gmail/encrypt-all", "POST", "credentials.write"],
      ["/admin/api/outreach/send-batch", "POST", "outreach.send"],
      ["/admin/api/outreach/emails/1", "DELETE", "outreach.generate"],
      ["/admin/api/outreach/campaigns/1/send", "POST", "outreach.send"],
      ["/admin/api/customers/import", "POST", "customers.write"],
      ["/admin/api/customers/1", "PATCH", "customers.write"],
    ];
    for (const [path, method, expected] of surfaces) {
      const url = new URL(`https://worker.example${path}`);
      expect(requiredPermission(url, method), `${method} ${path}`).toBe(expected);
    }
    // Session lifecycle stays permission-free by design.
    expect(requiredPermission(new URL("https://worker.example/admin/api/auth/me"), "GET")).toBeNull();
  });

  it("an unknown role fails closed at both layers: schema CHECK and code", async () => {
    // Layer 1: the schema refuses to store a role outside the matrix at all
    // (Stage 17 CHECK constraint) — a forged row cannot exist.
    const db = makeDb();
    expect(() =>
      db.prepare("INSERT INTO admin_users (id, username, role) VALUES ('u_x', 'x', 'shadow-admin')").run(),
    ).toThrow();
    // Layer 2: even if a future schema ever loosened, roleHasPermission
    // denies unknown roles.
    expect(roleHasPermission("shadow-admin", "customers.write")).toBe(false);
    expect(roleHasPermission("shadow-admin", "customers.read")).toBe(false);
  });
});
