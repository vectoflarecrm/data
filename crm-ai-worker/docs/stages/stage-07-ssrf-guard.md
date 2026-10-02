# Stage 7 Report — SSRF / Outbound URL Guard

Branch: `feature/security-v2` · Follows: Stage 6 (CSRF / Origin guard)

## Goal (spec §8)
Unify outbound fetching so every dynamic URL (customer domains, search-result
links, research URLs, social links) is validated before connecting: only
`http:`/`https:` to public origins; refuse loopback/private/link-local IPs,
localhost-style names and cloud metadata endpoints. Be honest about what the
Workers runtime cannot guarantee (DNS rebinding, redirect hops) instead of
faking it — record it in `docs/security-limitations.md`.

## Changes

### `src/security/outbound-url.ts` (new)
- `assertPublicHttpUrl(raw): URL` — throws typed `OutboundUrlError` when:
  - the URL is unparseable, or the scheme is anything but http/https
    (`file:`, `ftp:`, `gopher:`, `data:`, `javascript:` …);
  - the hostname is `localhost` (any case) or ends with `.localhost`,
    `.local`, `.internal` (the last covers `metadata.google.internal`);
  - the hostname is an IPv4 literal in `0.0.0.0/8`, `10/8`, `127/8`,
    `172.16/12`, `192.168/16` or `169.254/16`. The WHATWG URL parser has
    already normalized shorthand forms (`http://127.1`, `http://0x7f.1`,
    `http://2130706433` → `127.0.0.1`), so one canonical check catches them;
  - the hostname is an IPv6 literal (bracketed, as the parser emits it) that
    is `::`, `::1`, in `fc00::/7` (ULA), `fe80::/10` (link-local), or is an
    IPv4-mapped `::ffff:x.y.z.w` whose embedded IPv4 is itself private.
- `parseIpv6()` — self-contained parser (zero-compression, embedded IPv4
  tails); exported for direct testing since the runtime offers no
  `net`-style helpers.
- `ipv4Refused()` — the private/reserved range table.

### `src/index.ts` — single enforcement point
`fetchWithTimeout()` now calls `assertPublicHttpUrl(url)` as its first
statement. Every dynamic crawl path funnels through it:
- customer websites — `fetchWebsite()` (processCustomer) and
  `fetchAdditionalSources()`;
- search-result links — `searchCompanyInfo()`;
- research/sub-page URLs — `fetchAdditionalSources()`;
- social links — `verifySocialMedia()`.

All of these call sites already wrap fetches in per-source try/catch, so a
refused URL behaves exactly like an unreachable source (skipped, research
continues) — no behavioral change for legitimate targets. Hardcoded vendor
endpoints (AI providers, Gmail, search APIs, Firecrawl) that also pass
through `fetchWithTimeout` are public https constants and pass trivially;
direct `fetch()` calls with compile-time-constant URLs are documented as
out of scope in `docs/security-limitations.md` §2.

### `docs/security-limitations.md` (new, spec §8.2)
Records, without sugar-coating:
1. **DNS rebinding / resolve-then-pin**: Workers has no pre-connect
   resolution API; the guard validates literals, the platform's edge egress
   cannot reach RFC1918/loopback/link-local (the official protection the
   spec points to), and the residual theoretical gap is stated as such.
2. **Redirect hops**: `fetch()` follows chains internally; per-hop
   re-validation is impossible without `redirect: "manual"`, which would
   break the legitimate redirects the crawler depends on. Same platform
   egress bound applies.
3. Pre-existing entries (per-isolate rate limiting, CSP `style-src-attr`)
   are cross-referenced so the file is the single honest-limitations index.

## Tests (+7 → 246 total)
`tests/ssrf.test.ts`:
- **spec §8.4 mandatory list**: `http://127.0.0.1`, `http://localhost`,
  `http://10.0.0.1`, `http://192.168.1.1`, `http://169.254.169.254`,
  `http://[::1]`, `file:///etc/passwd`, `gopher://…`, `javascript:…`,
  `data:…` — all refused; `https://example.com` allowed.
- **range edges**: `172.16.0.1`/`172.31.255.255` refused, `172.32.0.1`/
  `172.15.255.255` allowed; `0.0.0.0`, `0.1.2.3` refused.
- **hostname forms**: `metadata.google.internal`, `printer.local`,
  `db.internal`, `sub.localhost`, mixed-case `LOCALHOST` refused.
- **IPv6**: `fc00::`, `fd…`, `fe80::`, `::`, `::ffff:127.0.0.1`,
  `::ffff:10.0.0.1` refused; `2001:db8::1`, `::ffff:8.8.8.8`,
  `2606:4700::…` allowed; parser unit tests for compression, embedded IPv4
  and malformed literals (`:::`, short/long forms, bad hex, bogus v4 tail).
- **normalization traps**: `http://2130706433`, `http://0x7f.0.0.1`,
  `http://127.1` all refused (WHATWG normalizes them to `127.0.0.1`).
- **integration**: with `fetch` stubbed, `fetchWithTimeout` on a banned
  target throws `OutboundUrlError` **without the stub ever being called**;
  a public URL still reaches the network exactly once.

## Verification
- `npx tsc --noEmit`: pass
- `npm test`: **246/246 pass** (was 239, +7)
- `npx wrangler deploy --dry-run` (offline): pass

## Security Risks Fixed
- Baseline **#11 (P1)**: any customer domain, search result or social link
  could previously direct the Worker at loopback/private/metadata endpoints
  (relevant for local dev and any non-Cloudflare deployment; on Cloudflare
  the edge egress already drops such traffic). Now refused centrally, before
  connecting, with the runtime's inherent limits documented rather than
  papered over.

## Not done (by design)
- `redirect: "manual"` crawl mode — would break the redirect-following the
  research pipeline relies on; documented instead.
- Guarding compile-time-constant vendor `fetch()` calls — no input vector;
  documented policy (limitations §2): any future DB-configurable endpoint
  must route through `fetchWithTimeout`.
- Cloudflare egress guarantees are platform facts, not code — recorded in
  the limitations doc, not asserted as application-level guarantees.
