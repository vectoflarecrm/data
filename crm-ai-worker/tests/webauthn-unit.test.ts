import { describe, expect, it } from "vitest";
import {
  WebAuthnError,
  b64uDecode,
  b64uEncode,
  decodeCbor,
  parseAuthenticatorData,
  coseKeyToJwk,
  p1363ToDer,
  rpConfig,
  generateRecoveryCodes,
  sha256HexOf,
  WEBAUTHN_RECOVERY_CODE_COUNT,
} from "../src/auth/webauthn";
import { buildAuthData, cborEncode, concat, ecdsaSignatureToP1363, makeCredential, sha256u8, utf8 } from "./webauthn-helpers";

/* Post-V2 Stage 29 — protocol primitive tests. The integration suite
 * (webauthn-flow.test.ts) walks the full login; these pin the parsing and
 * conversion layers, where a byte-level bug would otherwise hide behind a
 * generic "verification failed". */

function expectWebAuthnError(fn: () => unknown, reason: string): void {
  try {
    fn();
    expect.unreachable(`expected WebAuthnError(${reason})`);
  } catch (e) {
    expect(e).toBeInstanceOf(WebAuthnError);
    expect((e as WebAuthnError).reason).toBe(reason);
  }
}

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255, 62, 63]);
    expect(b64uEncode(bytes)).not.toMatch(/[+/=]/);
    expect([...b64uDecode(b64uEncode(bytes))]).toEqual([...bytes]);
  });
  it("rejects non-base64url input", () => {
    expectWebAuthnError(() => b64uDecode("not*valid!"), "bad_base64url");
  });
});

describe("decodeCbor (strict)", () => {
  it("decodes integers across head widths", () => {
    expect(decodeCbor(Uint8Array.of(0x00))).toBe(0);
    expect(decodeCbor(Uint8Array.of(0x17))).toBe(23);
    expect(decodeCbor(Uint8Array.of(0x18, 0xff))).toBe(255);
    expect(decodeCbor(Uint8Array.of(0x19, 0xff, 0xff))).toBe(65535);
    expect(decodeCbor(Uint8Array.of(0x1a, 0xff, 0xff, 0xff, 0xff))).toBe(4294967295);
    expect(decodeCbor(Uint8Array.of(0x20))).toBe(-1);
    expect(decodeCbor(Uint8Array.of(0x38, 0x63))).toBe(-100);
  });
  it("decodes byte strings, text, arrays, maps and simple values", () => {
    expect([...(decodeCbor(cborEncode(new Uint8Array([1, 2, 3]))) as Uint8Array)]).toEqual([1, 2, 3]);
    expect(decodeCbor(cborEncode("héllo"))).toBe("héllo");
    expect(decodeCbor(cborEncode([1, "two", new Uint8Array([3])]))).toEqual([1, "two", new Uint8Array([3])]);
    const map = decodeCbor(cborEncode(new Map([[1, "a"], ["b", true], [-2, null]]))) as Map<string | number, unknown>;
    expect(map.get(1)).toBe("a");
    expect(map.get("b")).toBe(true);
    expect(map.get(-2)).toBeNull();
  });
  it("rejects indefinite lengths, tags, floats, duplicates, truncation and trailing bytes", () => {
    expectWebAuthnError(() => decodeCbor(Uint8Array.of(0x9f, 0x01, 0xff)), "cbor_indefinite_or_reserved");
    expectWebAuthnError(() => decodeCbor(Uint8Array.of(0xc0, 0x74)), "cbor_tag_rejected");
    expectWebAuthnError(() => decodeCbor(Uint8Array.of(0xf9, 0x3c, 0x00)), "cbor_simple_rejected");
    // Raw bytes for a map with a duplicate key — the Map constructor would
    // deduplicate long before the decoder ever saw it.
    expectWebAuthnError(() => decodeCbor(Uint8Array.of(0xa2, 0x01, 0x61, 0x61, 0x01, 0x61, 0x62)), "cbor_duplicate_key");
    expectWebAuthnError(() => decodeCbor(Uint8Array.of(0x19, 0x00)), "cbor_truncated");
    expectWebAuthnError(() => decodeCbor(Uint8Array.of(0x01, 0x02)), "cbor_trailing");
    // 2-byte string declared, 1 delivered
    expectWebAuthnError(() => decodeCbor(Uint8Array.of(0x42, 0x61)), "cbor_truncated");
  });
  it("rejects invalid UTF-8 text", () => {
    expectWebAuthnError(() => decodeCbor(Uint8Array.of(0x62, 0xc3, 0x28)), "cbor_bad_utf8");
  });
});

describe("parseAuthenticatorData", () => {
  const rpIdHash = new Uint8Array(32).fill(0xab);

  it("parses flags and the unsigned 32-bit sign counter", async () => {
    const authData = buildAuthData(rpIdHash, 0x05, 1);
    const parsed = parseAuthenticatorData(authData);
    expect(parsed.userPresent).toBe(true);
    expect(parsed.userVerified).toBe(true);
    expect(parsed.attestationDataIncluded).toBe(false);
    expect(parsed.signCount).toBe(1);
    const big = buildAuthData(rpIdHash, 0x01, 0xffffffff);
    expect(parseAuthenticatorData(big).signCount).toBe(4294967295);
  });

  it("extracts attested credential data", async () => {
    const cred = await makeCredential();
    const authData = buildAuthData(rpIdHash, 0x41, 7, {
      credentialId: cred.credentialId,
      cosePublicKey: cred.coseKey,
    });
    const parsed = parseAuthenticatorData(authData);
    expect(parsed.attestationDataIncluded).toBe(true);
    expect([...parsed.attestedCredential!.credentialId]).toEqual([...cred.credentialId]);
    expect([...parsed.attestedCredential!.cosePublicKey]).toEqual([...cred.coseKey]);
    expect(parsed.signCount).toBe(7);
  });

  it("rejects truncation and out-of-range credential ids", async () => {
    const cred = await makeCredential();
    const full = buildAuthData(rpIdHash, 0x41, 0, {
      credentialId: cred.credentialId,
      cosePublicKey: cred.coseKey,
    });
    expectWebAuthnError(() => parseAuthenticatorData(full.slice(0, 36)), "authdata_too_short");
    const shortCred = buildAuthData(rpIdHash, 0x41, 0, {
      credentialId: new Uint8Array(8), // < 16
      cosePublicKey: cborEncode(new Map([[1, 2]])),
    });
    expectWebAuthnError(() => parseAuthenticatorData(shortCred), "authdata_bad_cred_id");
  });
});

describe("coseKeyToJwk", () => {
  it("converts an ES256 COSE key", async () => {
    const cred = await makeCredential();
    const { jwk, alg } = coseKeyToJwk(cred.coseKey);
    expect(alg).toBe(-7);
    expect(jwk.kty).toBe("EC");
    expect(jwk.crv).toBe("P-256");
    // The converted key must actually verify a real signature.
    const message = utf8("webauthn conversion check");
    const der = new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, cred.keyPair.privateKey,
      message.slice() as unknown as ArrayBuffer,
    ));
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, der as unknown as ArrayBuffer,
      message.slice() as unknown as ArrayBuffer,
    );
    expect(ok).toBe(true);
  });

  it("converts an RS256 COSE key", () => {
    const n = new Uint8Array(256).fill(0x33);
    const e = new Uint8Array([0x01, 0x00, 0x01]);
    const cose = cborEncode(new Map<number | Uint8Array, unknown>([[1, 3], [3, -257], [-1, n], [-2, e]]));
    const { jwk, alg } = coseKeyToJwk(cose);
    expect(alg).toBe(-257);
    expect(jwk.kty).toBe("RSA");
    expect(jwk.n).toBe(b64uEncode(n));
    expect(jwk.e).toBe(b64uEncode(e));
  });

  it("rejects unsupported key types, curves and algorithms", () => {
    expectWebAuthnError(() => coseKeyToJwk(cborEncode(new Map([[1, 1], [3, -8]]))), "cose_kty_rejected");
    // ES256 key on the wrong curve (crv 2 = secp384r1)
    expectWebAuthnError(() => coseKeyToJwk(cborEncode(new Map([[1, 2], [3, -7], [-1, 2], [-2, new Uint8Array(32)], [-3, new Uint8Array(32)]]))), "cose_curve_rejected");
    // EC key claiming RS256
    expectWebAuthnError(() => coseKeyToJwk(cborEncode(new Map([[1, 2], [3, -257], [-1, 1], [-2, new Uint8Array(32)], [-3, new Uint8Array(32)]]))), "cose_alg_rejected");
    // malformed EC coordinates
    expectWebAuthnError(() => coseKeyToJwk(cborEncode(new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(16)], [-3, new Uint8Array(32)]]))), "cose_bad_point");
  });
});

describe("p1363ToDer", () => {
  it("converts a real signature into structurally valid DER", async () => {
    const cred = await makeCredential();
    const message = utf8("signature conversion check");
    const signed = new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, cred.keyPair.privateKey,
      message.slice() as unknown as ArrayBuffer,
    ));
    const p1363 = ecdsaSignatureToP1363(signed);
    expect(p1363.length).toBe(64);
    const der = p1363ToDer(p1363);
    // SEQUENCE header, two INTEGERs whose concatenated content is exactly
    // the r||s we started from (modulo minimal-integer encoding).
    expect(der[0]).toBe(0x30);
    expect(der[1]).toBe(der.length - 2);
    expect(der[2]).toBe(0x02);
    const rLen = der[3]!;
    expect(der[4 + rLen]).toBe(0x02);
    const sLen = der[5 + rLen]!;
    expect(der.length).toBe(6 + rLen + sLen);
    // The DER integers must reassemble to the P1363 halves.
    const rBytes = der.slice(4, 4 + rLen);
    const sBytes = der.slice(6 + rLen);
    const strip = (b: Uint8Array): Uint8Array => (b[0] === 0 ? b.slice(1) : b);
    const pad = (b: Uint8Array): Uint8Array => {
      const out = new Uint8Array(32);
      out.set(b, 32 - b.length);
      return out;
    };
    expect([...pad(strip(rBytes))]).toEqual([...p1363.slice(0, 32)]);
    expect([...pad(strip(sBytes))]).toEqual([...p1363.slice(32)]);
  });
  it("pads integers with the high bit set and strips leading zeros", () => {
    const r = new Uint8Array(32).fill(0xff);
    const s = new Uint8Array(31).fill(0x01); // 31 bytes — gets left-padded by the fixture side
    const sig = concat(r, concat(new Uint8Array(1), s));
    const der = p1363ToDer(sig);
    expect(der[0]).toBe(0x30);
    expect(der[1]).toBe(der.length - 2);
    expect(der[2]).toBe(0x02);
    expect(der[3]).toBe(33); // 32 bytes + 1 sign pad
    expect(der[4]).toBe(0x00);
    expect(der[5]).toBe(0xff);
    expect(der[37]).toBe(0x02);
    expect(der[38]).toBe(31);
    expect(der[39]).toBe(0x01);
  });
  it("rejects non-64-byte input", () => {
    expectWebAuthnError(() => p1363ToDer(new Uint8Array(63)), "bad_ecdsa_signature");
  });
});

describe("rpConfig", () => {
  it("is dormant when unset or malformed", () => {
    expect(rpConfig({ DB: null as never })).toBeNull();
    expect(rpConfig({ DB: null as never, WEBAUTHN_RP_ID: "  " })).toBeNull();
    expect(rpConfig({ DB: null as never, WEBAUTHN_RP_ID: "bad rp id!" })).toBeNull();
  });
  it("builds the origin allowlist and normalizes case", () => {
    const cfg = rpConfig({
      DB: null as never,
      WEBAUTHN_RP_ID: "CRM.Example.COM",
      WEBAUTHN_RP_NAME: "CRM Panel",
      WEBAUTHN_ORIGINS: "http://localhost:8787, https://preview.example.com ,",
    })!;
    expect(cfg.rpId).toBe("crm.example.com");
    expect(cfg.rpName).toBe("CRM Panel");
    expect(cfg.origins.has("https://crm.example.com")).toBe(true);
    expect(cfg.origins.has("http://localhost:8787")).toBe(true);
    expect(cfg.origins.has("https://preview.example.com")).toBe(true);
    expect(cfg.origins.size).toBe(3);
  });
  it("defaults the RP name to the id", () => {
    const cfg = rpConfig({ DB: null as never, WEBAUTHN_RP_ID: "crm.example.com" })!;
    expect(cfg.rpName).toBe("crm.example.com");
  });
});

describe("recovery codes", () => {
  it("generates the configured count, unique, in display format", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(WEBAUTHN_RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    }
  });
  it("hashes stably", async () => {
    expect(await sha256HexOf("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
