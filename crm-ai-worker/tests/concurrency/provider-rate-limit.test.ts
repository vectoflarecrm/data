import { describe, expect, it } from "vitest";
import { D1RateLimiter, LocalRateLimiter, providerRateLimiter, resetLocalRateLimiter } from "../../src/rate-limiter";
import { CONCURRENCY_LEVELS, d1env, runTasks, stormDb } from "./_helpers";

/* Security V2 Stage 23 (spec 搂24) 鈥?provider rate limiting under concurrency.
 *
 * The D1 window (src/rate-limiter.ts:79) is one atomic upsert that both
 * increments and RETURNS the post-update count, so N isolates racing the
 * provider cap can never overshoot it (the reactive 429-cooldown layer in
 * api_key_health remains the safety net if this proactive layer is down).
 * Rejected attempts still count 鈥?the counter records attempts, and may
 * exceed the limit; admission is `count <= limit`.
 * Failure policy: if the D1 window is unavailable the limiter fails OPEN
 * to local-only limiting (warn logged), never blocks the pipeline.
 */

const WINDOW_MS = 60_000;

describe("provider rate limiting under concurrency", () => {
  it.each(CONCURRENCY_LEVELS)("N=%i concurrent acquires against one D1 window: exactly the limit admitted", async (n) => {
    const db = stormDb();
    const limiter = new D1RateLimiter(d1env(db));
    const limit = Math.ceil(n / 2);
    const results = await runTasks(n, () => limiter.acquire("gemini:shared", limit, WINDOW_MS));
    // One shared window across the whole storm 鈥?the exact "many isolates,
    // one provider key" shape the D1 tier exists for.
    const admitted = results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(admitted).toHaveLength(limit);
  });

  it.each(CONCURRENCY_LEVELS)("N=%i per key: two keys stay independent under a mixed storm", async (n) => {
    const db = stormDb();
    const limiter = new D1RateLimiter(d1env(db));
    const perKey = n / 2; // 5 / 25 / 50
    const limit = perKey + 1; // cap above the storm: everyone fits
    const results = await runTasks(n, (i) => limiter.acquire(`gemini:key-${i % 2}`, limit, WINDOW_MS));
    const admitted = results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
    expect(admitted).toHaveLength(n);
    const counts = db.prepare("SELECT key, count FROM rate_limit_windows").all() as Array<{ key: string; count: number }>;
    expect(counts).toHaveLength(2); // one row per key
    for (const row of counts) expect(row.count).toBe(perKey);
  });

  it.each(CONCURRENCY_LEVELS)("N=%i rejected attempts still count (attempt counter 鈮?admissions)", async (n) => {
    const db = stormDb();
    const limiter = new D1RateLimiter(d1env(db));
    const limit = Math.ceil(n / 3);
    await runTasks(n, () => limiter.acquire("gemini:counted-key", limit, WINDOW_MS));
    const row = db.prepare("SELECT count FROM rate_limit_windows WHERE key = 'gemini:counted-key'").get() as {
      count: number;
    };
    expect(row.count).toBe(n); // every attempt incremented the window
  });

  it.each(CONCURRENCY_LEVELS)("N=%i through the tiered provider limiter: local + D1 agree on the cap", async (n) => {
    const db = stormDb();
    resetLocalRateLimiter(); // module-level shared window 鈥?reset between storms
    const limiter = providerRateLimiter(d1env(db));
    const limit = Math.ceil(n / 2);
    const results = await runTasks(n, () => limiter.acquire("gemini:tiered", limit, WINDOW_MS));
    const admitted = results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(admitted).toHaveLength(limit);
    resetLocalRateLimiter();
  });

  it.each(CONCURRENCY_LEVELS)("N=%i with the D1 window unavailable: fails open to local-only limiting", async (n) => {
    const db = stormDb();
    const limit = Math.ceil(n / 2);
    // D1 explodes on the window table 鈥?the documented degradation is NOT
    // "block everything" but "local limiter still bounds the isolate". The
    // [rate-limiter] warn lines in test output are this case, by design.
    const limiter = providerRateLimiter(d1env(db, "rate_limit_windows"));
    resetLocalRateLimiter();
    const results = await runTasks(n, () => limiter.acquire("gemini:degraded", limit, WINDOW_MS));
    const admitted = results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true); // no crash
    expect(admitted).toHaveLength(limit); // local tier held the cap
    resetLocalRateLimiter();
  });

  it("window rollover resets the cap (D1 fixed window)", async () => {
    const db = stormDb();
    const limiter = new D1RateLimiter(d1env(db));
    expect(await limiter.acquire("gemini:rollover", 1, 40)).toBe(true);
    expect(await limiter.acquire("gemini:rollover", 1, 40)).toBe(false);
    await new Promise((r) => setTimeout(r, 80)); // roll into the next window
    expect(await limiter.acquire("gemini:rollover", 1, 40)).toBe(true);
  });

  it("local sliding window admits exactly the limit under a storm", async () => {
    const limiter = new LocalRateLimiter();
    const results = await runTasks(50, () => limiter.acquire("local-key", 20, WINDOW_MS));
    const admitted = results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
    expect(admitted).toHaveLength(20);
    limiter.reset();
  });
});
