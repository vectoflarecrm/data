# Stage 32 — Durable-Object rate limiter (post-V2)

Closes the last limiter gap the final report kept as a "documented drop-in
next step": the D1 fixed window is global and atomic, but at a window
boundary it can admit up to 2x the cap (the fixed-window property itself,
not a bug). A Durable Object turns the distributed tier into a TRUE global
sliding window. The Stage 16 `RateLimiter` abstraction exists for exactly
this swap.

## Design

- **One DO instance per key** (`idFromName(provider)`), so the whole state
  is one in-memory timestamp list — no SQLite storage I/O on the hot path.
- **In-memory only, by design**: DO eviction resets the window, which is
  the same fail-open stance as every other tier. Proactive limiting is a
  protective optimization, never a correctness control; the reactive 429
  capture + `api_key_health` cooldown stays the global safety net.
- **Fail-open everywhere**: the client (`DurableObjectRateLimiter`) opens
  on any error — DO unavailable, non-OK status, or a malformed body
  (missing/`typeof allowed !== "boolean"`). A degraded DO degrades to
  local-only limiting, exactly the pre-Stage-16 behavior.
- **Zero-drama rollout**: `providerRateLimiter(env)` picks the DO tier only
  when `env.RATE_LIMITER` exists; otherwise the Stage 16 D1 fixed window
  stays authoritative. Local dev, tests, and a pre-migration deploy are
  unaffected; rolling back the bundle is safe (old code ignores the
  binding). The binding is active from the first deploy carrying it — the
  Stage 16 precedent (active by default, dormant-tolerant code).
- The DO rejects wrong paths (404) and non-positive/fractional
  `limit`/`windowMs` (400) so a caller bug cannot wedge a window.

## What shipped

- `src/rate-limiter.ts` — `RateLimiterDO` (POST `/acquire`, sliding-window
  filter-then-push) + `DurableObjectRateLimiter` client (fail-open on any
  error) + `providerRateLimiter` wiring + `RateLimiterEnv.RATE_LIMITER?`.
- `src/rate-limit.ts` — `acquireRpmSlot` env widened
  (`RATE_LIMITER?: DurableObjectNamespace`); the ten index.ts call sites
  and two outreach.ts call sites need no change (they already pass the
  full worker env).
- `src/index.ts` — `RATE_LIMITER` on Env; `export { RateLimiterDO }`
  (Workers requires DO classes exported from the entry point).
- `wrangler.toml` — `[durable_objects]` binding + `[[migrations]]`
  `new_sqlite_classes` (free-tier compatible; the class uses no storage,
  but SQLite is the only allowed class type for new DOs).

## Verification

- `tests/rate-limiter-do.test.ts` — 13 tests:
  - DO unit (7): cap-then-reject; TRUE sliding semantics (full allowance
    returns one window later — the 2x-boundary regression pin);
    progressive slot expiry mid-window; per-instance independence; 404;
    bad JSON 400; invalid limit/windowMs 400.
  - Client (3): one instance per key + payload passthrough; verdict
    passthrough both directions; fail-open on throwing stub / HTTP 500 /
    malformed body.
  - Wiring (3): with the binding the DO tier replaces D1
    (`rate_limit_windows` stays empty); without it the D1 row appears;
    a local reject short-circuits before the distributed tier.
- Full suite: **674/674 (54 files)**, zero regressions; `tsc --noEmit`
  clean; dry-run 532.38 KiB (gzip 131.14 KiB), wrangler resolves
  `env.RATE_LIMITER (RateLimiterDO) Durable Object`; 7 panels clean.

## Deployment note

`wrangler deploy` applies the one-time DO migration automatically; no D1
step, no operator action, no secrets. Nothing to smoke beyond the standard
pipeline: the limiter is exercised on the first AI call, and its absence
(undeployed migration) is invisible by construction.
