import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { FakeD1, makeDb } from "./security/_helpers";

/* Security V2 §32 — /health liveness probe.
 *
 * The production smoke procedure (docs/deployment-v2.md) starts with
 * GET /health: 200 { ok: true } only when the D1 binding answers, 503 when
 * it does not. No authentication — a health check must not depend on
 * credentials, and it must leak nothing beyond service identity.
 */

function makeWorkerEnv(db: any, explodeOn: string | null = null): any {
  return { DB: new FakeD1(db, explodeOn) };
}

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

describe("GET /health (spec §32 smoke endpoint)", () => {
  it("returns 200 ok when D1 answers", async () => {
    const res = await worker.fetch!(new Request("https://worker.example/health"), makeWorkerEnv(makeDb()), ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("crm-ai-worker");
  });

  it("returns 503 when the D1 binding is broken", async () => {
    const res = await worker.fetch!(
      new Request("https://worker.example/health"),
      makeWorkerEnv(makeDb(), "SELECT 1 AS ok"),
      ctx,
    );
    expect(res.status).toBe(503);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it("does not intercept other routes — /health/not-health and POST fall through", async () => {
    const db = makeDb();
    const env = makeWorkerEnv(db);
    const post = await worker.fetch!(new Request("https://worker.example/health", { method: "POST" }), env, ctx);
    expect(post.status).not.toBe(200); // POST is not a liveness probe; admin routing 404s it
    const other = await worker.fetch!(new Request("https://worker.example/healthz"), env, ctx);
    expect(other.status).not.toBe(200);
  });

  it("needs no credentials and leaks no data", async () => {
    const res = await worker.fetch!(
      new Request("https://worker.example/health", { headers: { Authorization: "Bearer nothing" } }),
      makeWorkerEnv(makeDb()),
      ctx,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("TOKEN");
    expect(text).not.toContain("GEMINI");
  });
});
