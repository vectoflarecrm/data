# Stage 28 — Gemini outreach transport hygiene (post-V2)

Closes the call-site inconsistency noted in the post-V2 audit of raw
`fetch()` sites.

## What shipped

`callGeminiOutreach` (src/outreach.ts) used to carry the API key in the URL
query (`…?key=${key}`) and interpolate the model name unencoded — unlike the
analysis call site (index.ts) which already used the `x-goog-api-key` header
and `encodeURIComponent`. Two consequences:

1. Any error path that embeds the request URL (fetch rejections, provider
   diagnostics, a future log line) would ship the key into logs —
   `safeLog` scrubs Bearer/PEM/`enc:v1:` shapes, not query strings.
2. A model override containing path-significant characters
   (`models/x:latest`) would silently alter the request path.

Both fixed for parity with index.ts: key moves to the `x-goog-api-key`
header, model name is URL-encoded. The function is now exported for the
test suite (Stage 23 exported-for-tests precedent) to pin the transport
contract.

## Verification

- `tests/gemini-transport.test.ts` — 2 tests (fetch stub): the URL contains
  neither `key=` nor the key value, the header carries it; a hostile model
  name is encoded in the URL.
- No other tests stubbed the old URL shape (verified by grep), so no
  assertions needed updating.
- Full suite 594/594 (50 files), `tsc` exit 0, dry-run 467.21 KiB / gzip
  116.66 KiB (shared verification run with Stage 27).
