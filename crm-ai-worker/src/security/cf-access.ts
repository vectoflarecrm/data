import { b64uDecode } from "../auth/webauthn";
import { safeLog } from "./safe-log";

/* Post-V2 Stage 35 — Cloudflare Access perimeter, enforced in code.
 *
 * Cloudflare Access can sit in front of the admin surface as a zero-trust
 * identity layer: the edge authenticates the caller against the IdP and
 * injects a signed JWT (`Cf-Access-Jwt-Assertion`) into every request it
 * forwards. Edge enforcement alone, however, is dashboard state — one
 * mis-scoped or deleted Access application silently removes the perimeter.
 * This module makes the perimeter deploy state: when CF_ACCESS_TEAM +
 * CF_ACCESS_AUD are configured, every /admin request must carry an
 * assertion that cryptographically verifies against the team's JWKS
 * (https://<team>.cloudflareaccess.com/cdn-cgi/access/certs) with the
 * application's AUD pinned. Fail-closed on every error class.
 *
 * No new dependencies: standard compact-JWS parsing plus WebCrypto, the
 * same primitives the Stage 29 WebAuthn verifier uses (b64uDecode is
 * shared). safeLog only, never an audit row — perimeter rejections are
 * internet-scanner noise, the same class as the Stage 29 policy.
 *
 * The gate is additive: with both vars unset nothing changes. Exactly one
 * var set is a misconfiguration and fails LOUD (500) rather than silently
 * disabling the perimeter — the same fail-safe direction as the retention
 * knobs. */

export interface CfAccessEnv {
  CF_ACCESS_TEAM?: string;
  CF_ACCESS_AUD?: string;
}

/** A signing key from the team's certs endpoint, narrowed to what the
 * verifier supports (EC P-256 / RSA). Unknown-key-type entries are skipped
 * at parse time. */
export interface AccessJwk {
  kid: string;
  kty: string;
  alg?: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
}

export type AccessCheck = { ok: true } | { ok: false; reason: string };

export type AccessGateResult =
  | { outcome: "allow" }
  | { outcome: "reject"; status: 401 | 500; detail: string; reason: string };

export interface CfAccessDeps {
  /** Injectable for tests; the real gate uses global fetch (a
   * compile-time-constant Cloudflare endpoint, not user input). */
  fetchFn?: typeof fetch;
  now?: () => number;
}

const CLOCK_SKEW_MS = 60_000;
const JWKS_CACHE_TTL_MS = 60 * 60_000;
/** A garbage-kid flood must not hammer the certs endpoint: an unknown kid
 * only triggers a refetch when the last fetch is older than this. */
const JWKS_MIN_REFETCH_INTERVAL_MS = 60_000;
const JWKS_FETCH_TIMEOUT_MS = 10_000;
const TEAM_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/* ── JSON primitives (strict, no any) ─────────────────────────────────────── */

function parseJsonRecord(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* ── Token verification (pure core) ───────────────────────────────────────── */

/** Verifies a compact JWS against the team's keys. Checks: 3-part shape,
 * ES256/RS256 only (alg "none" and friends rejected), issuer pinned to the
 * team, audience pinned to the configured AUD (string or array claim),
 * exp/nbf with a 60s clock-skew allowance, signature over the exact
 * `header.payload` bytes. Returns a machine-readable reason on failure —
 * for the operator log only, never to the caller. */
export async function verifyAccessToken(
  token: string,
  keys: readonly AccessJwk[],
  team: string,
  aud: string,
  nowMs: number,
): Promise<AccessCheck> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, reason: "malformed token" };
  }
  const [headerB64, payloadB64, sigB64] = parts;

  let header: Record<string, unknown> | null = null;
  let payload: Record<string, unknown> | null = null;
  try {
    header = parseJsonRecord(new TextDecoder().decode(b64uDecode(headerB64)));
    payload = parseJsonRecord(new TextDecoder().decode(b64uDecode(payloadB64)));
  } catch {
    return { ok: false, reason: "malformed token" };
  }
  if (!header || !payload) return { ok: false, reason: "malformed token" };

  const alg = asString(header.alg);
  if (alg !== "ES256" && alg !== "RS256") return { ok: false, reason: "unsupported alg" };
  const kid = asString(header.kid);
  if (!kid) return { ok: false, reason: "missing kid" };

  const issuer = `https://${team}.cloudflareaccess.com`;
  if (asString(payload.iss) !== issuer) return { ok: false, reason: "issuer mismatch" };
  const audClaim = payload.aud;
  const audOk =
    asString(audClaim) === aud ||
    (Array.isArray(audClaim) && audClaim.some((v) => v === aud));
  if (!audOk) return { ok: false, reason: "aud mismatch" };

  const nowSec = nowMs / 1000;
  const exp = asNumber(payload.exp);
  if (exp === null || exp <= nowSec - CLOCK_SKEW_MS / 1000) {
    return { ok: false, reason: "token expired" };
  }
  const nbf = asNumber(payload.nbf);
  if (nbf !== null && nbf > nowSec + CLOCK_SKEW_MS / 1000) {
    return { ok: false, reason: "token not yet valid" };
  }

  const key = keys.find((k) => k.kid === kid);
  if (!key) return { ok: false, reason: "unknown kid" };
  if (key.kty !== (alg === "ES256" ? "EC" : "RSA")) return { ok: false, reason: "key type mismatch" };
  const keyAlg = key.alg ? asString(key.alg) : null;
  if (keyAlg !== null && keyAlg !== alg) return { ok: false, reason: "key alg mismatch" };
  if (alg === "ES256" && (key.crv !== "P-256" || !asString(key.x) || !asString(key.y))) {
    return { ok: false, reason: "unsupported key parameters" };
  }
  if (alg === "RS256" && (!asString(key.n) || !asString(key.e))) {
    return { ok: false, reason: "unsupported key parameters" };
  }

  let signature: Uint8Array;
  try {
    signature = b64uDecode(sigB64);
  } catch {
    return { ok: false, reason: "bad signature encoding" };
  }

  const message = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  try {
    let valid: boolean;
    if (alg === "ES256") {
      const cryptoKey = await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: key.x, y: key.y },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      // Compact-JWS ES256 signatures are raw r||s (P1363), which is exactly
      // what WebCrypto's ECDSA verify expects — the DER wrangling the
      // WebAuthn verifier needs does not apply here.
      valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, cryptoKey, signature, message);
    } else {
      const cryptoKey = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: key.n, e: key.e },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      valid = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, cryptoKey, signature, message);
    }
    return valid ? { ok: true } : { ok: false, reason: "bad signature" };
  } catch {
    return { ok: false, reason: "verification error" };
  }
}

/* ── JWKS fetch + cache ───────────────────────────────────────────────────── */

interface CachedJwks {
  team: string;
  keys: AccessJwk[];
  fetchedAt: number;
}

let cachedJwks: CachedJwks | null = null;
let lastFetchAttemptAt = 0;

/** Module state is per-isolate and tests need isolation. */
export function resetAccessJwksCache(): void {
  cachedJwks = null;
  lastFetchAttemptAt = 0;
}

function parseJwks(text: string): AccessJwk[] | null {
  const root = parseJsonRecord(text);
  if (!root) return null;
  const rawKeys = root.keys;
  if (!Array.isArray(rawKeys)) return null;
  const keys: AccessJwk[] = [];
  for (const entry of rawKeys) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const kid = asString(record.kid);
    const kty = asString(record.kty);
    if (!kid || (kty !== "EC" && kty !== "RSA")) continue;
    const key: AccessJwk = { kid, kty };
    const alg = asString(record.alg);
    if (alg) key.alg = alg;
    const crv = asString(record.crv);
    if (crv) key.crv = crv;
    const x = asString(record.x);
    if (x) key.x = x;
    const y = asString(record.y);
    if (y) key.y = y;
    const n = asString(record.n);
    if (n) key.n = n;
    const e = asString(record.e);
    if (e) key.e = e;
    keys.push(key);
  }
  return keys.length > 0 ? keys : null;
}

async function fetchAccessJwks(team: string, fetchFn: typeof fetch): Promise<AccessJwk[]> {
  const url = `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JWKS_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetchFn(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!resp.ok) throw new Error(`certs endpoint returned HTTP ${resp.status}`);
    const keys = parseJwks(await resp.text());
    if (!keys) throw new Error("certs endpoint returned no usable keys");
    return keys;
  } finally {
    clearTimeout(timer);
  }
}

async function verifyWithCache(
  token: string,
  team: string,
  aud: string,
  fetchFn: typeof fetch,
  nowMs: number,
  allowCache: boolean,
): Promise<AccessCheck> {
  if (allowCache && cachedJwks !== null && cachedJwks.team === team && nowMs - cachedJwks.fetchedAt < JWKS_CACHE_TTL_MS) {
    return verifyAccessToken(token, cachedJwks.keys, team, aud, nowMs);
  }
  if (!allowCache && nowMs - lastFetchAttemptAt < JWKS_MIN_REFETCH_INTERVAL_MS) {
    return { ok: false, reason: "unknown kid" };
  }
  lastFetchAttemptAt = nowMs;
  try {
    const keys = await fetchAccessJwks(team, fetchFn);
    cachedJwks = { team, keys, fetchedAt: nowMs };
    return verifyAccessToken(token, keys, team, aud, nowMs);
  } catch (e) {
    // Fail-closed: an unreachable certs endpoint means no request can
    // prove its assertion, so none gets through.
    safeLog("error", "[admin:cf-access] JWKS fetch failed; failing closed", e);
    return { ok: false, reason: "jwks unavailable" };
  }
}

/* ── The gate ─────────────────────────────────────────────────────────────── */

/** The admin surface calls this before origin guard, auth and RBAC. Null
 * semantics are "allow"; a reject result carries an HTTP status, a generic
 * caller-facing detail (no internals) and a specific log reason (already
 * safeLogged here — the caller only renders). */
export async function checkCloudflareAccess(
  request: Request,
  env: CfAccessEnv,
  deps: CfAccessDeps = {},
): Promise<AccessGateResult> {
  const team = env.CF_ACCESS_TEAM?.trim() ?? "";
  const aud = env.CF_ACCESS_AUD?.trim() ?? "";
  if (!team && !aud) return { outcome: "allow" };
  if (!team || !aud) {
    safeLog("error", "[admin:cf-access] misconfigured: CF_ACCESS_TEAM and CF_ACCESS_AUD must be set together");
    return { outcome: "reject", status: 500, detail: "CF Access configuration error", reason: "partially configured" };
  }
  if (!TEAM_NAME_PATTERN.test(team)) {
    safeLog("error", "[admin:cf-access] misconfigured: CF_ACCESS_TEAM is not a valid team subdomain");
    return { outcome: "reject", status: 500, detail: "CF Access configuration error", reason: "invalid team name" };
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    safeLog("warn", "[admin:cf-access] rejected: missing Cf-Access-Jwt-Assertion");
    return { outcome: "reject", status: 401, detail: "Cloudflare Access authentication required", reason: "missing assertion" };
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  let check = await verifyWithCache(token, team, aud, fetchFn, now(), true);
  if (!check.ok && check.reason === "unknown kid") {
    // The cached JWKS may predate a key rotation — one bounded refetch.
    check = await verifyWithCache(token, team, aud, fetchFn, now(), false);
  }
  if (!check.ok) {
    safeLog("warn", `[admin:cf-access] rejected: ${check.reason}`);
    return { outcome: "reject", status: 401, detail: "Cloudflare Access authentication required", reason: check.reason };
  }
  return { outcome: "allow" };
}
