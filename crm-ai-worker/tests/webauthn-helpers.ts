import { b64uEncode, b64uDecode } from "../src/auth/webauthn";

/* Test-side WebAuthn machinery: a minimal CBOR ENCODER (the production code
 * only decodes), authenticator-data builder, and real P-256 keypair
 * factory. Everything the src side verifies, these helpers forge — with
 * genuine WebCrypto keys, so signature paths are exercised for real
 * (Node's webcrypto is spec-identical to the Workers runtime for ECDSA
 * P-256 / SHA-256). */

export function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export async function sha256u8(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data.slice() as unknown as ArrayBuffer);
  return new Uint8Array(digest);
}

function cborHead(major: number, value: number): Uint8Array {
  if (value <= 23) return Uint8Array.of((major << 5) | value);
  if (value <= 0xff) return Uint8Array.of((major << 5) | 24, value);
  if (value <= 0xffff) return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff);
  if (value <= 0xffffffff) {
    return Uint8Array.of(
      (major << 5) | 26, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff,
    );
  }
  throw new Error("value too large for the test encoder");
}

export function cborEncode(value: unknown): Uint8Array {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("test encoder: integers only");
    if (value >= 0) return cborHead(0, value);
    return cborHead(1, -value - 1);
  }
  if (typeof value === "boolean") return Uint8Array.of(value ? 0xf5 : 0xf4);
  if (value === null) return Uint8Array.of(0xf6);
  if (typeof value === "string") {
    const bytes = utf8(value);
    return concat(cborHead(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concat(cborHead(2, value.length), value);
  if (Array.isArray(value)) {
    return concat(cborHead(4, value.length), ...value.map((v) => cborEncode(v)));
  }
  if (value instanceof Map) {
    const parts: Uint8Array[] = [cborHead(5, value.size)];
    for (const [k, v] of value) {
      parts.push(cborEncode(k), cborEncode(v));
    }
    return concat(...parts);
  }
  throw new Error("test encoder: unsupported value");
}

/** WebAuthn §6.1 layout: rpIdHash(32) | flags(1) | signCount(4 BE) | [attested]. */
export function buildAuthData(
  rpIdHash: Uint8Array,
  flags: number,
  signCount: number,
  attested?: { credentialId: Uint8Array; cosePublicKey: Uint8Array },
): Uint8Array {
  const head = new Uint8Array(37);
  head.set(rpIdHash, 0);
  head[32] = flags;
  head[33] = (signCount >>> 24) & 0xff;
  head[34] = (signCount >>> 16) & 0xff;
  head[35] = (signCount >>> 8) & 0xff;
  head[36] = signCount & 0xff;
  if (!attested) return head;
  const len = attested.credentialId.length;
  return concat(
    head,
    new Uint8Array(16), // aaguid zeros
    Uint8Array.of(len >> 8, len & 0xff),
    attested.credentialId,
    attested.cosePublicKey,
  );
}

export interface TestCredential {
  keyPair: CryptoKeyPair;
  credentialId: Uint8Array;
  credentialIdB64u: string;
  coseKey: Uint8Array;
}

/** A real P-256 keypair dressed up as a WebAuthn credential. */
export async function makeCredential(): Promise<TestCredential> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  if (!jwk.x || !jwk.y) throw new Error("export produced no coordinates");
  const coseKey = cborEncode(new Map<number | Uint8Array, unknown>([
    [1, 2], [3, -7], [-1, 1], [-2, b64uDecode(jwk.x)], [-3, b64uDecode(jwk.y)],
  ]));
  const credentialId = new Uint8Array(32);
  crypto.getRandomValues(credentialId);
  return { keyPair, credentialId, credentialIdB64u: b64uEncode(credentialId), coseKey };
}

/** WebCrypto emits DER; authenticators emit r||s. Convert for the negative
 * direction our p1363ToDer has to undo. */
export function derToP1363(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error("not a DER SEQUENCE");
  let pos = 2;
  if (der[1]! & 0x80) pos = 2 + (der[1]! & 0x7f);
  const readInt = (): Uint8Array => {
    if (der[pos] !== 0x02) throw new Error("expected DER INTEGER");
    const len = der[pos + 1]!;
    let start = pos + 2;
    pos = start + len;
    if (der[start] === 0 && len > 1) start += 1;
    const out = new Uint8Array(32);
    out.set(der.slice(start, pos), 32 - (pos - start));
    return out;
  };
  const r = readInt();
  const s = readInt();
  return concat(r, s);
}

export interface RegistrationFixture {
  client_data_json: string;
  attestation_object: string;
}

export async function buildRegistration(input: {
  credential: TestCredential;
  challenge: string;
  origin: string;
  rpId: string;
  signCount?: number;
}): Promise<RegistrationFixture> {
  const rpIdHash = await sha256u8(utf8(input.rpId));
  const authData = buildAuthData(rpIdHash, 0x45, input.signCount ?? 0, {
    credentialId: input.credential.credentialId,
    cosePublicKey: input.credential.coseKey,
  });
  const attestationObject = cborEncode(new Map<string, unknown>([
    ["fmt", "none"], ["attStmt", new Map()], ["authData", authData],
  ]));
  const clientDataJSON = JSON.stringify({
    type: "webauthn.create", challenge: input.challenge, origin: input.origin, crossOrigin: false,
  });
  return {
    client_data_json: b64uEncode(utf8(clientDataJSON)),
    attestation_object: b64uEncode(attestationObject),
  };
}

/** WebCrypto's ECDSA sign output encoding varies by runtime (Node ≥24 and
 * browsers emit raw P1363; some runtimes emit DER). Normalize to the
 * authenticator wire format (P1363). */
export function ecdsaSignatureToP1363(sig: Uint8Array): Uint8Array {
  if (sig.length === 64) return sig;
  if (sig[0] === 0x30) return derToP1363(sig);
  throw new Error(`unexpected ECDSA signature shape (${sig.length} bytes)`);
}

export interface AssertionFixture {
  credential_id: string;
  client_data_json: string;
  authenticator_data: string;
  signature: string;
}

export async function buildAssertion(input: {
  credential: TestCredential;
  challenge: string;
  origin: string;
  rpId: string;
  signCount: number;
  userVerified?: boolean;
}): Promise<AssertionFixture> {
  const rpIdHash = await sha256u8(utf8(input.rpId));
  // 0x01 = UP; 0x05 = UP | UV
  const authData = buildAuthData(rpIdHash, input.userVerified ? 0x05 : 0x01, input.signCount);
  const clientDataJSON = JSON.stringify({
    type: "webauthn.get", challenge: input.challenge, origin: input.origin, crossOrigin: false,
  });
  const message = concat(authData, await sha256u8(utf8(clientDataJSON)));
  const signed = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, input.credential.keyPair.privateKey,
    message.slice() as unknown as ArrayBuffer,
  ));
  return {
    credential_id: input.credential.credentialIdB64u,
    client_data_json: b64uEncode(utf8(clientDataJSON)),
    authenticator_data: b64uEncode(authData),
    signature: b64uEncode(ecdsaSignatureToP1363(signed)),
  };
}
