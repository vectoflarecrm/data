import { describe, it, expect } from "vitest";
import { makeDb, makeEnv, call, bearer, mintSession, TOKEN, BASE } from "./_helpers";
import { handleAdminRequest } from "../../src/admin";

/* Security V2 Stage 22 (spec §23) — AUTH acceptance.
 *
 * End-to-end through handleAdminRequest: an unauthenticated caller gets
 * nothing, a wrong credential gets nothing, a valid one gets through, and
 * brute-force form logins throttle themselves. */

describe("auth acceptance", () => {
  it("unauthenticated panel GET serves the login page only — no data leak", async () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO customers (company_id, display_id, domain, company_name, status) VALUES ('c1', 'C-0001', 'acme.com', 'Acme Secret Co', 'completed')",
    ).run();
    const env = makeEnv(db);
    const res = await call(env, "/admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).not.toContain("Acme Secret Co");
    expect(html).not.toContain("acme.com");
  });

  it("unauthenticated API GET is a JSON 401, never HTML", async () => {
    const env = makeEnv(makeDb());
    const res = await call(env, "/admin/api/customers");
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.detail).toBe("string");
  });

  it("a garbage Bearer token is rejected; the real one passes", async () => {
    const env = makeEnv(makeDb());
    const bad = await call(env, "/admin/api/customers", { headers: bearer("wrong-token-entirely") });
    expect(bad.status).toBe(401);
    const good = await call(env, "/admin/api/customers", { headers: bearer() });
    expect(good.status).toBe(200);
  });

  it("a garbage session cookie is rejected like no cookie at all", async () => {
    const env = makeEnv(makeDb());
    const res = await call(env, "/admin/api/customers", { headers: { Cookie: "crm_session=not-a-real-token" } });
    expect(res.status).toBe(401);
  });

  it("a valid minted session cookie authenticates (RBAC roles live in D1)", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const token = await mintSession(db, "readonly");
    const res = await call(env, "/admin/api/customers", { headers: { Cookie: `crm_session=${token}` } });
    expect(res.status).toBe(200);
  });

  it("repeated bad form logins throttle the caller (429 + Retry-After)", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const attempt = () =>
      handleAdminRequest(
        new Request(`${BASE}/admin/login`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.9" },
          body: "token=wrong",
        }),
        env,
      ) as Promise<Response>;
    for (let i = 0; i < 5; i++) {
      const res = await attempt();
      expect(res.status).toBe(401);
    }
    const throttled = await attempt();
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("a failed login is audited without the attempted token value", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const res = await handleAdminRequest(
      new Request(`${BASE}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "token=super-secret-guess",
      }),
      env,
    ) as Response;
    expect(res.status).toBe(401);
    const row = db.prepare(
      "SELECT action, metadata_json FROM audit_logs ORDER BY created_at DESC LIMIT 1",
    ).get() as { action: string; metadata_json: string | null };
    expect(row.action).toBe("LOGIN_FAILED");
    expect(row.metadata_json ?? "").not.toContain("super-secret-guess");
  });

  it("the master token never appears in any response", async () => {
    const env = makeEnv(makeDb());
    const res = await call(env, "/admin/api/auth/me", { headers: bearer() });
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(TOKEN);
  });
});
