import { describe, it, expect } from "vitest";
import { makeDb, makeEnv, call, bearer, BASE } from "./_helpers";
import { handleAdminRequest } from "../../src/admin";

/* Security V2 Stage 22 (spec §23) — CSRF / origin-guard acceptance.
 *
 * Defense-in-depth on top of SameSite=Strict cookies (Stage 6): every
 * state-changing request with a foreign Origin dies before routing, auth,
 * or any side effect. The missing-Origin policy is deliberate (non-browser
 * clients carry explicit credentials). */

const jsonInit = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});

describe("origin guard acceptance", () => {
  it("a foreign-Origin POST is 403-rejected before auth (even unauthenticated)", async () => {
    const env = makeEnv(makeDb());
    const res = await call(env, "/admin/api/customers", {
      ...jsonInit({ domain: "evil.example" }),
      headers: { Origin: "https://evil.example" },
    });
    // Guard runs first: 403 for the origin, not 401 for missing auth.
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ detail: expect.stringContaining("Origin") });
  });

  it("a foreign-Origin POST with valid credentials is still rejected, and nothing happens", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const res = await call(env, "/admin/api/customers", {
      ...jsonInit({ domain: "https://acme.com/" }),
      headers: { ...bearer(), Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    // No side effect: no customer row, no audit row.
    expect((db.prepare("SELECT COUNT(*) AS n FROM customers").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get() as { n: number }).n).toBe(0);
  });

  it("same-Origin POST passes the guard (proceeds to auth/handler)", async () => {
    const env = makeEnv(makeDb());
    const res = await call(env, "/admin/api/customers", {
      ...jsonInit({ domain: "https://acme.com/" }),
      headers: { ...bearer(), Origin: BASE },
    });
    expect(res.status).not.toBe(403);
  });

  it("missing Origin is allowed — non-browser clients carry explicit credentials", async () => {
    const env = makeEnv(makeDb());
    const res = await call(env, "/admin/api/customers", {
      ...jsonInit({ domain: "https://acme.com/" }),
      headers: bearer(),
    });
    expect(res.status).not.toBe(403);
  });

  it("GET with a foreign Origin passes (safe method, no CSRF surface)", async () => {
    const env = makeEnv(makeDb());
    const res = await call(env, "/admin/api/customers", { headers: { Origin: "https://evil.example" } });
    expect(res.status).not.toBe(403);
  });

  it("the literal Origin 'null' is allowed like a missing Origin (opaque-origin browser clients)", async () => {
    const env = makeEnv(makeDb());
    const res = await call(env, "/admin/api/customers", {
      ...jsonInit({}),
      headers: { Origin: "null" },
    });
    // 2026-10-13 amendment: opaque-origin browser clients are let past the
    // gate (SameSite=Strict remains the primary CSRF layer); the request
    // then fails auth normally (401) without credentials.
    expect(res.status).not.toBe(403);
  });

  it("an unparseable Origin is refused, not tolerated", async () => {
    const env = makeEnv(makeDb());
    const res = await call(env, "/admin/api/customers", {
      ...jsonInit({}),
      headers: { Origin: "not a url" },
    });
    expect(res.status).toBe(403);
  });

  it("the login form itself is origin-guarded", async () => {
    const env = makeEnv(makeDb());
    const res = await handleAdminRequest(
      new Request(`${BASE}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example" },
        body: `token=x`,
      }),
      env,
    ) as Response;
    expect(res.status).toBe(403);
  });
});
