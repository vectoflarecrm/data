import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DurableObjectRateLimiter,
  RateLimiterDO,
  providerRateLimiter,
  resetLocalRateLimiter,
} from "../src/rate-limiter";
import { makeDb, FakeD1 } from "./security/_helpers";

/* Post-V2 Stage 32 — Durable-Object sliding-window rate limiter.
 *
 * The DO class is a plain class with a fetch(): unit tests instantiate it
 * directly and drive it with real Request objects. The client tier is
 * exercised through a fake namespace. The fixed-window 2x-boundary
 * overshoot (documented on D1RateLimiter) is the regression this stage
 * exists to remove — the sliding-window tests pin it.
 */

function acquireReq(limit: number, windowMs: number): Request {
  return new Request("https://rate-limiter-do/acquire", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limit, windowMs }),
  });
}

async function allowed(do_: RateLimiterDO, limit: number, windowMs: number): Promise<boolean> {
  const res = await do_.fetch(acquireReq(limit, windowMs));
  const data = (await res.json()) as { allowed: boolean };
  return data.allowed;
}

describe("RateLimiterDO (sliding window)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("admits up to the limit inside one window, then rejects", async () => {
    const d = new RateLimiterDO({} as never, {});
    expect(await allowed(d, 2, 60_000)).toBe(true);
    expect(await allowed(d, 2, 60_000)).toBe(true);
    expect(await allowed(d, 2, 60_000)).toBe(false);
  });

  it("is TRULY sliding: a full allowance returns one window later, never 2x at a boundary", async () => {
    const d = new RateLimiterDO({} as never, {});
    vi.setSystemTime(1_000_000);
    expect(await allowed(d, 3, 60_000)).toBe(true);
    expect(await allowed(d, 3, 60_000)).toBe(true);
    expect(await allowed(d, 3, 60_000)).toBe(true);
    expect(await allowed(d, 3, 60_000)).toBe(false);
    // Fixed window: a burst at the next boundary could admit 3 MORE (2x).
    // Sliding window: at T+window+1 the old slots have all expired, so the
    // full allowance returns — but nothing was ever double-admitted.
    vi.setSystemTime(1_000_000 + 60_001);
    expect(await allowed(d, 3, 60_000)).toBe(true);
    expect(await allowed(d, 3, 60_000)).toBe(true);
    expect(await allowed(d, 3, 60_000)).toBe(true);
    expect(await allowed(d, 3, 60_000)).toBe(false);
  });

  it("expires slots progressively: an old slot frees capacity mid-window", async () => {
    const d = new RateLimiterDO({} as never, {});
    vi.setSystemTime(0);
    expect(await allowed(d, 2, 60_000)).toBe(true);
    vi.setSystemTime(30_000);
    expect(await allowed(d, 2, 60_000)).toBe(true);
    expect(await allowed(d, 2, 60_000)).toBe(false); // full
    vi.setSystemTime(60_001); // the first slot (t=0) is now outside
    expect(await allowed(d, 2, 60_000)).toBe(true);
  });

  it("keeps instances independent (one instance = one key)", async () => {
    const a = new RateLimiterDO({} as never, {});
    const b = new RateLimiterDO({} as never, {});
    expect(await allowed(a, 1, 60_000)).toBe(true);
    expect(await allowed(a, 1, 60_000)).toBe(false);
    expect(await allowed(b, 1, 60_000)).toBe(true); // separate DO id = separate budget
  });

  it("rejects wrong paths with 404", async () => {
    const d = new RateLimiterDO({} as never, {});
    const res = await d.fetch(new Request("https://x/other", { method: "POST", body: "{}" }));
    expect(res.status).toBe(404);
  });

  it("rejects malformed bodies with 400", async () => {
    const d = new RateLimiterDO({} as never, {});
    const bad = await d.fetch(
      new Request("https://x/acquire", { method: "POST", body: "not-json{" }),
    );
    expect(bad.status).toBe(400);
  });

  it("rejects non-positive or fractional limit/windowMs with 400", async () => {
    const d = new RateLimiterDO({} as never, {});
    for (const [limit, windowMs] of [[0, 60_000], [-1, 60_000], [1.5, 60_000], [1, 0], [1, -5], [1, 10.5]] as Array<[number, number]>) {
      const res = await d.fetch(acquireReq(limit, windowMs));
      expect(res.status, `limit=${limit} windowMs=${windowMs}`).toBe(400);
    }
  });
});

interface NsCall {
  key: string;
  body: { limit: number; windowMs: number };
}

function fakeNs(
  handler: (call: NsCall) => Response | Promise<Response>,
): { ns: any; calls: NsCall[] } {
  const calls: NsCall[] = [];
  const ns = {
    idFromName(key: string) {
      return `id:${key}`;
    },
    get(id: unknown) {
      const key = String(id).slice(3);
      return {
        fetch: async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const body = JSON.parse(String(init?.body)) as { limit: number; windowMs: number };
          const call = { key, body };
          calls.push(call);
          return handler(call);
        },
      };
    },
  };
  return { ns, calls };
}

describe("DurableObjectRateLimiter (client, fail-open)", () => {
  it("routes one DO instance per key and passes limit/windowMs through", async () => {
    const { ns, calls } = fakeNs(() => Response.json({ allowed: true }));
    const limiter = new DurableObjectRateLimiter(ns);
    expect(await limiter.acquire("gemini", 15, 60_000)).toBe(true);
    expect(await limiter.acquire("groq", 30, 60_000)).toBe(true);
    expect(calls.map((c) => c.key)).toEqual(["gemini", "groq"]);
    expect(calls[0].body).toEqual({ limit: 15, windowMs: 60_000 });
    expect(calls[1].body).toEqual({ limit: 30, windowMs: 60_000 });
  });

  it("passes the DO verdict through in both directions", async () => {
    let verdict = false;
    const { ns } = fakeNs(() => Response.json({ allowed: verdict }));
    const limiter = new DurableObjectRateLimiter(ns);
    expect(await limiter.acquire("gemini", 1, 60_000)).toBe(false);
    verdict = true;
    expect(await limiter.acquire("gemini", 1, 60_000)).toBe(true);
  });

  it("fails OPEN on a throwing stub, a non-OK status, and a malformed body", async () => {
    const { ns: nsBoom } = fakeNs(() => {
      throw new Error("DO cold");
    });
    const limiter1 = new DurableObjectRateLimiter(nsBoom);
    expect(await limiter1.acquire("gemini", 1, 60_000)).toBe(true);

    const { ns: ns500 } = fakeNs(() => new Response("boom", { status: 500 }));
    const limiter2 = new DurableObjectRateLimiter(ns500);
    expect(await limiter2.acquire("gemini", 1, 60_000)).toBe(true);

    const { ns: nsGarbage } = fakeNs(() => Response.json({ nope: true }));
    const limiter3 = new DurableObjectRateLimiter(nsGarbage);
    expect(await limiter3.acquire("gemini", 1, 60_000)).toBe(true);
  });
});

describe("providerRateLimiter wiring", () => {
  beforeEach(() => {
    resetLocalRateLimiter();
  });

  it("with the binding the DO tier replaces D1 (rate_limit_windows stays empty)", async () => {
    const db = makeDb();
    const { ns, calls } = fakeNs(() => Response.json({ allowed: true }));
    const env = { DB: new FakeD1(db), RATE_LIMITER: ns };
    const limiter = providerRateLimiter(env);
    expect(await limiter.acquire("gemini", 5, 60_000)).toBe(true);
    expect(calls.map((c) => c.key)).toEqual(["gemini"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM rate_limit_windows").get().n).toBe(0);
  });

  it("without the binding the D1 fixed window stays authoritative", async () => {
    const db = makeDb();
    const env = { DB: new FakeD1(db) };
    const limiter = providerRateLimiter(env);
    expect(await limiter.acquire("gemini", 5, 60_000)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM rate_limit_windows").get().n).toBe(1);
  });

  it("local tier short-circuits: a local reject never reaches the distributed tier", async () => {
    const { ns, calls } = fakeNs(() => Response.json({ allowed: true }));
    const env = { DB: new FakeD1(makeDb()), RATE_LIMITER: ns };
    const limiter = providerRateLimiter(env);
    expect(await limiter.acquire("gemini", 1, 60_000)).toBe(true);
    expect(await limiter.acquire("gemini", 1, 60_000)).toBe(false); // local says no
    expect(calls.length).toBe(1); // distributed consulted exactly once
  });
});
