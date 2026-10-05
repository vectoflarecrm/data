/*
 * Post-V2 Stage 29 — WebAuthn (FIDO2/passkey) second factor for admin login.
 *
 * Design shape: the master token stays factor 1 (knowledge). A user for whom
 * an active credential row exists must ALSO prove possession of the
 * authenticator (or burn a recovery code) before a session is minted. While
 * the bootstrap super_admin has an active credential the Bearer master-token
 * path is closed in admin.ts — a second factor that can be skipped by using
 * the token as a Bearer header would be decoration.
 *
 * This module owns the protocol primitives:
 *   - a STRICT CBOR decoder (definite lengths only, no floats, no tags,
 *     duplicate map keys rejected) — hand-rolled because the only CBOR we
 *     ever parse is the attestationObject envelope and the COSE public key,
 *     and a minimal decoder is easier to audit than a general one;
 *   - authenticatorData parsing (rpIdHash / flags / signCount / attested
 *     credential data);
 *   - COSE key → JWK for the two algs we accept: ES256 (-7, P-256) and
 *     RS256 (-257). Everything else is rejected — fewer algorithms, fewer
 *     footguns. Verification itself is WebCrypto, zero new dependencies;
 *   - the D1-backed challenge store (single-use, 5-minute TTL) and helpers.
 *
 * Error contract: every failure throws WebAuthnError with a stable `reason`
 * string; handlers translate that into throttle + audit + 401. The reason
 * strings never contain client-supplied bytes.
 */

export interface WebAuthnEnv {
  DB: D1Database;
  /** Relying Party ID (the effective domain, e.g. "crm.example.com").
   * Unset ⇒ the whole feature is dormant. */
  WEBAUTHN_RP_ID?: string;
  /** Human-facing RP name; defaults to the RP ID. */
  WEBAUTHN_RP_NAME?: string;
  /** Extra accepted origins (comma separated), e.g. a preview domain or
   * http://localhost:8787 for local dev. "https://<RP_ID>" is always
   * accepted. */
  WEBAUTHN_ORIGINS?: string;
}

/** Challenge / flow TTL: short on purpose — the client is a browser that
 * reacts within seconds; anything older is a replay risk, not a session. */
export const WEBAUTHN_FLOW_TTL_SECONDS = 300;
export const WEBAUTHN_RECOVERY_CODE_COUNT = 10;

export class WebAuthnError extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.reason = reason;
  }
}

/* ── base64url ─────────────────────────────────────────────────────────── */

export function b64uEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(text: string): Uint8Array {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new WebAuthnError("bad_base64url", "input is not base64url");
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function sha256Bytes(input: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(input); // digest() needs an ArrayBuffer view it can read fully
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer as ArrayBuffer);
  return new Uint8Array(digest);
}

/* ── strict CBOR decoder ─────────────────────────────────────────────────
 * Supports exactly what attestation objects and COSE keys need: major types
 * 0-5 plus true/false/null. Indefinite lengths, tags and floats are errors.
 * Duplicate map keys are errors — a COSE key that says "x" twice is not a
 * key anyone legitimately holds. */

const CBOR_MAX_NODES = 1024;
const CBOR_MAX_DEPTH = 8;
const CBOR_MAX_BYTES = 65_536;

type CborValue = number | bigint | Uint8Array | string | boolean | null | CborValue[] | Map<number | string, CborValue>;

class CborCursor {
  readonly buf: Uint8Array;
  pos: number;
  nodes: number;
  constructor(buf: Uint8Array, pos: number, nodes: number) {
    this.buf = buf;
    this.pos = pos;
    this.nodes = nodes;
  }
}

function cborReadHead(c: CborCursor): { major: number; value: number } {
  if (c.pos >= c.buf.length) throw new WebAuthnError("cbor_truncated", "CBOR head past end of buffer");
  const initial = c.buf[c.pos] ?? 0;
  c.pos += 1;
  const major = initial >> 5;
  const info = initial & 0x1f;
  if (info <= 23) return { major, value: info };
  let byteLength: number;
  if (info === 24) byteLength = 1;
  else if (info === 25) byteLength = 2;
  else if (info === 26) byteLength = 4;
  else if (info === 27) byteLength = 8;
  else throw new WebAuthnError("cbor_indefinite_or_reserved", "indefinite lengths are not accepted");
  if (c.pos + byteLength > c.buf.length) throw new WebAuthnError("cbor_truncated", "CBOR length field past end of buffer");
  let value = 0;
  for (let i = 0; i < byteLength; i++) {
    value = value * 256 + (c.buf[c.pos + i] ?? 0);
  }
  c.pos += byteLength;
  if (!Number.isSafeInteger(value)) throw new WebAuthnError("cbor_value_too_large", "CBOR integer exceeds safe range");
  return { major, value };
}

function cborReadItem(c: CborCursor, depth: number): CborValue {
  if (++c.nodes > CBOR_MAX_NODES) throw new WebAuthnError("cbor_too_complex", "CBOR node budget exceeded");
  if (depth > CBOR_MAX_DEPTH) throw new WebAuthnError("cbor_too_deep", "CBOR nesting exceeds depth cap");
  const { major, value } = cborReadHead(c);
  switch (major) {
    case 0:
      return value;
    case 1:
      return -1 - value;
    case 2: {
      if (value > CBOR_MAX_BYTES) throw new WebAuthnError("cbor_too_large", "CBOR byte string exceeds size cap");
      if (c.pos + value > c.buf.length) throw new WebAuthnError("cbor_truncated", "CBOR byte string past end of buffer");
      const out = c.buf.slice(c.pos, c.pos + value);
      c.pos += value;
      return out;
    }
    case 3: {
      if (value > CBOR_MAX_BYTES) throw new WebAuthnError("cbor_too_large", "CBOR text string exceeds size cap");
      if (c.pos + value > c.buf.length) throw new WebAuthnError("cbor_truncated", "CBOR text string past end of buffer");
      const bytes = c.buf.slice(c.pos, c.pos + value);
      c.pos += value;
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new WebAuthnError("cbor_bad_utf8", "CBOR text string is not valid UTF-8");
      }
    }
    case 4: {
      const arr: CborValue[] = [];
      for (let i = 0; i < value; i++) arr.push(cborReadItem(c, depth + 1));
      return arr;
    }
    case 5: {
      const map = new Map<number | string, CborValue>();
      for (let i = 0; i < value; i++) {
        const key = cborReadItem(c, depth + 1);
        const val = cborReadItem(c, depth + 1);
        if (typeof key !== "number" && typeof key !== "string") {
          throw new WebAuthnError("cbor_bad_map_key", "CBOR map key must be int or text");
        }
        if (map.has(key)) throw new WebAuthnError("cbor_duplicate_key", "duplicate CBOR map key rejected");
        map.set(key, val);
      }
      return map;
    }
    case 6:
      throw new WebAuthnError("cbor_tag_rejected", "CBOR tags are not accepted");
    case 7:
      if (value === 20) return false;
      if (value === 21) return true;
      if (value === 22) return null;
      throw new WebAuthnError("cbor_simple_rejected", "CBOR simple/float values are not accepted");
    default:
      throw new WebAuthnError("cbor_bad_major", "unreachable CBOR major type");
  }
}

/** Decode one CBOR item; the ENTIRE buffer must be consumed. */
export function decodeCbor(buf: Uint8Array): CborValue {
  const c = new CborCursor(buf, 0, 0);
  const value = cborReadItem(c, 0);
  if (c.pos !== buf.length) throw new WebAuthnError("cbor_trailing", "trailing bytes after CBOR item");
  return value;
}

function decodeCborAt(buf: Uint8Array, offset: number): { value: CborValue; next: number } {
  const c = new CborCursor(buf, offset, 0);
  const value = cborReadItem(c, 0);
  return { value, next: c.pos };
}

/* ── authenticatorData ─────────────────────────────────────────────────── */

export interface AttestedCredentialData {
  aaguid: Uint8Array;
  credentialId: Uint8Array;
  cosePublicKey: Uint8Array;
}

export interface AuthenticatorData {
  rpIdHash: Uint8Array;
  userPresent: boolean;
  userVerified: boolean;
  attestationDataIncluded: boolean;
  extensionsIncluded: boolean;
  signCount: number;
  attestedCredential: AttestedCredentialData | null;
}

/** WebAuthn §6.1 authenticator data layout:
 * rpIdHash(32) | flags(1) | signCount(4 BE) | [attestedCredentialData] | [extensions]. */
export function parseAuthenticatorData(bytes: Uint8Array): AuthenticatorData {
  if (bytes.length < 37) throw new WebAuthnError("authdata_too_short", "authenticator data under 37 bytes");
  const rpIdHash = bytes.slice(0, 32);
  const flags = bytes[32] ?? 0;
  const signCount = (((bytes[33] ?? 0) << 24) | ((bytes[34] ?? 0) << 16) | ((bytes[35] ?? 0) << 8) | (bytes[36] ?? 0)) >>> 0;
  const data: AuthenticatorData = {
    rpIdHash,
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    attestationDataIncluded: (flags & 0x40) !== 0,
    extensionsIncluded: (flags & 0x80) !== 0,
    signCount,
    attestedCredential: null,
  };
  let pos = 37;
  if (data.attestationDataIncluded) {
    // aaguid(16) | credentialIdLength(2 BE) | credentialId | COSE public key
    if (bytes.length < pos + 18) throw new WebAuthnError("authdata_too_short", "attested credential data truncated");
    const aaguid = bytes.slice(pos, pos + 16);
    pos += 16;
    const credLen = ((bytes[pos] ?? 0) << 8) | (bytes[pos + 1] ?? 0);
    pos += 2;
    if (credLen < 16 || credLen > 1023) throw new WebAuthnError("authdata_bad_cred_id", "credential id length outside 16..1023");
    if (bytes.length < pos + credLen) throw new WebAuthnError("authdata_too_short", "credential id truncated");
    const credentialId = bytes.slice(pos, pos + credLen);
    pos += credLen;
    const cose = decodeCborAt(bytes, pos);
    data.attestedCredential = { aaguid, credentialId, cosePublicKey: bytes.slice(pos, cose.next) };
    pos = cose.next;
  }
  if (pos > bytes.length) throw new WebAuthnError("authdata_too_short", "authenticator data truncated");
  return data;
}

/* ── COSE key → JWK ────────────────────────────────────────────────────── */

export interface CoseJwk {
  jwk: JsonWebKey;
  /** COSE algorithm identifier (-7 ES256 | -257 RS256). */
  alg: number;
}

/** COSE_Key (RFC 9052) for the two accepted algorithms. Everything else —
 * other curves, EdDSA, RSA-PSS, encryption keys — is an explicit reject. */
export function coseKeyToJwk(cose: Uint8Array): CoseJwk {
  const decoded = decodeCbor(cose);
  if (!(decoded instanceof Map)) throw new WebAuthnError("cose_not_a_map", "COSE key must be a CBOR map");
  const kty = decoded.get(1);
  const alg = decoded.get(3);
  if (typeof alg !== "number" || !Number.isInteger(alg)) throw new WebAuthnError("cose_bad_alg", "COSE alg missing");
  if (kty === 2) {
    // EC2: only P-256 (crv 1) + ES256 (-7).
    if (alg !== -7) throw new WebAuthnError("cose_alg_rejected", "only ES256 is accepted for EC keys");
    const crv = decoded.get(-1);
    const x = decoded.get(-2);
    const y = decoded.get(-3);
    if (crv !== 1) throw new WebAuthnError("cose_curve_rejected", "only P-256 is accepted");
    if (!(x instanceof Uint8Array) || x.length !== 32 || !(y instanceof Uint8Array) || y.length !== 32) {
      throw new WebAuthnError("cose_bad_point", "EC coordinates must be 32-byte strings");
    }
    return { jwk: { kty: "EC", crv: "P-256", x: b64uEncode(x), y: b64uEncode(y), ext: true }, alg };
  }
  if (kty === 3) {
    // RSA: only RS256 (-257).
    if (alg !== -257) throw new WebAuthnError("cose_alg_rejected", "only RS256 is accepted for RSA keys");
    const n = decoded.get(-1);
    const e = decoded.get(-2);
    if (!(n instanceof Uint8Array) || n.length < 32 || !(e instanceof Uint8Array) || e.length < 1 || e.length > 8) {
      throw new WebAuthnError("cose_bad_rsa", "RSA modulus/exponent malformed");
    }
    return { jwk: { kty: "RSA", n: b64uEncode(n), e: b64uEncode(e), ext: true }, alg };
  }
  throw new WebAuthnError("cose_kty_rejected", "only EC2 and RSA keys are accepted");
}

/* ── signature helpers ─────────────────────────────────────────────────── */

/** Authenticators emit ECDSA signatures as raw r||s (IEEE P1363); WebCrypto
 * wants DER SEQUENCE(INTEGER r, INTEGER s). Canonical DER: leading zero
 * bytes are stripped, then one 0x00 is prepended when the high bit is set. */
export function p1363ToDer(signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new WebAuthnError("bad_ecdsa_signature", "ES256 signature must be 64 bytes");
  const half = 32;
  const toDerInt = (bytes: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const trimmed = bytes.slice(start);
    const highBit = (trimmed[0] ?? 0) >= 0x80;
    const out = new Uint8Array(trimmed.length + (highBit ? 1 : 0));
    if (highBit) {
      out[0] = 0;
      out.set(trimmed, 1);
    } else {
      out.set(trimmed, 0);
    }
    return out;
  };
  const r = toDerInt(signature.slice(0, half));
  const s = toDerInt(signature.slice(half));
  const body = new Uint8Array(2 + r.length + 2 + s.length);
  body[0] = 0x02;
  body[1] = r.length;
  body.set(r, 2);
  body[2 + r.length] = 0x02;
  body[3 + r.length] = s.length;
  body.set(s, 4 + r.length);
  const der = new Uint8Array(2 + body.length);
  der[0] = 0x30;
  der[1] = body.length;
  der.set(body, 2);
  return der;
}

async function verifyWebCrypto(
  jwk: JsonWebKey,
  alg: number,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (alg === -7) {
    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    // The WebAuthn wire format for ES256 is ALWAYS raw IEEE P1363 (r||s,
    // 64 bytes) — but what subtle.verify expects varies by runtime: some
    // take P1363 directly, some take DER. Try both encodings of the same
    // signature; the key and message are fixed, so accepting either
    // encoding cannot weaken the check. Non-64-byte input is garbage and
    // fails both paths.
    if (signature.length !== 64) return false;
    const rawOk = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, signature.slice().buffer as ArrayBuffer,
      message.slice().buffer as ArrayBuffer,
    );
    if (rawOk) return true;
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, p1363ToDer(signature).buffer as ArrayBuffer,
      message.slice().buffer as ArrayBuffer,
    );
  }
  // -257: RS256 is a single unambiguous encoding everywhere.
  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, signature.slice().buffer as ArrayBuffer,
    message.slice().buffer as ArrayBuffer,
  );
}

/* ── RP configuration ──────────────────────────────────────────────────── */

export interface RpConfig {
  rpId: string;
  rpName: string;
  origins: Set<string>;
}

/** null when the feature is dormant (WEBAUTHN_RP_ID unset). */
export function rpConfig(env: WebAuthnEnv): RpConfig | null {
  const rpId = env.WEBAUTHN_RP_ID?.trim().toLowerCase() ?? "";
  if (!rpId || !/^[a-z0-9.-]{3,253}$/.test(rpId)) return null;
  const origins = new Set<string>([`https://${rpId}`]);
  for (const raw of (env.WEBAUTHN_ORIGINS ?? "").split(",")) {
    const origin = raw.trim();
    if (origin) origins.add(origin);
  }
  return { rpId, rpName: env.WEBAUTHN_RP_NAME?.trim() || rpId, origins };
}

/* ── client data ───────────────────────────────────────────────────────── */

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
}

function parseClientData(clientDataJsonB64u: string): ClientData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(b64uDecode(clientDataJsonB64u)));
  } catch {
    throw new WebAuthnError("bad_client_data", "clientDataJSON is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new WebAuthnError("bad_client_data", "clientDataJSON must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type !== "string" || typeof obj.challenge !== "string" || typeof obj.origin !== "string") {
    throw new WebAuthnError("bad_client_data", "clientDataJSON missing type/challenge/origin");
  }
  return { type: obj.type, challenge: obj.challenge, origin: obj.origin };
}

function checkClientData(
  clientDataJsonB64u: string,
  expectedType: "webauthn.create" | "webauthn.get",
  expectedChallengeB64u: string,
  cfg: RpConfig,
): void {
  const clientData = parseClientData(clientDataJsonB64u);
  if (clientData.type !== expectedType) {
    throw new WebAuthnError("wrong_client_data_type", `clientDataJSON.type must be ${expectedType}`);
  }
  if (clientData.challenge !== expectedChallengeB64u) {
    throw new WebAuthnError("challenge_mismatch", "clientDataJSON challenge does not match the issued flow");
  }
  if (!cfg.origins.has(clientData.origin)) {
    throw new WebAuthnError("origin_rejected", "clientDataJSON origin is not in the allowlist");
  }
}

async function assertRpIdHash(authData: AuthenticatorData, cfg: RpConfig): Promise<void> {
  const expected = await sha256Bytes(utf8Encode(cfg.rpId));
  const actual = authData.rpIdHash;
  if (expected.length !== actual.length) {
    throw new WebAuthnError("rpid_mismatch", "rpIdHash does not match the configured RP ID");
  }
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== actual[i]) throw new WebAuthnError("rpid_mismatch", "rpIdHash does not match the configured RP ID");
  }
}

/* ── D1 challenge store ────────────────────────────────────────────────── */

interface ChallengeRow {
  id: string;
  user_id: string;
  purpose: string;
  challenge: string;
  expires_at: string;
}

function sqlUtc(ms: number = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

export async function issueChallenge(
  env: WebAuthnEnv,
  userId: string,
  purpose: "register" | "assert",
): Promise<{ flowId: string; challenge: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const challenge = b64uEncode(bytes);
  const flowId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO webauthn_challenges (id, user_id, purpose, challenge, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(flowId, userId, purpose, challenge, sqlUtc(now), sqlUtc(now + WEBAUTHN_FLOW_TTL_SECONDS * 1000)).run();
  return { flowId, challenge };
}

/** Single-use consume: the conditional DELETE decides the winner, so two
 * parallel presentations of the same flow cannot both succeed. */
export async function consumeChallenge(
  env: WebAuthnEnv,
  flowId: string,
  purpose: "register" | "assert",
): Promise<{ userId: string; challenge: string }> {
  let row: ChallengeRow | null;
  try {
    row = await env.DB.prepare(
      `SELECT id, user_id, purpose, challenge, expires_at FROM webauthn_challenges WHERE id = ?`,
    ).bind(flowId).first<ChallengeRow>();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("no such table")) throw new WebAuthnError("flow_unknown", "webauthn tables missing");
    throw e;
  }
  if (!row || row.purpose !== purpose) throw new WebAuthnError("flow_unknown", "flow id unknown or wrong purpose");
  if (new Date(`${row.expires_at.replace(" ", "T")}Z`).getTime() <= Date.now()) {
    await env.DB.prepare(`DELETE FROM webauthn_challenges WHERE id = ?`).bind(flowId).run();
    throw new WebAuthnError("flow_expired", "flow expired");
  }
  const claimed = await env.DB.prepare(
    `DELETE FROM webauthn_challenges WHERE id = ? AND purpose = ?`,
  ).bind(flowId, purpose).run();
  if (Number(claimed.meta.changes ?? 0) !== 1) throw new WebAuthnError("flow_unknown", "flow already consumed");
  return { userId: row.user_id, challenge: row.challenge };
}

/** Cron vacuum for expired flows (register options a browser abandoned,
 * assert challenges that never came back). Missing table ⇒ 0. */
export async function cleanupExpiredChallenges(env: WebAuthnEnv): Promise<number> {
  try {
    const result = await env.DB.prepare(
      `DELETE FROM webauthn_challenges WHERE expires_at < ?`,
    ).bind(sqlUtc()).run();
    return result.meta.changes ?? 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("no such table")) return 0;
    throw e;
  }
}

/* ── credential queries ────────────────────────────────────────────────── */

export interface CredentialRow {
  id: string;
  user_id: string;
  public_key_jwk: string;
  alg: number;
  sign_count: number;
  transports: string | null;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** Active (non-revoked) credential count for a user — the single flag that
 * decides whether 2FA applies. Missing table ⇒ 0 (pre-migration window,
 * feature dormant). */
export async function countActiveCredentials(env: WebAuthnEnv, userId: string): Promise<number> {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ? AND revoked_at IS NULL`,
    ).bind(userId).first<{ n: number }>();
    return row?.n ?? 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("no such table")) return 0;
    throw e;
  }
}

export async function listCredentialDescriptors(
  env: WebAuthnEnv,
  userId: string,
): Promise<Array<{ id: string; transports: string | null }>> {
  try {
    const rows = await env.DB.prepare(
      `SELECT id, transports FROM webauthn_credentials WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at`,
    ).bind(userId).all<{ id: string; transports: string | null }>();
    return rows.results ?? [];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("no such table")) return [];
    throw e;
  }
}

/* ── high-level verification ───────────────────────────────────────────── */

export interface RegistrationResult {
  credentialId: string;
  jwk: JsonWebKey;
  alg: number;
  signCount: number;
  transports: string[];
}

/** Verify a `navigator.credentials.create()` result against a register flow.
 * Attestation must be "none" — we asked for none, and unpacking attestation
 * statements is a trust-decision surface this panel does not need. */
export async function verifyRegistrationResponse(
  cfg: RpConfig,
  env: WebAuthnEnv,
  input: {
    userId: string;
    expectedChallenge: string;
    clientDataJson: string;
    attestationObject: string;
    transports?: string[];
  },
): Promise<RegistrationResult> {
  checkClientData(input.clientDataJson, "webauthn.create", input.expectedChallenge, cfg);
  let attObj: CborValue;
  try {
    attObj = decodeCbor(b64uDecode(input.attestationObject));
  } catch (e) {
    if (e instanceof WebAuthnError) throw e;
    throw new WebAuthnError("bad_attestation_object", "attestationObject is not valid CBOR");
  }
  if (!(attObj instanceof Map)) throw new WebAuthnError("bad_attestation_object", "attestationObject must be a CBOR map");
  const fmt = attObj.get("fmt");
  const attStmt = attObj.get("attStmt");
  const authDataBytes = attObj.get("authData");
  if (fmt !== "none") throw new WebAuthnError("attestation_fmt_rejected", 'attestation format must be "none"');
  if (!(attStmt instanceof Map) || attStmt.size !== 0) {
    throw new WebAuthnError("attestation_fmt_rejected", '"none" attestation must carry an empty attStmt');
  }
  if (!(authDataBytes instanceof Uint8Array)) {
    throw new WebAuthnError("bad_attestation_object", "authData missing from attestationObject");
  }
  const authData = parseAuthenticatorData(authDataBytes);
  await assertRpIdHash(authData, cfg);
  if (!authData.userPresent) throw new WebAuthnError("user_not_present", "UP flag not set");
  if (!authData.attestationDataIncluded || !authData.attestedCredential) {
    throw new WebAuthnError("no_credential", "attested credential data missing");
  }
  const credentialId = authData.attestedCredential.credentialId;
  // Idempotent re-registration of the same credential id is a client bug or
  // a replay; the INSERT would fail on the PK anyway — reject with a reason.
  const existing = await env.DB.prepare(
    `SELECT id FROM webauthn_credentials WHERE id = ?`,
  ).bind(b64uEncode(credentialId)).first<{ id: string }>();
  if (existing) throw new WebAuthnError("credential_already_registered", "credential id already exists");
  const cose = coseKeyToJwk(authData.attestedCredential.cosePublicKey);
  const transports = (input.transports ?? []).filter((t) =>
    t === "usb" || t === "nfc" || t === "ble" || t === "internal" || t === "hybrid" || t === "smart-card" || t === "cable",
  );
  return {
    credentialId: b64uEncode(credentialId),
    jwk: cose.jwk,
    alg: cose.alg,
    signCount: authData.signCount,
    transports,
  };
}

export interface AssertionResult {
  credentialId: string;
  newSignCount: number;
  userVerified: boolean;
}

/** Verify a `navigator.credentials.get()` result against an assert flow.
 * Sign-count policy: reject when both counters are nonzero and the new one
 * did not advance (clone signal). Authenticators that always report 0
 * (most passkeys) never trip the check, and a 0 report never lowers a
 * previously stored counter. */
export async function verifyAssertionResponse(
  cfg: RpConfig,
  env: WebAuthnEnv,
  input: {
    userId: string;
    credentialId: string;
    expectedChallenge: string;
    clientDataJson: string;
    authenticatorData: string;
    signature: string;
  },
): Promise<AssertionResult> {
  let cred: CredentialRow | null;
  try {
    cred = await env.DB.prepare(
      `SELECT id, user_id, public_key_jwk, alg, sign_count, revoked_at FROM webauthn_credentials
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    ).bind(input.credentialId, input.userId).first<CredentialRow>();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("no such table")) throw new WebAuthnError("credential_unknown", "webauthn tables missing");
    throw e;
  }
  if (!cred) throw new WebAuthnError("credential_unknown", "credential not registered for this user");
  checkClientData(input.clientDataJson, "webauthn.get", input.expectedChallenge, cfg);
  const authDataBytes = b64uDecode(input.authenticatorData);
  const authData = parseAuthenticatorData(authDataBytes);
  await assertRpIdHash(authData, cfg);
  if (!authData.userPresent) throw new WebAuthnError("user_not_present", "UP flag not set");
  if (authData.signCount !== 0 && cred.sign_count !== 0 && authData.signCount <= cred.sign_count) {
    throw new WebAuthnError("clone_suspected", "signature counter did not advance");
  }
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(cred.public_key_jwk) as JsonWebKey;
  } catch {
    throw new WebAuthnError("stored_key_corrupt", "stored public key is not parseable");
  }
  // The signed bytes are authenticatorData || SHA-256(clientDataJSON).
  const clientHash = await sha256Bytes(b64uDecode(input.clientDataJson));
  const message = new Uint8Array(authDataBytes.length + clientHash.length);
  message.set(authDataBytes, 0);
  message.set(clientHash, authDataBytes.length);
  const ok = await verifyWebCrypto(jwk, cred.alg, message, b64uDecode(input.signature));
  if (!ok) throw new WebAuthnError("bad_signature", "assertion signature invalid");
  return {
    credentialId: cred.id,
    newSignCount: authData.signCount > cred.sign_count ? authData.signCount : cred.sign_count,
    userVerified: authData.userVerified,
  };
}

/* ── recovery codes ────────────────────────────────────────────────────── */

/** 10 codes, 64 bits each, shown ONCE. Hex groups read well over the phone
 * and are paste-safe; the throttle covers brute force (2^64 does not need
 * help). Only the SHA-256 of each code is stored. */
export function generateRecoveryCodes(count: number = WEBAUTHN_RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    codes.push(`${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`);
  }
  return codes;
}

export async function sha256HexOf(text: string): Promise<string> {
  const digest = await sha256Bytes(utf8Encode(text));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}
