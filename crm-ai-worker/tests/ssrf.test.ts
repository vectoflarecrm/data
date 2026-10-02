import { describe, it, expect, vi, afterEach } from "vitest";
import {
  assertPublicHttpUrl,
  OutboundUrlError,
  parseIpv6,
} from "../src/security/outbound-url";

/* Security V2 Stage 7 — SSRF guard (spec §8.4).
 *
 * Every dynamic outbound URL the crawler can be pointed at must be a public
 * http(s) origin. Loopback/private/link-local literals, localhost-style
 * names, and every non-http(s) scheme are refused before any connection. */

const REFUSED: string[] = [
  // Spec §8.4 mandatory cases
  "http://127.0.0.1",
  "http://localhost",
  "http://10.0.0.1",
  "http://192.168.1.1",
  "http://169.254.169.254",
  "http://[::1]",
  "file:///etc/passwd",
  "gopher://127.0.0.1:70/x",
  "javascript:alert(1)",
  "data:text/html,hello",
  // Private ranges, edges included
  "http://127.0.9.9",
  "http://10.255.255.255",
  "http://172.16.0.1",
  "http://172.31.255.255",
  "http://192.168.0.0",
  "http://169.254.0.1",
  "http://0.0.0.0",
  "http://0.1.2.3",
  // Hostname forms of "not public"
  "http://metadata.google.internal",
  "http://printer.local",
  "http://db.internal",
  "http://sub.localhost",
  "http://LOCALHOST/",
  "http://LocalHost:8080/x",
  // IPv6 private/special
  "http://[fc00::1]",
  "http://[fd12:3456::1]",
  "http://[fe80::1]",
  "http://[::ffff:127.0.0.1]",
  "http://[::ffff:10.0.0.1]",
  "http://[::]",
  // WHATWG-normalized IPv4 shorthands still land in the net
  "http://2130706433",      // → 127.0.0.1
  "http://0x7f.0.0.1",      // → 127.0.0.1
  "http://127.1",           // → 127.0.0.1
  // Junk
  "not a url at all",
  "http://[not::valid::ipv6::literal]",
];

const ALLOWED: string[] = [
  // Spec §8.4 mandatory case
  "https://example.com",
  // Public space, including range edges just outside the private blocks
  "http://172.32.0.1",
  "http://172.15.255.255",
  "http://8.8.8.8",
  "http://1.1.1.1:8080/",
  "https://sub.example.co.uk/path?query=1#frag",
  // Public IPv6
  "http://[2001:db8::1]",
  "http://[::ffff:8.8.8.8]",
  "http://[2606:4700::6810:85e5]/",
];

describe("stage 7: assertPublicHttpUrl", () => {
  it("refuses every spec §8.4 SSRF target", () => {
    for (const url of REFUSED) {
      expect(() => assertPublicHttpUrl(url), url).toThrow(OutboundUrlError);
    }
  });

  it("allows public http(s) URLs and returns the parsed form", () => {
    for (const url of ALLOWED) {
      const parsed = assertPublicHttpUrl(url);
      expect(parsed.href).toBeTruthy();
      expect(["http:", "https:"]).toContain(parsed.protocol);
    }
  });

  it("labels the refusal reason (operator-facing diagnostics)", () => {
    try {
      assertPublicHttpUrl("http://169.254.169.254/latest/meta-data");
      expect.unreachable();
    } catch (e) {
      expect(e instanceof OutboundUrlError).toBe(true);
      expect((e as Error).message).toContain("169.254.169.254");
      expect((e as Error).message).toContain("non-public");
    }
  });
});

describe("stage 7: IPv6 parser", () => {
  it("parses full, compressed, and v4-mapped literals", () => {
    expect(Array.from(parseIpv6("::1")!)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
    expect(Array.from(parseIpv6("::")!)).toEqual(new Array(16).fill(0));
    expect(Array.from(parseIpv6("2001:db8::8a2e:370:7334")!).slice(0, 4)).toEqual([0x20, 0x01, 0x0d, 0xb8]);
    expect(Array.from(parseIpv6("::ffff:192.168.1.1")!).slice(10)).toEqual([0xff, 0xff, 192, 168, 1, 1]);
    const full = "fe80:0000:0000:0000:0202:b3ff:fe1e:8329";
    expect(parseIpv6(full)).not.toBeNull();
  });

  it("rejects malformed literals", () => {
    expect(parseIpv6(":::")).toBeNull();
    expect(parseIpv6("1:2:3")).toBeNull(); // too few groups, no compression
    expect(parseIpv6("1:2:3:4:5:6:7:8:9")).toBeNull(); // too many
    expect(parseIpv6("::1.2.3.4.5")).toBeNull(); // bad embedded v4
    expect(parseIpv6("gggg::1")).toBeNull();
    expect(parseIpv6("example.com")).toBeNull();
  });
});

/* Integration: the guard actually sits in front of the network call. */
describe("stage 7: fetchWithTimeout refuses before connecting", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws OutboundUrlError without invoking fetch for a banned target", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const { fetchWithTimeout } = await import("../src/index");
    await expect(fetchWithTimeout("http://169.254.169.254/latest/meta-data/", 1000))
      .rejects.toThrow(OutboundUrlError);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("still reaches the network for a public URL", async () => {
    const globalFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", globalFetch);
    const { fetchWithTimeout } = await import("../src/index");
    const res = await fetchWithTimeout("https://example.com/", 1000);
    expect(res.status).toBe(200);
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).toHaveBeenCalledWith(
      "https://example.com/",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });
});
