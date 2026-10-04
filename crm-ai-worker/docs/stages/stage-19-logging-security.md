# Stage 19 — Logging Security (spec §20)

**Status: complete.** Commit: `security-v2: add safe logging with redaction`
Test surface: 397/397 (8 new in `tests/safe-log.test.ts`), tsc clean, dry-run 438.04 KiB, 4 panels clean.

## What the spec asked for (§20, 架构.txt L1393-1417)

Repository-wide `console.log/error/warn` audit; the §20 keywords (apiKey, token, privateKey, password, credential, authorization, cookie) must never be printed directly; implement `safeLog()` with automatic redaction.

## Audit results (repository-wide console.* inventory)

**Server-side (`src/`, lands in `wrangler tail`) — 8 sites, all reviewed clean before, now all routed through `safeLog()`:**

| Site | What it logs |
|---|---|
| admin.ts `internalErrorResponse` | request id + the thrown error (name/message/stack) |
| admin.ts session lookup catch | D1 error (fail-closed path) |
| admin.ts credential migration ×2 | `table/id/provider/event=encrypted-verified` — designed to never carry credential material |
| outreach-send.ts reap catch | error message string |
| rate-limiter.ts D1 catch | provider key name + error message (fail-open path) |
| research-run.ts `warnSkip` | error message (fail-open path) |
| audit-log.ts write-fail catch | action + resource type + error (fail-open path) |

None of the 8 printed a §20 keyword today — the audit confirmed the sites log ids, provider names, migration events and error strings. `safeLog()` exists so a future `console.log("got key", row)` cannot leak a stored secret into the tail.

**Browser-side — 1 site, allowlisted:** the OUTREACH panel's `console.log('发送失败明细', fails)` prints the send-batch result (`{id, ok, error}` rows) to the operator's own browser console. Its data already passes through Stage 18's response redaction net. Left as-is (client-side; not a Worker log surface).

**Dev tooling, out of scope:** `scripts/check-panel.mjs` console output is a local lint script over panel HTML (no secrets); `tests/` stderr lines are local test output by design (several are the fail-open paths' own assertions).

## Changes

- `crm-ai-worker/src/security/safe-log.ts` (new) — `safeLog(level, ...args)`:
  - **Structured args** (objects/arrays) are deep-walked (never mutated, cycle-guarded, `Date`→ISO) and the value of any sensitive key becomes `[REDACTED]`. Key list = §20 (`apiKey, token, privateKey, password, credential, authorization, cookie`) + the §19 names (`api_key, access_token, refresh_token, client_secret, session_token, cloudflare_token`), matched case- and underscore-insensitively. Near-miss keys stay readable: `credential_type`, `key_hint`, `key_index`.
  - **Strings** are scrubbed of the three credential shapes this codebase can realistically interpolate: service-account PEM blocks → `[REDACTED PEM]`, `enc:v1:…` ciphertexts → `enc:v1:[REDACTED]`, `Bearer <token>` → `Bearer [REDACTED]`.
  - **Error args** keep the `Name: message\nstack` shape developers rely on in the tail, scrubbed.
- `crm-ai-worker/src/admin.ts` (4 sites), `outreach-send.ts`, `rate-limiter.ts`, `research-run.ts`, `audit-log.ts` (1 site each) — every server-side `console.*` replaced by the equivalent `safeLog("log"|"warn"|"error", …)` with identical messages; imports added (three of these modules had never imported anything — they were fully self-contained).
- `crm-ai-worker/tests/safe-log.test.ts` (new, 8 tests) — §20/§19 key redaction (camelCase, UPPER, snake_case; near-misses pass), nesting, non-mutation, cycle safety, string-pattern scrubbing, Error shape preservation, level delegation via console spies, and a **repo-wide static guard** that scans every `src/**/*.ts` line for direct `console.(log|error|warn|info|debug)(` and fails unless the only matches are inside `safe-log.ts` itself or the single allowlisted browser-side panel line.

## Decisions

- **Key-name redaction + pattern scrubbing, not blanket string mangling.** Structured keys are deterministic; the three string patterns (PEM / `enc:v1:` / Bearer) are the concrete leak shapes a free-form message can carry in this codebase. Message readability for the other 99% is preserved.
- **Independent walker from Stage 18's `sanitizeResponse`.** The §20 log list is deliberately broader than §19's response list (`token`, `credential`, `authorization`, `cookie` would over-redact API responses but belong in logs). Coupling the two would invite semantic drift; the ~20 duplicated walk lines are the price of frozen Stage 18 behavior.
- **`[REDACTED]` marker shared with `redaction.ts`** so one grep finds every redaction site across responses and logs.
- **Static guard test, not lint config** — keeps the enforcement inside the suite that already gates every commit, with the exact allowlist visible in code review.
- Error objects are stringified (scrubbed name/message/stack) rather than passed raw — a raw `Error` handed to `console` would bypass the walker entirely.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **397/397 (28 files)**, including 8 new safe-log tests.
- `npx wrangler deploy --dry-run --outdir dist-dryrun` — Total Upload 438.04 KiB.
- `node scripts/check-panel.mjs` — 4 panels clean.

Baseline #19 updated in `docs/security-v2-baseline.md` (response redaction + logging thirds complete; request-id propagation remains for Stage 20).
