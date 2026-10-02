# Security Limitations — honest notes on what this Worker CANNOT guarantee

Security V2 deliberately refuses to *fake* guarantees the runtime cannot
deliver. This file records each such gap, the residual risk, and the
mitigation that does exist. Items here are accepted risks, reviewed per
stage; none of them is silently ignored.

## 1. SSRF: no DNS resolution before connect (DNS rebinding) — Stage 7

`src/security/outbound-url.ts` validates the **URL literal** (scheme,
hostname, IP literal) before every dynamic fetch, and `fetchWithTimeout`
enforces it centrally. What it cannot do:

- **Resolve-then-pin.** The Workers runtime offers no `resolve()` API;
  `fetch()` resolves and connects atomically. A hostname that is public at
  validation time could, in theory, be re-resolved (rebinding) to a private
  address at connect time. The application layer cannot observe or prevent
  that second resolution.
- **Per-hop redirect validation.** `fetch()` follows redirect chains
  internally (up to 20 hops). A public URL may 302 to `http://169.254.169.254`
  and the application sees only the final response. Setting `redirect:
  "manual"` would break legitimate `http→https` / `www` redirects that the
  crawler depends on, so it is not used.

**Why the residual risk is bounded in production:**
- Cloudflare Workers execute on Cloudflare's edge network. Their egress
  cannot reach RFC1918 space, loopback, or link-local addresses — there is no
  route from a Worker to `10.0.0.1`, `192.168.x.x`, `127.0.0.1`, or
  `169.254.169.254` (cloud metadata services are not addressable from
  Workers). This is a platform property, not an application guarantee; it is
  the "Cloudflare 官方支持的防护方式" the spec points to.
- The URL-literal guard independently blocks the straightforward cases
  (including localhost-style names, `*.local`/`*.internal`, IPv4 shorthands,
  IPv6 specials) for local development and any non-Cloudflare deployment of
  this code.

**Bottom line:** rebinding/redirect-hop SSRF from inside Workers has no
known practical target — the network layer drops the traffic. The guard
remains in place so the property does not depend on the platform alone.

## 2. Outbound scope: compile-time-constant vendor endpoints are not guarded — Stage 7

Direct `fetch()` calls to hardcoded vendor endpoints (Google AI/Gmail,
Groq/Cerebras/Mistral/DeepSeek/Zhipu/NVIDIA/OpenRouter/AMD, Firecrawl,
search APIs) do not route through the URL guard. Their URLs are source-code
constants that no operator input influences, so there is no injection vector;
if that ever changes (e.g. a DB-configurable base URL), the call site must
switch to `fetchWithTimeout` / `assertPublicHttpUrl`.

## 3. Per-isolate rate limiting — Stage 16 (planned)

The RPM limiter is per-isolate. A distributed limiter behind a
`RateLimiter` abstraction is scheduled as Stage 16; until then, bursts
across isolates can exceed configured RPM toward providers.

## 4. `style-src-attr 'unsafe-inline'` in the admin CSP — Stage 5

Panel HTML uses `style=""` attributes extensively; attributes cannot carry a
nonce. CSS injection cannot execute script, and every dynamic `innerHTML`
sink in the panels is escaped, so the accepted residual risk is defacement
of the panel by an already-authenticated operator. Full removal requires a
class-based restyle.
