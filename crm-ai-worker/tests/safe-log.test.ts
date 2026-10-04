import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeLog, scrubSecretText } from "../src/security/safe-log";
import { REDACTED } from "../src/security/redaction";

/* Security V2 Stage 19 — logging security (spec §20).
 *
 * §20 audit: all server-side console.* sites now route through safeLog(),
 * which redacts sensitive keys (apiKey, token, privateKey, password,
 * credential, authorization, cookie + the §19 names) from structured args
 * and scrubs credential patterns (PEM, enc:v1:, Bearer) from strings. A
 * repo-wide static guard below keeps it that way.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safeLog key redaction", () => {
  it("redacts every §20 key from structured args, keeps the rest readable", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    safeLog("log", {
      apiKey: "gsk_live_x",
      token: "t",
      privateKey: "PEM",
      password: "hunter2",
      credential: "c",
      authorization: "Bearer a",
      cookie: "session=1",
      provider: "groq",
      id: 7,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0][0] as Record<string, unknown>;
    for (const key of ["apiKey", "token", "privateKey", "password", "credential", "authorization", "cookie"]) {
      expect(arg[key]).toBe(REDACTED);
    }
    expect(arg.provider).toBe("groq");
    expect(arg.id).toBe(7);
  });

  it("redacts the §19 snake_case names and camelCase variants", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    safeLog("warn", {
      api_key: "a", access_token: "b", refresh_token: "c",
      client_secret: "d", session_token: "e", cloudflare_token: "f",
      API_KEY: "g", Private_Key: "h", accessToken: "i",
      // near-misses that must NOT be redacted
      credential_type: "service_account",
      key_hint: "gsk_li…3456",
      key_index: "groq:1",
    });
    const arg = spy.mock.calls[0][0] as Record<string, unknown>;
    for (const key of ["api_key", "access_token", "refresh_token", "client_secret", "session_token", "cloudflare_token", "API_KEY", "Private_Key", "accessToken"]) {
      expect(arg[key]).toBe(REDACTED);
    }
    expect(arg.credential_type).toBe("service_account");
    expect(arg.key_hint).toBe("gsk_li…3456");
    expect(arg.key_index).toBe("groq:1");
  });

  it("recurses into nested objects and arrays without mutating the input", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const input = { row: { password: "p", keep: "k" }, list: [{ apiKey: "a" }, { ok: 1 }] };
    const snapshot = JSON.stringify(input);
    safeLog("error", input);
    expect(JSON.stringify(input)).toBe(snapshot);
    const arg = spy.mock.calls[0][0] as Record<string, unknown>;
    expect((arg.row as Record<string, unknown>).password).toBe(REDACTED);
    expect((arg.row as Record<string, unknown>).keep).toBe("k");
    const list = arg.list as Array<Record<string, unknown>>;
    expect(list[0].apiKey).toBe(REDACTED);
    expect(list[1].ok).toBe(1);
  });

  it("survives reference cycles", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const a: Record<string, unknown> = { apiKey: "x" };
    a.self = a;
    safeLog("log", a);
    const arg = spy.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.apiKey).toBe(REDACTED);
  });
});

describe("safeLog string and Error scrubbing", () => {
  it("scrubs PEM blocks, enc:v1: ciphertexts and Bearer tokens from strings", () => {
    const dirty =
      `key=-----BEGIN PRIVATE KEY-----\nMIIEsecret\n-----END PRIVATE KEY----- stored=enc:v1:deadbeef:cafe auth="Bearer ya29.a0ar"`;
    const clean = scrubSecretText(dirty);
    expect(clean).toContain("[REDACTED PEM]");
    expect(clean).toContain("enc:v1:[REDACTED]");
    expect(clean).toContain("Bearer [REDACTED]");
    expect(clean).not.toContain("MIIEsecret");
    expect(clean).not.toContain("deadbeef:cafe");
    expect(clean).not.toContain("ya29.a0ar");
    expect(scrubSecretText("plain message: rate limited 429")).toBe("plain message: rate limited 429");
  });

  it("Error args keep the name/message/stack shape, scrubbed", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("upstream rejected Bearer ya29.supersecret");
    safeLog("error", "[ctx]", err);
    const [prefix, rendered] = spy.mock.calls[0] as [string, string];
    expect(prefix).toBe("[ctx]");
    expect(rendered).toContain("Error: upstream rejected Bearer [REDACTED]");
    expect(rendered).not.toContain("ya29.supersecret");
  });

  it("delegates to the requested console level with mapped args", () => {
    for (const level of ["log", "info", "warn", "error"] as const) {
      const spy = vi.spyOn(console, level).mockImplementation(() => {});
      safeLog(level, "a", 1, { apiKey: "k" });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe("a");
      expect(spy.mock.calls[0][1]).toBe(1);
      expect((spy.mock.calls[0][2] as Record<string, unknown>).apiKey).toBe(REDACTED);
    }
  });
});

describe("repo-wide static guard (spec §20: no direct console printing)", () => {
  it("src/ contains no console.* outside safe-log.ts and the allowlisted browser-side panel line", () => {
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    const listTsFiles = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
        else if (entry.endsWith(".ts")) out.push(full);
      }
      return out;
    };
    const violations: string[] = [];
    for (const file of listTsFiles(srcDir)) {
      const rel = file.slice(srcDir.length + 1).replace(/\\/g, "/");
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/\bconsole\.(log|error|warn|info|debug)\s*\(/.test(line)) return;
        if (rel === "security/safe-log.ts") return; // the delegation module itself
        // The single browser-side panel console.log: prints a Stage 18
        // sanitized API response to the operator's own browser console.
        if (rel === "admin.ts" && line.includes("发送失败明细")) return;
        violations.push(`${rel}:${i + 1}`);
      });
    }
    expect(violations).toEqual([]);
  });
});
