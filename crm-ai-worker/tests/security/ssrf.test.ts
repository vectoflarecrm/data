import { describe, it, expect } from "vitest";
import { assertPublicHttpUrl, OutboundUrlError, parseIpv6 } from "../../src/security/outbound-url";

/* Security V2 Stage 22 (spec §23) — SSRF guard acceptance.
 *
 * Every dynamic outbound URL (crawling, research, social links) funnels
 * through assertPublicHttpUrl. This file sweeps the full refusal battery
 * end-to-end: private v4 ranges, cloud metadata, v6 forms, hostname
 * suffixes, scheme abuses, and the IPv4 shorthand/integer/hex forms the
 * WHATWG parser normalizes for us. */

const REFUSED: ReadonlyArray<[string, string]> = [
  ["http://localhost/", "localhost name"],
  ["https://127.0.0.1/", "v4 loopback"],
  ["https://127.1/", "v4 shorthand loopback"],
  ["https://0x7f.1/", "v4 hex loopback"],
  ["https://2130706433/", "v4 integer loopback"],
  ["https://0.0.0.0/", "this-host"],
  ["https://10.1.2.3/", "private 10/8"],
  ["https://172.16.0.9/", "private 172.16"],
  ["https://172.31.255.255/", "private 172.31 boundary"],
  ["https://192.168.1.1/", "private 192.168"],
  ["https://169.254.169.254/latest/meta-data/", "cloud metadata"],
  ["https://[::1]/", "v6 loopback"],
  ["https://[::]/", "v6 unspecified"],
  ["https://[fe80::1]/", "v6 link-local"],
  ["https://[fc00::1]/", "v6 unique-local"],
  ["https://[fd12:3456:789a::1]/", "v6 unique-local fd"],
  ["https://[::ffff:127.0.0.1]/", "v4-mapped v6 loopback"],
  ["https://[::ffff:10.0.0.1]/", "v4-mapped v6 private"],
  ["https://host.internal/", ".internal suffix"],
  ["https://host.local/", ".local suffix"],
  ["https://host.localhost/", ".localhost suffix"],
  ["file:///etc/passwd", "file scheme"],
  ["ftp://example.com/", "ftp scheme"],
  ["javascript:alert(1)", "javascript scheme"],
  ["data:text/html,hi", "data scheme"],
  ["not a url at all", "garbage"],
  ["", "empty"],
];

const ALLOWED: ReadonlyArray<[string, string]> = [
  ["https://example.com/", "plain https"],
  ["http://93.184.216.34/", "public v4 literal"],
  ["https://example.com:8443/path?q=1", "port and path preserved"],
  ["https://[2606:2800:220:1:248:1893:25c8:1946]/", "public v6 literal"],
];

describe("SSRF guard acceptance", () => {
  it("refuses every non-public target", () => {
    for (const [url, why] of REFUSED) {
      let threw = false;
      try {
        assertPublicHttpUrl(url);
      } catch (e) {
        threw = e instanceof OutboundUrlError;
      }
      expect(threw, `expected refusal: ${url} (${why})`).toBe(true);
    }
  });

  it("allows public targets and returns the parsed URL intact", () => {
    for (const [url, why] of ALLOWED) {
      const parsed = assertPublicHttpUrl(url);
      expect(parsed.href, `expected allowed: ${url} (${why})`).toBe(new URL(url).href);
    }
  });

  it("public-looking names that embed banned suffixes as substrings are not over-blocked", () => {
    // ".internal" must match as a SUFFIX, not a substring: a public host
    // legitimately ending in e.g. "internal-svc.example.com" is fine.
    expect(assertPublicHttpUrl("https://internal-svc.example.com/").hostname).toBe("internal-svc.example.com");
  });

  it("the IPv6 parser rejects malformed literals instead of guessing", () => {
    expect(parseIpv6("::ffff:1.2.3.4.5")).toBeNull(); // 5 octets
    expect(parseIpv6("1:2:3")).toBeNull();            // too few groups
    expect(parseIpv6("gg::1")).toBeNull();            // non-hex
    expect(parseIpv6(":::")).toBeNull();              // double compression
  });

  it("hostname case and trailing dots do not smuggle a refused host", () => {
    expect(() => assertPublicHttpUrl("https://LOCALHOST/")).toThrow(OutboundUrlError);
    // A dotted "localhost." is still the name localhost after normalization.
    expect(() => assertPublicHttpUrl("https://localhost./")).toThrow(OutboundUrlError);
  });
});
