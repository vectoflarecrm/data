// Distributed-capable rate limiting abstraction (Security V2 spec §17).
//
// Cloudflare Workers isolates do not share memory, so the in-memory RPM
// limiter in rate-limit.ts only ever bounds ONE isolate. This module adds
// the switchable RateLimiter abstraction plus two implementations:
//
// - LocalRateLimiter — per-isolate sliding window, the "local fast limiter"
//   (direct analogue of the original module-level buckets in rate-limit.ts).
// - D1RateLimiter — D1-backed fixed-window counter. D1 is the shared store
//   this project already runs on, so the provider cap becomes GLOBAL across
//   isolates and worker instances without introducing Durable Objects; a
//   future DO-based limiter only needs to implement the same interface to
//   be a drop-in replacement (that is the point of the abstraction).
//
// Failure policy: proactive rate limiting is a protective optimization, not
// a correctness control. The reactive layer (upstream 429 capture +
// api_key_health cooldown persisted in D1) remains the global safety net.
// When the D1 window is unavailable (table missing during a migration
// window, transient D1 error) the D1RateLimiter fails OPEN: the call
// proceeds under the local limiter only — exactly the pre-Stage-16
// behavior — and a warning is logged for observability.

/** Switchable rate limiter (spec §17): one acquire() = one request attempt. */
export interface RateLimiter {
  /**
   * Try to consume one slot for `key` within a window of `windowMs`.
   * Resolves true when the call may proceed; false when `limit` requests
   * are already inside the window.
   */
  acquire(key: string, limit: number, windowMs: number): Promise<boolean>;
}

/** Per-isolate sliding-window limiter (timestamps inside the window). */
export class LocalRateLimiter implements RateLimiter {
  private windows = new Map<string, number[]>();

  async acquire(key: string, limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const windowStart = now - windowMs;
    const timestamps = (this.windows.get(key) ?? []).filter((t) => t > windowStart);
    if (timestamps.length >= limit) {
      this.windows.set(key, timestamps);
      return false;
    }
    timestamps.push(now);
    this.windows.set(key, timestamps);
    return true;
  }

  /** Test-only: clear all in-memory windows. */
  reset(): void {
    this.windows.clear();
  }
}

/**
 * Minimal env shape needed by the distributed limiter tier.
 *
 * Stage 32: when the `RATE_LIMITER` Durable Object binding is present it
 * takes over the distributed tier (true sliding window, no fixed-window 2x
 * boundary). Absent (local dev, tests, a deploy before the migration) the
 * D1 fixed window stays authoritative — exactly the Stage 16 behavior.
 */
export interface RateLimiterEnv {
  DB: D1Database;
  RATE_LIMITER?: DurableObjectNamespace;
}

/**
 * D1-backed fixed-window limiter — the authoritative GLOBAL counter.
 *
 * One row per key; the single atomic upsert below both increments and
 * returns the post-update count, so concurrent isolates can never overshoot
 * the cap (the same atomicity argument as the campaign lock in Stage 12).
 * The stored counter records ATTEMPTS in the current window: a rejected
 * attempt still increments it (the atomic increment IS the claim attempt),
 * so the value can exceed `limit` — admission is unaffected, because any
 * count above the cap rejects until the window rolls over and the CASE
 * resets the counter to 1.
 * A fixed window can admit up to 2x the cap across a window boundary in
 * the worst case; that is acceptable for RPM protection because the
 * reactive 429-cooldown layer catches any residual burst.
 */

import { safeLog } from "./security/safe-log";

export class D1RateLimiter implements RateLimiter {
  constructor(private env: RateLimiterEnv) {}

  async acquire(key: string, limit: number, windowMs: number): Promise<boolean> {
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    try {
      const row = await this.env.DB.prepare(
        `INSERT INTO rate_limit_windows (key, window_start, count)
         VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE
             WHEN rate_limit_windows.window_start = excluded.window_start
             THEN rate_limit_windows.count + 1
             ELSE 1
           END,
           window_start = excluded.window_start
         RETURNING count`,
      ).bind(key, windowStart).first<{ count: number }>();
      return (row?.count ?? 1) <= limit;
    } catch (e) {
      safeLog("warn",
        `[rate-limiter] D1 window unavailable for "${key}", failing open to local-only limiting: ` +
          (e instanceof Error ? e.message : String(e)),
      );
      return true;
    }
  }
}

/**
 * Stage 32 — Durable-Object-backed sliding window, the documented drop-in
 * for the distributed tier. One DO instance per key (idFromName), so its
 * whole state is one timestamp list: the window is TRULY sliding, which
 * removes the fixed-window 2x-boundary overshoot the D1 tier documents.
 *
 * In-memory only by design: DO eviction resets the window, which is the
 * same fail-open stance as every other tier here — proactive limiting is a
 * protective optimization, never a correctness control; the reactive 429
 * capture + api_key_health cooldown remains the global safety net.
 */
export class RateLimiterDO {
  /** Timestamps inside the current window (one instance = one key). */
  private timestamps: number[] = [];

  constructor(_state: DurableObjectState, _env: unknown) {}

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/acquire") {
      return new Response("not found", { status: 404 });
    }
    let body: { limit?: unknown; windowMs?: unknown };
    try {
      body = (await request.json()) as { limit?: unknown; windowMs?: unknown };
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const limit = Number(body.limit);
    const windowMs = Number(body.windowMs);
    if (!Number.isInteger(limit) || limit <= 0 || !Number.isInteger(windowMs) || windowMs <= 0) {
      return new Response("limit/windowMs must be positive integers", { status: 400 });
    }
    const now = Date.now();
    const windowStart = now - windowMs;
    this.timestamps = this.timestamps.filter((t) => t > windowStart);
    if (this.timestamps.length >= limit) {
      return Response.json({ allowed: false });
    }
    this.timestamps.push(now);
    return Response.json({ allowed: true });
  }
}

/** Client for the DO tier. Fail-open on ANY error (DO unavailable, cold
 * start, unexpected shape): the call proceeds under the local limiter only
 * and a warning is logged — identical policy to D1RateLimiter. */
export class DurableObjectRateLimiter implements RateLimiter {
  constructor(private ns: DurableObjectNamespace) {}

  async acquire(key: string, limit: number, windowMs: number): Promise<boolean> {
    try {
      const stub = this.ns.get(this.ns.idFromName(key));
      const res = await stub.fetch("https://rate-limiter-do/acquire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit, windowMs }),
      });
      if (!res.ok) {
        throw new Error(`acquire answered HTTP ${res.status}`);
      }
      const data = (await res.json()) as { allowed?: unknown };
      if (typeof data.allowed !== "boolean") {
        throw new Error("acquire response missing boolean allowed");
      }
      return data.allowed;
    } catch (e) {
      safeLog("warn",
        `[rate-limiter] DO window unavailable for "${key}", failing open to local-only limiting: ` +
          (e instanceof Error ? e.message : String(e)),
      );
      return true;
    }
  }
}

/**
 * Local fast limiter first (cheap in-memory reject, no D1 round trip), then
 * the authoritative distributed window. A call the distributed window
 * rejects still consumes a local slot — harmless: the isolate stays under
 * its own cap and the wasted slot expires with the window.
 */
export class TieredRateLimiter implements RateLimiter {
  constructor(
    private local: RateLimiter,
    private distributed: RateLimiter,
  ) {}

  async acquire(key: string, limit: number, windowMs: number): Promise<boolean> {
    if (!(await this.local.acquire(key, limit, windowMs))) return false;
    return this.distributed.acquire(key, limit, windowMs);
  }
}

// One shared per-isolate window so every call in this isolate counts
// against the same local budget (mirrors the original module-level
// buckets): research, outreach generation and admin-triggered paths all
// draw from the same per-isolate allowance.
const sharedLocal = new LocalRateLimiter();

/**
 * Provider RPM limiter for this worker: shared local sliding window plus
 * the distributed tier — the DO sliding window when the binding exists,
 * the D1 fixed window otherwise. Safe to construct per call — both tiers
 * are stateless wrappers; the state lives in sharedLocal, in D1, or in
 * the DO instance.
 */
export function providerRateLimiter(env: RateLimiterEnv): RateLimiter {
  const distributed: RateLimiter = env.RATE_LIMITER
    ? new DurableObjectRateLimiter(env.RATE_LIMITER)
    : new D1RateLimiter(env);
  return new TieredRateLimiter(sharedLocal, distributed);
}

/** Test-only: reset the shared per-isolate window. */
export function resetLocalRateLimiter(): void {
  sharedLocal.reset();
}
