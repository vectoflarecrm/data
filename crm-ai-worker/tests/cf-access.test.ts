import { describe, it, expect, beforeEach } from "vitest";
import { b64uEncode } from "../src/auth/webauthn";
import {
  checkCloudflareAccess,
  verifyAccessToken,
  resetAccessJwksCache,
  type AccessJwk,
} from "../src/security/cf-access";
import { makeDb, makeEnv, call } from "./security/_helpers";

/* Post-V2 Stage 35 — Cloudflare Access perimeter.
 *
 * The fixtures mint real JWTs with WebCrypto (the same primitives the
 * worker uses), so the signature paths are exercised end to end: EC P-256
 * (compact-JWS signatures are raw r||s, exactly what WebCrypto ECDSA
 * verify expects) and RSA. The pure core (verifyAccessToken) is tested
 * against every claim/signature failure class; the gate (checkCloudflareAccess)
 * against activation semantics, caching, the bounded key-rotation refetch
 * and fail-closed fetch errors — with an injected fetcher, so no test ever
 * touches the network. Integration tests pin the admin-surface behavior:
 * perimeter rejections carry the standard response shape (JSON detail +
 * X-Request-ID + security headers) and half-configured envs fail loud. */

const encoder = new TextEncoder();
const TEAM = "acme";
const AUD = "aud-tag-123";
const NOW_MS = 1_700_000_000_000;

let clock = NOW_MS;

interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: AccessJwk;
}

async function makeEs256Key(kid: string): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { kid, kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, alg: "ES256" },
  };
}

async function makeRs256Key(kid: string): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { kid, privateKey: pair.privateKey, jwk: { kid, kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256" } };
}

function b64uJson(value: unknown): string {
  return b64uEncode(encoder.encode(JSON.stringify(value)));
}

async function signToken(
  key: SigningKey,
  claims: Record<string, unknown>,
  alg: "ES256" | "RS256" = "ES256",
): Promise<string> {
  const header = { alg, typ: "JWT", kid: key.kid };
  const signingInput = `${b64uJson(header)}.${b64uJson(claims)}`;
  let signature: ArrayBuffer;
  if (alg === "ES256") {
    signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, encoder.encode(signingInput));
  } else {
    signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key.privateKey, encoder.encode(signingInput));
  }
  return `${signingInput}.${b64uEncode(new Uint8Array(signature))}`;
}

function defaultClaims(nowMs: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const nowSec = Math.floor(nowMs / 1000);
  return {
    iss: `https://${TEAM}.cloudflareaccess.com`,
    sub: "user@example.com",
    aud: AUD,
    iat: nowSec,
    nbf: nowSec,
    exp: nowSec + 600,
    common: { email: "user@example.com", name: "Ops User" },
    ...overrides,
  };
}

function jwksResponse(keys: AccessJwk[], status = 200): Response {
  return new Response(JSON.stringify({ keys }), { status, headers: { "Content-Type": "application/json" } });
}

function accessRequest(token?: string): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set("Cf-Access-Jwt-Assertion", token);
  return new Request("https://worker.example/admin/api/customers", { headers });
}

beforeEach(() => {
  resetAccessJwksCache();
  clock = NOW_MS;
});

/* ── Pure core: verifyAccessToken ──────────────────────────────────────── */

describe("stage 35: verifyAccessToken", () => {
  it("accepts a valid ES256 token", async () => {
    const key = await makeEs256Key("key-1");
    const token = await signToken(key, defaultClaims(NOW_MS));
    const check = await verifyAccessToken(token, [key.jwk], TEAM, AUD, NOW_MS);
    expect(check).toEqual({ ok: true });
  });

  it("accepts a valid RS256 token", async () => {
    const key = await makeRs256Key("key-rsa");
    const token = await signToken(key, defaultClaims(NOW_MS), "RS256");
    const check = await verifyAccessToken(token, [key.jwk], TEAM, AUD, NOW_MS);
    expect(check).toEqual({ ok: true });
  });

  it("accepts an aud claim expressed as an array", async () => {
    const key = await makeEs256Key("key-1");
    const token = await signToken(key, defaultClaims(NOW_MS, { aud: ["other-app", AUD] }));
    const check = await verifyAccessToken(token, [key.jwk], TEAM, AUD, NOW_MS);
    expect(check).toEqual({ ok: true });
  });

  it("accepts a token within the 60s expiry skew", async () => {
    const key = await makeEs256Key("key-1");
    const claims = defaultClaims(NOW_MS);
    claims.exp = Math.floor(NOW_MS / 1000) - 30;
    const token = await signToken(key, claims);
    const check = await verifyAccessToken(token, [key.jwk], TEAM, AUD, NOW_MS);
    expect(check).toEqual({ ok: true });
  });

  it("rejects a tampered payload under the original signature", async () => {
    const key = await makeEs256Key("key-1");
    const token = await signToken(key, defaultClaims(NOW_MS));
    const [h, , s] = token.split(".");
    const forgedPayload = b64uJson(defaultClaims(NOW_MS, { sub: "attacker@example.com" }));
    const check = await verifyAccessToken(`${h}.${forgedPayload}.${s}`, [key.jwk], TEAM, AUD, NOW_MS);
    expect(check).toEqual({ ok: false, reason: "bad signature" });
  });

  it("rejects a signature made by a different key than the declared kid", async () => {
    const declared = await makeEs256Key("key-1");
    const imposter = await makeEs256Key("key-2");
    const claims = defaultClaims(NOW_MS);
    const forgedHeader = b64uJson({ alg: "ES256", typ: "JWT", kid: "key-1" });
    const signingInput = `${forgedHeader}.${b64uJson(claims)}`;
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, imposter.privateKey, encoder.encode(signingInput));
    const token = `${signingInput}.${b64uEncode(new Uint8Array(sig))}`;
    const check = await verifyAccessToken(token, [declared.jwk], TEAM, AUD, NOW_MS);
    expect(check).toEqual({ ok: false, reason: "bad signature" });
  });

  it("rejects a wrong audience", async () => {
    const key = await makeEs256Key("key-1");
    const token = await signToken(key, defaultClaims(NOW_MS, { aud: "some-other-app" }));
    const check = await verifyAccessToken(token, [key.jwk], TEAM, AUD, NOW_MS);
    expect(check).toEqual({ ok: false, reason: "aud mismatch" });
  });

  it("rejects a wrong issuer", async () => {
    const key = await makeEs256Key("key-1");
    const token = await signToken(key, defaultClaims(NOW_MS, { iss: "https://evil.cloudflareaccess.com" }));
    const check = await verifyAccessToken(token, [key.jwk], TEAM, AUD, NOW_MS);
    expect(check).toEqual({ ok: false, reason: "issuer mismatch" });
  });

  it("rejects an expired token beyond the skew window", async () => {
    const key = await makeEs256Key("key-1");
    const claims = defaultClaims(NOW_MS);
    claims.exp = Math.floor(NOW_MS / 1000) - 120;
    const token = await signToken(key, claims);
    const check = await verifyAccessToken(token, [key.jwk], TEAM, AUD, NOW_MS);
    expect(check).toEqual({ ok: false, reason: "token expired" });
  });

  it("rejects a not-yet-valid token beyond the skew window", async () => {
    const key = await makeEs256Key("key-1");
    const claims = defaultClaims(NOW_MS);
    claims.nbf = Math.floor(NOW_MS / 1000) + 120;
    const token = await signToken(key, claims);
    const check = await verifyAccessToken(token, [key.jwk], TEAM, AUD, NOW_MS);
    expect(check).toEqual({ ok: false, reason: "token not yet valid" });
  });

  it("rejects an unknown kid", async () => {
    const key = await makeEs256Key("key-1");
    const token = await signToken(key, defaultClaims(NOW_MS));
    const otherKey = { ...(await makeEs256Key("key-rotated")).jwk };
    const check = await verifyAccessToken(token, [otherKey], TEAM, AUD, NOW_MS);
    expect(check).toEqual({ ok: false, reason: "unknown kid" });
  });

  it("rejects alg none and non-JWT shapes", async () => {
    const key = await makeEs256Key("key-1");
    const claims = defaultClaims(NOW_MS);
    // alg=none with a non-empty (garbage) signature segment so the shape
    // guard passes and the algorithm allowlist is what rejects it.
    const noneToken = `${b64uJson({ alg: "none", typ: "JWT", kid: "key-1" })}.${b64uJson(claims)}.c2ln`;
    expect(await verifyAccessToken(noneToken, [key.jwk], TEAM, AUD, NOW_MS)).toEqual({ ok: false, reason: "unsupported alg" });
    expect(await verifyAccessToken("not-a-jwt", [key.jwk], TEAM, AUD, NOW_MS)).toEqual({ ok: false, reason: "malformed token" });
    expect(await verifyAccessToken("a.b", [key.jwk], TEAM, AUD, NOW_MS)).toEqual({ ok: false, reason: "malformed token" });
    const notJson = `${b64uEncode(encoder.encode("not json"))}.${b64uJson(claims)}.c2ln`;
    expect(await verifyAccessToken(notJson, [key.jwk], TEAM, AUD, NOW_MS)).toEqual({ ok: false, reason: "malformed token" });
  });

  it("rejects a key whose declared kid exists but with the wrong key type", async () => {
    const ecKey = await makeEs256Key("key-1");
    const rsaKey = await makeRs256Key("key-1");
    const token = await signToken(ecKey, defaultClaims(NOW_MS));
    const check = await verifyAccessToken(token, [rsaKey.jwk], TEAM, AUD, NOW_MS);
    expect(check).toEqual({ ok: false, reason: "key type mismatch" });
  });
});

/* ── The gate: activation, cache, rotation refetch, fail-closed ─────────── */

describe("stage 35: checkCloudflareAccess gate", () => {
  it("is dormant when neither var is set", async () => {
    const result = await checkCloudflareAccess(accessRequest(), {});
    expect(result).toEqual({ outcome: "allow" });
  });

  it("fails loud (500) on a half-configured env", async () => {
    expect((await checkCloudflareAccess(accessRequest(), { CF_ACCESS_TEAM: TEAM })).status).toBe(500);
    expect((await checkCloudflareAccess(accessRequest(), { CF_ACCESS_AUD: AUD })).status).toBe(500);
  });

  it("fails loud (500) on an invalid team name", async () => {
    const result = await checkCloudflareAccess(accessRequest("x"), { CF_ACCESS_TEAM: "bad team", CF_ACCESS_AUD: AUD });
    expect(result.status).toBe(500);
  });

  it("rejects a missing assertion with 401 (no JWKS fetch needed)", async () => {
    let fetches = 0;
    const fetchFn = (async () => { fetches += 1; return jwksResponse([]); }) as unknown as typeof fetch;
    const result = await checkCloudflareAccess(accessRequest(), { CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD }, { fetchFn, now: () => clock });
    expect(result.status).toBe(401);
    expect(fetches).toBe(0);
  });

  it("allows a valid assertion via the injected JWKS endpoint", async () => {
    const key = await makeEs256Key("key-1");
    const token = await signToken(key, defaultClaims(NOW_MS));
    const fetchFn = (async () => jwksResponse([key.jwk])) as unknown as typeof fetch;
    const result = await checkCloudflareAccess(accessRequest(token), { CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD }, { fetchFn, now: () => clock });
    expect(result).toEqual({ outcome: "allow" });
  });

  it("caches the JWKS — a second request survives a broken endpoint", async () => {
    const key = await makeEs256Key("key-1");
    const token = await signToken(key, defaultClaims(NOW_MS));
    let fetches = 0;
    const fetchFn = (async () => {
      fetches += 1;
      if (fetches === 1) return jwksResponse([key.jwk]);
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const env = { CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD };
    expect((await checkCloudflareAccess(accessRequest(token), env, { fetchFn, now: () => clock })).outcome).toBe("allow");
    clock += 30_000;
    expect((await checkCloudflareAccess(accessRequest(token), env, { fetchFn, now: () => clock })).outcome).toBe("allow");
    expect(fetches).toBe(1);
  });

  it("fails closed (401) when the JWKS endpoint is unreachable on first contact", async () => {
    const key = await makeEs256Key("key-1");
    const token = await signToken(key, defaultClaims(NOW_MS));
    const fetchFn = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const result = await checkCloudflareAccess(accessRequest(token), { CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD }, { fetchFn, now: () => clock });
    expect(result.status).toBe(401);
    expect(result.reason).toBe("jwks unavailable");
  });

  it("fails closed (401) when the endpoint answers garbage", async () => {
    const key = await makeEs256Key("key-1");
    const token = await signToken(key, defaultClaims(NOW_MS));
    const fetchFn = (async () => new Response("welcome to nginx", { status: 200 })) as unknown as typeof fetch;
    const result = await checkCloudflareAccess(accessRequest(token), { CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD }, { fetchFn, now: () => clock });
    expect(result.status).toBe(401);
  });

  it("recovers from a key rotation via one bounded refetch", async () => {
    const oldKey = await makeEs256Key("key-old");
    const newKey = await makeEs256Key("key-new");
    const oldToken = await signToken(oldKey, defaultClaims(NOW_MS));
    const newToken = await signToken(newKey, defaultClaims(NOW_MS));
    let fetches = 0;
    const fetchFn = (async () => {
      fetches += 1;
      // First fetch predates the rotation: only the old key is served.
      return jwksResponse(fetches === 1 ? [oldKey.jwk] : [oldKey.jwk, newKey.jwk]);
    }) as unknown as typeof fetch;
    const env = { CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD };
    const deps = { fetchFn, now: () => clock };

    // Prime the cache; a new-key token hits "unknown kid" and the immediate
    // refetch is blocked by the min-interval bound (one fetch so far).
    expect((await checkCloudflareAccess(accessRequest(oldToken), env, deps)).outcome).toBe("allow");
    const blocked = await checkCloudflareAccess(accessRequest(newToken), env, deps);
    expect(blocked.status).toBe(401);
    expect(blocked.reason).toBe("unknown kid");
    expect(fetches).toBe(1);

    // Once the last fetch is older than the bound, the rotation refetch
    // happens and the new key validates.
    clock += 61_000;
    expect((await checkCloudflareAccess(accessRequest(newToken), env, deps)).outcome).toBe("allow");
    expect(fetches).toBe(2);
  });

  it("does not hammer the endpoint when the cache is fresh", async () => {
    const key = await makeEs256Key("key-1");
    const garbageKidToken = `${b64uJson({ alg: "ES256", typ: "JWT", kid: "nope" })}.${b64uJson(defaultClaims(NOW_MS))}.c2ln`;
    let fetches = 0;
    const fetchFn = (async () => { fetches += 1; return jwksResponse([key.jwk]); }) as unknown as typeof fetch;
    const env = { CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD };
    const deps = { fetchFn, now: () => clock };
    expect((await checkCloudflareAccess(accessRequest("totally-not-a-jwt"), env, deps)).status).toBe(401);
    expect((await checkCloudflareAccess(accessRequest(garbageKidToken), env, deps)).status).toBe(401);
    expect((await checkCloudflareAccess(accessRequest(garbageKidToken), env, deps)).status).toBe(401);
    expect(fetches).toBe(1);
  });
});

/* ── Integration: the admin surface ─────────────────────────────────────── */

describe("stage 35: admin surface integration", () => {
  it("rejects /admin API calls with the standard response shape when the perimeter is on", async () => {
    const db = makeDb();
    const env = { ...makeEnv(db), CF_ACCESS_TEAM: TEAM, CF_ACCESS_AUD: AUD };
    const res = await call(env, "/admin/api/customers");
    expect(res.status).toBe(401);
    const body = JSON.parse(await res.text()) as { detail?: string };
    expect(body.detail).toBe("Cloudflare Access authentication required");
    // The rejection leaves through the same response pipeline: request id
    // for log correlation plus the standard security headers.
    expect(res.headers.get("X-Request-ID")).toBeTruthy();
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("fails loud (500) through the admin surface on a half-configured env", async () => {
    const db = makeDb();
    const env = { ...makeEnv(db), CF_ACCESS_TEAM: TEAM };
    const res = await call(env, "/admin/api/customers");
    expect(res.status).toBe(500);
    const body = JSON.parse(await res.text()) as { detail?: string };
    expect(body.detail).toBe("CF Access configuration error");
  });

  it("leaves the login page untouched when the perimeter is off", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const res = await call(env, "/admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });
});
