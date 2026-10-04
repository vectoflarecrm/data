# Stage 16 Report — Provider Rate Limiting V2

Branch: `feature/security-v2` · Follows: Stage 15 (Score Separation)

## Goal (spec §17)
The proactive RPM limiter was a per-isolate sliding window: each Cloudflare
isolate counted only itself, so N concurrent isolates/instances could admit
up to N× the provider cap — the reactive layer (429 capture + key cooldown)
caught the aftermath, which is exactly the repeated-429 pattern that risks
free-tier bans. Stage 17 asks for (a) the per-isolate limiter kept as a
local fast limiter, (b) a distributed limiter — Durable Objects preferred,
an abstraction sufficient if DOs are not yet warranted — and (c) §17.1
tests that simulate multiple worker instances and prove the global provider
limit without relying on single-isolate memory.

## Changes

### `src/rate-limiter.ts` (new)
The switchable abstraction plus its implementations:
- **`interface RateLimiter`** — `acquire(key, limit, windowMs):
  Promise<boolean>`: one acquire = one request attempt. This is the
  spec's contract; a Durable-Object implementation later is a drop-in.
- **`LocalRateLimiter`** — per-isolate sliding window (timestamps), the
  direct analogue of the original module-level buckets; a singleton
  instance is shared by every call site in this isolate so research,
  outreach and admin paths draw from the same local budget.
- **`D1RateLimiter`** — the authoritative global fixed-window counter in
  D1 (the shared store this project already runs on — chosen over a
  Durable Object because it adds zero deployment complexity and the
  abstraction keeps a DO swap trivial). One row per key; the whole claim
  is a single atomic `INSERT ... ON CONFLICT ... RETURNING count` upsert:
  same-window → increment, rolled window → reset to 1, and the returned
  post-update count is checked against the limit — concurrent isolates can
  never overshoot the cap (same atomicity argument as the Stage 12
  campaign lock). The stored counter records attempts (a rejected attempt
  still increments it; admission is `count <= limit`, so over-cap windows
  stay rejected until rollover). `window_start` rolls forward in place, so
  the table never grows.
- **`TieredRateLimiter`** — local fast limiter first (in-memory reject,
  no D1 round trip), then the distributed window. A distributed rejection
  wastes one local slot — harmless and documented.
- **`providerRateLimiter(env)`** — factory composing the shared local
  singleton + a D1 limiter; stateless per-call construction, state lives
  in the singleton and D1.

### `src/rate-limit.ts`
- **`acquireRpmSlot(env, provider, limit)` (new)** — async acquisition
  keyed by provider with the 60s `WINDOW_MS`, delegating to the tiered
  limiter. The sync `tryAcquireRpmSlot` and its semantics are kept
  (existing suite untouched); the header now names the per-isolate window
  as the LOCAL FAST LIMITER of the §17 two-tier design.

### Call sites (mechanical sync→async migration, behavior-preserving)
- `src/index.ts` — all 9 research providers (gemini/groq/cerebras/mistral/
  deepseek/zhipu/nvidia/openrouter/amd): `if (!tryAcquireRpmSlot(p, l))
  return null` → `if (!(await acquireRpmSlot(env, p, l))) return null`.
  Same skip-to-next-provider semantics, now drawing a globally-counted
  slot.
- `src/outreach.ts` — both outreach paths (gemini loop + OpenAI-compatible
  fallback chain): same migration with `break`/`continue` semantics kept.

### Migration / deploy
- `migrations/0014_rate_limit_windows.sql` + `schema.sql`: the
  `rate_limit_windows` table (key, window_start, count). New table → no
  deploy-workflow step needed (schema.sql `IF NOT EXISTS` runs before the
  new code, campaign_locks precedent); the fail-open window below covers
  any residual gap.

## Failure policy (deliberate)
FAIL OPEN: proactive limiting is a protective optimization, not a
correctness control — the reactive 429 + api_key_health cooldown layer
remains the global safety net. A migration-pending or degraded D1
(missing table, transient error) logs a warning and allows the call under
the local limiter only, i.e. exactly the pre-Stage-16 behavior. This
mirrors the Stage 12/14 fail-open decisions (optimization/auditability
layers) and contrasts with the fail-closed quota path (Stage 11), which
guards a hard correctness guarantee.

## Tests (+16 → 367 total)
`tests/rate-limiter.test.ts` (§17.1 mapped in the header):
- `LocalRateLimiter`: cap enforcement, per-key independence, sliding-window
  recovery (fake timers);
- `D1RateLimiter`: atomic counting to the cap (attempt-counter semantics
  asserted: a rejected claim bumps the count), fixed-window rollover reset,
  stale full window treated as fresh, **fail-open on missing table**,
  **10 concurrent acquires with limit 6 admit exactly 6**;
- `TieredRateLimiter`: local rejection short-circuits before touching D1
  (counter untouched), distributed rejection blocks a locally-allowed call
  pre-filled "from another isolate";
- **§17.1 core**: three worker instances (three independent local windows)
  sharing one D1 make 9 attempts against a global limit of 5 → exactly 5
  admitted; the control case (local-only, no distributed tier) admits all
  9 — the pre-Stage-16 gap demonstrated;
- `acquireRpmSlot` wiring: cap through the tiered path, per-provider keying,
  fail-open degradation to local-only, and per-call limiter construction
  still sharing the singleton + D1 window (cron and outreach paths agree).

## Verification
- `npx tsc --noEmit`: pass
- `npm test`: **367/367 pass** (was 351, +16; 25 files)
- `node scripts/check-panel.mjs`: 4 panels clean
- `npx wrangler deploy --dry-run` (offline): pass

## Security Risks Fixed
- Baseline **#17 (P2)**: the provider RPM cap is now global across
  isolates and worker instances. Concurrent cron runs, admin-triggered
  outreach and any future fan-out can no longer jointly exceed a
  free-tier provider cap and trigger the repeated-429 pattern the
  proactive limiter exists to prevent.

## Notes and boundaries
- Fixed window (not sliding) in D1: at most 2× the cap can be admitted
  across a window boundary — accepted, the reactive 429-cooldown layer
  catches residual bursts; sliding-in-D1 would need multi-row
  transactions per request for no practical gain at RPM scale.
- The counter counts attempts within the current window and can exceed
  the limit while calls are being rejected; it resets on rollover. The
  table is internal to the limiter (nothing else reads it).
- tryAcquireRpmSlot remains exported and tested (append-only policy);
  production call sites all use acquireRpmSlot.
