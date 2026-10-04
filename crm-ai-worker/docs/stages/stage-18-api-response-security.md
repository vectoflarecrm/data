# Stage 18 — API Response Security (spec §19)

**Status: complete.** Commit: `security-v2: add api response redaction`
Test surface: 389/389 (12 new in `tests/response-redaction.test.ts`), tsc clean, dry-run 435.99 KiB, 4 panels clean.

## What the spec asked for (§19, 架构.txt L1360-1391)

`src/security/redaction.ts` with `sanitizeResponse()`; all API output passes through it; the eight forbidden key names — `api_key`, `private_key`, `access_token`, `refresh_token`, `client_secret`, `password`, `session_token`, `cloudflare_token` — must never be returned. §19.1 acceptance: GET customers / settings / providers / Gmail / campaigns / research carry no secret leakage.

## Response-surface audit (why the choke point is genuinely single)

Every JSON response the worker can emit was traced:

- `index.ts`'s `fetch` delegates everything to `handleAdminRequest` (the only other response is a plain-text 404).
- **All** admin API JSON flows through `jsonResponse()` (admin.ts). Every other `JSON.stringify` in the repo is either an outbound provider request body (index.ts/gmail.ts/outreach.ts), a DB-write serialization (serializeFilters, rawJson, personas), or panel client-side `body: JSON.stringify(...)` request construction.
- Panel HTML (`htmlResponse`) carries no server-side data — panels fetch via the API.

So wiring `sanitizeResponse()` into `jsonResponse()` covers 100% of API JSON output. `jsonResponse` is now exported for tests (same pattern as `getCustomerEvidence`).

## Changes

- `crm-ai-worker/src/security/redaction.ts` (new) — `sanitizeResponse()` deep-walks the payload and replaces the value of any §19 key name with `[REDACTED]` (kept, not dropped, so JSON shapes stay stable for the panel). Matching is canonical: lowercase + strip underscores, so `api_key`, `apiKey`, `API_KEY`, `Api_Key` all match. Non-plain values pass through; input is never mutated; a WeakSet guards against reference cycles.
- `crm-ai-worker/src/admin.ts` — `jsonResponse()` now serializes `sanitizeResponse(body)`; import added; `jsonResponse` exported for tests.
- **The one deliberate rename.** GET /admin/api/keys used to return the *masked* display hint under the field name `api_key` (a Stage 4 design: `api_key: "gsk_li…3456"` — masked by construction, never the secret). A strict key-name net cannot distinguish that from a leak, so the hint moved to its real name: the response now carries `key_hint` instead of `api_key`. The KEYS panel script renders `esc(k.key_hint)` (one identifier). Three existing assertions tracked the rename with their protective intent unchanged (still assert the exact masked value / escaped rendering): `credential-api.test.ts:190`, `:459`, `security-headers.test.ts:253`. No test was deleted or weakened.
- `crm-ai-worker/tests/response-redaction.test.ts` (new, 12 tests) — unit coverage (all 8 names, camelCase/UPPER variants, nesting, arrays, pass-through keys, non-mutation, cycle safety), the `jsonResponse` wiring proof, and §19.1 integration: six seeded GET surfaces (customers list, customer detail incl. contacts+evidence, keys incl. settings/cooldowns/history, Gmail accounts, outreach settings, campaigns) with real secret material in D1 (a legacy cleartext key, an `enc:v1:` ciphertext, a service-account PEM), asserting that no forbidden key name appears anywhere in the parsed body and none of the raw secrets / the panel token / the master encryption key appear in the serialized response.

## §19.1 mapping

| Spec endpoint | Actual route | Result |
|---|---|---|
| GET customers | `/admin/api/customers` (+ `/:id` detail) | leak-free (test) |
| GET settings | `/admin/api/keys` → `settings` + `/admin/api/outreach/settings` | leak-free (test) |
| GET providers | `/admin/api/keys` (keys + cooldowns + history) | leak-free; hint under `key_hint` (test) |
| GET Gmail | `/admin/api/gmail/accounts` | leak-free; `private_key` never selected (test) |
| GET campaigns | `/admin/api/outreach/campaigns` | leak-free (test) |
| GET research | customer detail `/admin/api/customers/:id` (evidence chain surface; no dedicated research-runs endpoint exists) | leak-free (test) |

## Decisions

- **Redact by key name, not by value heuristics.** Deterministic and auditable; value-shape sniffing (length, charset, `…` markers) would be fragile and could both over-redact and under-redact.
- **`[REDACTED]` instead of dropping keys** — shape stability for the panel and for tests; the marker is greppable in logs.
- **Rename the hint field rather than punch a bypass hole** in the net — an allowlist exemption in `sanitizeResponse` for "masked-looking" values would defeat the point. The rename is also more honest API shape: a hint is not a key.
- **Include camelCase variants** (apiKey, privateKey, …) via canonicalization — costless and covers hand-built response objects, even though DB-derived rows are snake_case.
- Pre-existing per-handler protections stay: Gmail GET never selects `private_key`; GET /keys strips the raw column before responding; `internalErrorResponse` stays redacted. The net is defense in depth behind all of them.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **389/389 (27 files)**, including 12 new response-redaction tests and the 3 rename-tracking assertions.
- `npx wrangler deploy --dry-run --outdir dist-dryrun` — Total Upload 435.99 KiB.
- `node scripts/check-panel.mjs` — 4 panels clean.

Baseline #19 annotated in `docs/security-v2-baseline.md` (response redaction third complete; safeLog and request-id remain for Stages 19-20).
