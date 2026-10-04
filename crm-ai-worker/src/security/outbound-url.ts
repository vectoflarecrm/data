/*
 * Security V2 Stage 7 — SSRF guard for every dynamic outbound URL.
 *
 * All crawling (customer domains, search-result links, research URLs, social
 * links) funnels through fetchWithTimeout() in index.ts, which validates the
 * URL here BEFORE connecting. Hardcoded vendor endpoints (AI providers,
 * Gmail, search APIs) are compile-time constants and don't take
 * operator-influenced URLs — see docs/security-limitations.md for scope.
 *
 * Honesty about runtime limits (spec §8.2): Workers cannot resolve a hostname
 * to an IP before connecting, cannot pin the resolved IP, and fetch() follows
 * redirect chains internally — so a hostname that is public now but rebinding
 * to a private IP, or a public URL whose redirect chain hops somewhere else,
 * cannot be fully re-validated per connection at the application layer. We do
 * NOT fake that: the application-layer guard covers URL literals, and the
 * residual risk plus platform-level mitigations are documented in
 * docs/security-limitations.md.
 */

/** Thrown when a URL is refused by the outbound guard. */
export class OutboundUrlError extends Error {
  constructor(url: string, reason: string) {
    super(`Outbound URL refused (${reason}): ${url}`);
    this.name = "OutboundUrlError";
  }
}

/** Hostname suffixes that never name a public origin. */
const BANNED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal"];

/** IPv4 ranges refused: [firstOctetMask, networkPrefixBits] form below. */
function ipv4Refused(a: number, b: number, c: number, d: number): boolean {
  // 0.0.0.0/8 — "this host", treated as localhost by every stack
  if (a === 0) return true;
  // 10.0.0.0/8 — private
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local (cloud metadata services live here)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 — private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return true;
  void c; void d;
  return false;
}

/**
 * Parses an IPv6 literal (WITHOUT brackets) into its 16 bytes.
 * Returns null for anything that is not a valid IPv6 address.
 */
export function parseIpv6(host: string): Uint8Array | null {
  if (!host.includes(":")) return null;
  const sections = host.split("::");
  if (sections.length > 2) return null;

  const head: number[][] = [];
  const tail: number[][] = [];
  const parseSide = (side: string, out: number[][]): boolean => {
    if (side === "") return true;
    const groups = side.split(":");
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      // Trailing embedded IPv4 ("::ffff:127.0.0.1") — only valid as the
      // last group of the right side.
      if (g.includes(".")) {
        if (out !== tail || i !== groups.length - 1) return false;
        const octets = g.split(".");
        if (octets.length !== 4) return false;
        const bytes: number[] = [];
        for (const oct of octets) {
          if (!/^\d{1,3}$/.test(oct)) return false;
          const v = Number(oct);
          if (v > 255) return false;
          bytes.push(v);
        }
        out.push([bytes[0], bytes[1]]);
        out.push([bytes[2], bytes[3]]);
        return true;
      }
      if (!/^[0-9a-f]{1,4}$/.test(g)) return false;
      out.push([parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]);
    }
    return true;
  };

  if (!parseSide(sections[0], head)) return null;
  if (sections.length === 2 && !parseSide(sections[1], tail)) return null;

  const groups = head.length + tail.length;
  if (sections.length === 1) {
    if (groups !== 8) return null;
  } else if (groups > 7) {
    return null; // "::" must stand for at least one zero group
  }

  const bytes = new Uint8Array(16);
  let idx = 0;
  for (const [hi, lo] of head) {
    bytes[idx++] = hi;
    bytes[idx++] = lo;
  }
  if (sections.length === 2) {
    const zeros = 16 - idx - tail.length * 2;
    idx += zeros;
    for (const [hi, lo] of tail) {
      bytes[idx++] = hi;
      bytes[idx++] = lo;
    }
  }
  return bytes;
}

function ipv6Refused(bytes: Uint8Array): boolean {
  const allZero = bytes.every((b) => b === 0);
  // :: — unspecified
  if (allZero) return true;
  // ::1 — loopback (first 15 bytes zero, last byte one)
  const leadingZero = bytes.slice(0, 15).every((b) => b === 0);
  if (leadingZero && bytes[15] === 1) return true;
  // fc00::/7 — unique local
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  // fe80::/10 — link local
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  // ::ffff:0:0/96 — IPv4-mapped: judge the embedded IPv4
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0 &&
      bytes[4] === 0 && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 0 &&
      bytes[8] === 0 && bytes[9] === 0 && bytes[10] === 0xff && bytes[11] === 0xff) {
    return ipv4Refused(bytes[12], bytes[13], bytes[14], bytes[15]);
  }
  // ::ffff:0:0/96 lower half / 64:ff9b::/96 translated forms are not
  // refused here — they map to the v4 space only via NAT64, which the
  // Workers runtime does not apply to fetch().
  return false;
}

/**
 * Validates that `raw` is an http(s) URL pointing at a public origin.
 * Returns the parsed URL on success; throws OutboundUrlError otherwise.
 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundUrlError(raw, "unparseable URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OutboundUrlError(raw, `scheme ${url.protocol} not allowed`);
  }
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  // Stage 22 fix: DNS treats "localhost." the same as "localhost" (trailing
  // dots are root-marker syntax), so the root label must not smuggle a
  // refused hostname past the literal comparisons below.
  if (host === "localhost") {
    throw new OutboundUrlError(raw, "localhost refused");
  }
  for (const suffix of BANNED_HOSTNAME_SUFFIXES) {
    if (host.endsWith(suffix)) {
      throw new OutboundUrlError(raw, `hostname suffix ${suffix} refused`);
    }
  }
  // WHATWG URL keeps the brackets for IPv6 literals.
  if (host.startsWith("[") && host.endsWith("]")) {
    const bytes = parseIpv6(host.slice(1, -1));
    if (bytes === null) {
      throw new OutboundUrlError(raw, "unparseable IPv6 literal");
    }
    if (ipv6Refused(bytes)) {
      throw new OutboundUrlError(raw, "non-public IPv6 address");
    }
    return url;
  }
  // The WHATWG parser already normalizes IPv4 shorthands (127.1, 0x7f.1,
  // 2130706433 …) into dotted-quad form, so one canonical check suffices.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = Number(m[3]);
    const d = Number(m[4]);
    if (a > 255 || b > 255 || c > 255 || d > 255) {
      throw new OutboundUrlError(raw, "invalid IPv4 literal");
    }
    if (ipv4Refused(a, b, c, d)) {
      throw new OutboundUrlError(raw, "non-public IPv4 address");
    }
  }
  return url;
}
