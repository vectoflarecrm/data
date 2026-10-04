import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  LocalRateLimiter,
  D1RateLimiter,
  TieredRateLimiter,
  providerRateLimiter,
  resetLocalRateLimiter,
} from "../src/rate-limiter";
import { acquireRpmSlot } from "../src/rate-limit";

/* Security V2 Stage 16 — provider rate limiting V2 (spec §17).
 *
 * §17.1 test list, mapped:
 *   tests simulate multiple worker instances ✓ (several LocalRateLimiters
 *   = several isolates, all sharing one D1)
 *   verify global provider limit ✓ (the shared D1 window caps the TOTAL
 *   admitted requests across instances at the configured limit)
 *   must not rely on single-isolate memory ✓ (control case: local-only
 *   instances overshoot the cap — exactly the pre-Stage-16 gap)
 *
 * Failure policy: the D1 tier FAILS OPEN (missing table / D1 error →
 * allow, local-only limiting remains, pre-Stage-16 behavior); the reactive
 * 429-cooldown layer stays the global safety net.
 */

class FakeD1 {
  constructor(private db: any) {}
  prepare(sql: string) {
    const db = this.db;
    let bound: unknown[] = [];
    const stmt: any = {
      bind(...args: unknown[]) { bound = args; return stmt; },
      all: async () => ({ results: db.prepare(sql).all(...bound), success: true }),
      first: async () => db.prepare(sql).get(...bound) ?? undefined,
      run: async () => {
        const info = db.prepare(sql).run(...bound);
        return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
      },
    };
    return stmt;
  }
  async batch(stmts: any[]) {
    for (const s of stmts) await s.run();
    return [];
  }
}

const WINDOW_DDL = `
  CREATE TABLE IF NOT EXISTS rate_limit_windows (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 1
  );
`;

/** withTable=false doubles as the "migration pending" fixture. */
function makeDb(withTable = true): any {
  const db = new DatabaseSync(":memory:");
  if (withTable) db.exec(WINDOW_DDL);
  return db;
}

function d1Env(db: any): { DB: any } {
  return { DB: new FakeD1(db) };
}

function windowCount(db: any, key: string): number {
  const row = db.prepare("SELECT count FROM rate_limit_windows WHERE key = ?").get(key) as { count: number } | undefined;
  return row ? Number(row.count) : 0;
}

describe("LocalRateLimiter (per-isolate sliding window)", () => {
  it("allows requests under the cap and blocks at the cap", async () => {
    const limiter = new LocalRateLimiter();
    expect(await limiter.acquire("groq", 3, 60_000)).toBe(true);
    expect(await limiter.acquire("groq", 3, 60_000)).toBe(true);
    expect(await limiter.acquire("groq", 3, 60_000)).toBe(true);
    expect(await limiter.acquire("groq", 3, 60_000)).toBe(false);
  });

  it("tracks keys independently", async () => {
    const limiter = new LocalRateLimiter();
    expect(await limiter.acquire("gemini", 1, 60_000)).toBe(true);
    expect(await limiter.acquire("gemini", 1, 60_000)).toBe(false);
    // groq unaffected by gemini's exhausted slot
    expect(await limiter.acquire("groq", 5, 60_000)).toBe(true);
  });

  it("recovers after the sliding window passes", async () => {
    const limiter = new LocalRateLimiter();
    expect(await limiter.acquire("zhipu", 1, 60_000)).toBe(true);
    expect(await limiter.acquire("zhipu", 1, 60_000)).toBe(false);
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(61_000);
      expect(await limiter.acquire("zhipu", 1, 60_000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("D1RateLimiter (distributed fixed window)", () => {
  it("counts atomically up to the limit then blocks", async () => {
    const db = makeDb();
    const limiter = new D1RateLimiter(d1Env(db));
    expect(await limiter.acquire("groq", 3, 60_000)).toBe(true);
    expect(await limiter.acquire("groq", 3, 60_000)).toBe(true);
    expect(await limiter.acquire("groq", 3, 60_000)).toBe(true);
    expect(await limiter.acquire("groq", 3, 60_000)).toBe(false);
    // The counter records ATTEMPTS: the rejected 4th claim incremented it
    // past the cap (it stays rejected until the window rolls over).
    expect(windowCount(db, "groq")).toBe(4);
  });

  it("resets when the fixed window rolls over", async () => {
    const limiter = new D1RateLimiter(d1Env(makeDb()));
    expect(await limiter.acquire("gemini", 1, 60_000)).toBe(true);
    expect(await limiter.acquire("gemini", 1, 60_000)).toBe(false);
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(61_000);
      expect(await limiter.acquire("gemini", 1, 60_000)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a stale full window row as a fresh window", async () => {
    const db = makeDb();
    // Leftover row from a previous window that already hit the cap.
    const staleStart = Math.floor(Date.now() / 60_000) * 60_000 - 120_000;
    db.prepare("INSERT INTO rate_limit_windows (key, window_start, count) VALUES (?, ?, ?)")
      .run("groq", staleStart, 99);
    const limiter = new D1RateLimiter(d1Env(db));
    expect(await limiter.acquire("groq", 2, 60_000)).toBe(true);
    expect(windowCount(db, "groq")).toBe(1);
  });

  it("fails open when the table is missing (migration window)", async () => {
    const limiter = new D1RateLimiter(d1Env(makeDb(false)));
    expect(await limiter.acquire("groq", 1, 60_000)).toBe(true);
    expect(await limiter.acquire("groq", 1, 60_000)).toBe(true);
  });

  it("concurrent acquires never overshoot the global cap", async () => {
    const limiter = new D1RateLimiter(d1Env(makeDb()));
    const results = await Promise.all(
      Array.from({ length: 10 }, () => limiter.acquire("nvidia", 6, 60_000)),
    );
    expect(results.filter((r) => r).length).toBe(6);
  });
});

describe("TieredRateLimiter (local fast limiter + distributed window)", () => {
  it("local rejection short-circuits before touching the distributed window", async () => {
    const db = makeDb();
    const limiter = new TieredRateLimiter(new LocalRateLimiter(), new D1RateLimiter(d1Env(db)));
    expect(await limiter.acquire("groq", 1, 60_000)).toBe(true);
    expect(await limiter.acquire("groq", 1, 60_000)).toBe(false);
    // The distributed window only saw the one accepted call.
    expect(windowCount(db, "groq")).toBe(1);
  });

  it("distributed rejection blocks even though the local window allowed it", async () => {
    const db = makeDb();
    // Pre-fill the shared window up to the cap from "another isolate".
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    db.prepare("INSERT INTO rate_limit_windows (key, window_start, count) VALUES (?, ?, ?)")
      .run("groq", now, 5);
    const limiter = new TieredRateLimiter(new LocalRateLimiter(), new D1RateLimiter(d1Env(db)));
    expect(await limiter.acquire("groq", 5, 60_000)).toBe(false);
  });
});

describe("spec §17.1 — global provider cap across worker instances", () => {
  it("multiple isolates sharing one D1 are capped at the global limit", async () => {
    // Three worker instances = three independent per-isolate windows, all
    // counting against ONE shared D1 (the real deployment's single store).
    const sharedDb = makeDb();
    const globalLimit = 5;
    const instances = [0, 1, 2].map(
      () => new TieredRateLimiter(new LocalRateLimiter(), new D1RateLimiter(d1Env(sharedDb))),
    );
    let allowed = 0;
    for (const instance of instances) {
      for (let i = 0; i < 3; i++) {
        if (await instance.acquire("gemini", globalLimit, 60_000)) allowed++;
      }
    }
    // 9 attempts across 3 isolates, but the shared window caps the total.
    expect(allowed).toBe(globalLimit);
    // The counter records all 9 attempts (4 rejected beyond the cap).
    expect(windowCount(sharedDb, "gemini")).toBe(9);
  });

  it("local-only limiting cannot enforce the global cap (the pre-Stage-16 gap)", async () => {
    // Control case: without the distributed tier each isolate counts only
    // itself, so N instances admit up to N x limit — exactly why spec §17.1
    // forbids relying on single-isolate memory.
    const globalLimit = 5;
    const instances = [0, 1, 2].map(() => new LocalRateLimiter());
    let allowed = 0;
    for (const instance of instances) {
      for (let i = 0; i < 3; i++) {
        if (await instance.acquire("gemini", globalLimit, 60_000)) allowed++;
      }
    }
    expect(allowed).toBe(9);
  });
});

describe("acquireRpmSlot (rate-limit.ts provider wiring)", () => {
  beforeEach(() => resetLocalRateLimiter());

  it("enforces the provider cap through the tiered limiter", async () => {
    const env = d1Env(makeDb());
    expect(await acquireRpmSlot(env, "groq", 2)).toBe(true);
    expect(await acquireRpmSlot(env, "groq", 2)).toBe(true);
    expect(await acquireRpmSlot(env, "groq", 2)).toBe(false);
  });

  it("keys the window by provider", async () => {
    const env = d1Env(makeDb());
    expect(await acquireRpmSlot(env, "gemini", 1)).toBe(true);
    // Independent provider key — groq is not affected by gemini's cap.
    expect(await acquireRpmSlot(env, "groq", 1)).toBe(true);
    expect(await acquireRpmSlot(env, "gemini", 1)).toBe(false);
  });

  it("fails open to local-only limiting when the D1 table is missing", async () => {
    const env = d1Env(makeDb(false));
    // D1 tier fails open (allow) — pre-Stage-16 behavior — while the local
    // tier still caps this isolate.
    expect(await acquireRpmSlot(env, "groq", 1)).toBe(true);
    expect(await acquireRpmSlot(env, "groq", 1)).toBe(false);
  });

  it("limiter instances built per call share the local singleton and D1 window", async () => {
    // Research (cron) and outreach (admin) build their own limiter per call,
    // yet must draw from the same per-isolate budget and the same D1 row.
    const env = d1Env(makeDb());
    const a = providerRateLimiter(env);
    const b = providerRateLimiter(env);
    expect(await a.acquire("groq", 1, 60_000)).toBe(true);
    expect(await b.acquire("groq", 1, 60_000)).toBe(false);
  });
});
