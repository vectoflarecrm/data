/* Security V2 Stage 19 (spec §20) — logging security.
 *
 * `wrangler tail` makes the Worker log a production data surface: every
 * console.* call lands there. The §20 audit found 8 server-side call sites
 * (all reviewed clean — they log provider names, ids, migration events and
 * error messages, never credential material), but a single future
 * `console.log("got key", row)` would leak a stored secret to whoever can
 * read the tail. safeLog() is the mandatory replacement: it redacts
 * sensitive KEYS from structured arguments and scrubs well-known credential
 * patterns from free-form strings, then delegates to the console level.
 *
 * Key redaction uses the §20 list (apiKey, token, privateKey, password,
 * credential, authorization, cookie) plus the §19 response-redaction names
 * (api_key, access_token, refresh_token, client_secret, session_token,
 * cloudflare_token), matched case- and underscore-insensitively.
 *
 * A repo-wide static guard in tests/safe-log.test.ts enforces that no new
 * direct console.* call appears in src/ outside this module (the one
 * browser-side panel console.log is allowlisted — it prints a Stage 18
 * sanitized API response to the operator's own browser console).
 */

import { REDACTED } from "./redaction";

export type SafeLogLevel = "log" | "info" | "warn" | "error";

/** Canonical forms (lowercased, underscores stripped) of §20 keys + the §19 set. */
const SENSITIVE_LOG_KEYS = new Set([
  // spec §20 list
  "apikey", "token", "privatekey", "password", "credential", "authorization", "cookie",
  // spec §19 names, same canonical form
  "accesstoken", "refreshtoken", "clientsecret", "sessiontoken", "cloudflaretoken",
]);

function isSensitiveLogKey(key: string): boolean {
  return SENSITIVE_LOG_KEYS.has(key.toLowerCase().replace(/_/g, ""));
}

/** Secret shapes that can end up inside free-form strings: service-account
 * PEMs, our encrypted-credential prefix, and Authorization header values. */
const STRING_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PEM]"],
  [/enc:v1:[A-Za-z0-9+/=:]+/g, "enc:v1:[REDACTED]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
];

export function scrubSecretText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of STRING_SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Deep redacting walk for structured log arguments. Never mutates the input;
 * a WeakSet guards against reference cycles. */
function redactStructured(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return REDACTED;
  seen.add(value as object);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => redactStructured(item, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveLogKey(key) ? REDACTED : redactStructured(val, seen);
  }
  return out;
}

function redactArg(arg: unknown): unknown {
  if (typeof arg === "string") return scrubSecretText(arg);
  if (arg instanceof Error) {
    // Keep the name/message/stack shape developers rely on, scrubbed. A raw
    // provider error body or a stray header value inside either gets caught
    // by the string patterns; the object walk below is for everything else.
    const head = scrubSecretText(`${arg.name}: ${arg.message}`);
    const stack = arg.stack ? `\n${scrubSecretText(arg.stack)}` : "";
    return `${head}${stack}`;
  }
  if (typeof arg === "object" && arg !== null) return redactStructured(arg, new WeakSet());
  return arg;
}

/** Drop-in console replacement with automatic redaction. Server-side code
 * must log through this instead of console.* — enforced by a static test. */
export function safeLog(level: SafeLogLevel, ...args: unknown[]): void {
  console[level](...args.map(redactArg));
}
