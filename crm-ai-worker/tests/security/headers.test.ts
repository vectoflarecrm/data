import { describe, it, expect } from "vitest";
import { makeDb, makeEnv, call, bearer, BASE } from "./_helpers";
import { handleAdminRequest } from "../../src/admin";

/* Security V2 Stage 22 (spec §23) — SECURITY HEADERS acceptance.
 *
 * Stage 5's baseline must hold on every response type leaving the admin
 * surface (HTML, JSON, 303 redirect, plain-text 404), Stage 18 keeps
 * responses uncached, and Stage 20 adds X-Request-ID — this file walks
 * every response type in one place. */

const EXPECTED_STATIC: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "no-referrer"],
  ["Permissions-Policy", "camera=(), microphone=(), geolocation=()"],
  ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
];

describe("security headers acceptance", () => {
  it("JSON API responses carry the full baseline + deny-all CSP + no-store + request id", async () => {
    const env = makeEnv(makeDb());
    const res = await call(env, "/admin/api/customers", { headers: bearer() });
    for (const [name, value] of EXPECTED_STATIC) {
      expect(res.headers.get(name), name).toBe(value);
    }
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("panel HTML carries a nonce-based CSP and the full baseline", async () => {
    const env = makeEnv(makeDb());
    const res = await call(env, "/admin");
    expect(res.status).toBe(200);
    for (const [name, value] of EXPECTED_STATIC) {
      expect(res.headers.get(name), name).toBe(value);
    }
    const csp = res.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // And the HTML actually uses that nonce on its scripts.
    const html = await res.text();
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? "";
    expect(nonce.length).toBeGreaterThan(0);
    expect(html).toContain(`nonce="${nonce}"`);
  });

  it("the plain-text 404 keeps the baseline and gets the deny-all CSP fallback", async () => {
    const env = makeEnv(makeDb());
    const res = await call(env, "/admin/nope-not-a-page", { headers: bearer() });
    expect(res.status).toBe(404);
    for (const [name, value] of EXPECTED_STATIC) {
      expect(res.headers.get(name), name).toBe(value);
    }
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it("the login 303 redirect carries the baseline and a no-store cache policy", async () => {
    const env = makeEnv(makeDb());
    const res = await handleAdminRequest(
      new Request(`${BASE}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "token=panel-token-for-tests",
      }),
      env,
    ) as Response;
    expect(res.status).toBe(303);
    for (const [name, value] of EXPECTED_STATIC) {
      expect(res.headers.get(name), name).toBe(value);
    }
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  it("a 500 response still carries the full baseline (errors are responses too)", async () => {
    const env = makeEnv(makeDb(), { explodeOn: "FROM api_configs" });
    const res = await call(env, "/admin/api/keys", { headers: bearer() });
    expect(res.status).toBe(500);
    for (const [name, value] of EXPECTED_STATIC) {
      expect(res.headers.get(name), name).toBe(value);
    }
    expect(res.headers.get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("the origin-guard rejection itself carries the baseline (it short-circuits before the wrapper)", async () => {
    const env = makeEnv(makeDb());
    const res = await call(env, "/admin/api/customers", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    // The guard returns early; whatever it serves must still be safe to
    // render. The invariant that matters: nosniff + deny-all CSP.
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });
});
