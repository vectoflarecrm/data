/* Security V2 Stage 18 (spec §19) — API response redaction.
 *
 * Every JSON response the worker emits goes through jsonResponse()
 * (src/admin.ts), which runs sanitizeResponse() over the payload before
 * serialization. Defense in depth: handlers already avoid selecting secret
 * columns, but this net guarantees that the §19 key names can never reach a
 * caller — not through a future SELECT *, not through a copy-pasted row, not
 * through a nested object someone adds later.
 *
 * Redaction is by KEY NAME (spec lists the secret columns: api_key,
 * private_key, access_token, refresh_token, client_secret, password,
 * session_token, cloudflare_token), matched case- and underscore-insensitively
 * so camelCase siblings (apiKey, privateKey, ...) are caught too. Values are
 * replaced with "[REDACTED]" rather than dropped, keeping JSON shapes stable
 * for the panel.
 *
 * Because the rule is name-based, the ONE legitimate masked display value
 * (the key hint shown in the panel) moved off the forbidden name in the same
 * stage: GET /admin/api/keys now returns it as key_hint instead of api_key.
 */

/** Canonical forms (lowercased, underscores stripped) of the spec §19 keys. */
const SECRET_KEY_NAMES = new Set([
  "apikey",
  "privatekey",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "password",
  "sessiontoken",
  "cloudflaretoken",
]);

export const REDACTED = "[REDACTED]";

function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_NAMES.has(key.toLowerCase().replace(/_/g, ""));
}

/**
 * Deep-walks a JSON-ready value and replaces the value of every §19 secret
 * key name with "[REDACTED]". Returns a new structure when redaction or
 * recursion occurs; never mutates the input. Non-plain values (Date, etc.)
 * pass through untouched — JSON.stringify handles them the same way it
 * always has. A WeakSet guards against reference cycles.
 */
export function sanitizeResponse(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return REDACTED; // cycle guard
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeResponse(item, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretKeyName(key) ? REDACTED : sanitizeResponse(val, seen);
  }
  return out;
}
