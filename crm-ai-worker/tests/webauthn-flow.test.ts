import { describe, expect, it } from "vitest";
import { cleanupExpiredChallenges } from "../src/auth/webauthn";
import { makeDb, makeEnv, bearer, call, mintSession, sha256Hex, TOKEN, BASE } from "./security/_helpers";
import { buildAssertion, buildRegistration, makeCredential, type TestCredential } from "./webauthn-helpers";

/* Post-V2 Stage 29 — full-stack WebAuthn acceptance: enrollment, the Bearer
 * lockout, the two-step login, the failure matrix, recovery codes and the
 * cross-user RBAC surface. Signatures are REAL (P-256 via WebCrypto); the
 * fixtures forge authenticator responses, the src side verifies them for
 * real — a pass here means the crypto path actually works end to end. */

const RP_ID = "worker.example"; // matches _helpers BASE → origin checks pass
const ORIGIN = BASE;

function env2(db: unknown, opts: { rp?: boolean } = {}): ReturnType<typeof makeEnv> {
  const env = makeEnv(db as never);
  if (opts.rp !== false) env.WEBAUTHN_RP_ID = RP_ID;
  return env;
}

interface AuditRow {
  action: string;
  actor_user_id: string | null;
  metadata_json: string | null;
}

function auditRows(db: any): AuditRow[] {
  return db.prepare("SELECT action, actor_user_id, metadata_json FROM audit_logs ORDER BY created_at, rowid").all() as AuditRow[];
}

function sessionTokenFrom(res: Response): string {
  const cookie = res.headers.get("Set-Cookie") ?? "";
  const m = /crm_session=([^;]+)/.exec(cookie);
  if (!m) throw new Error(`no session cookie on response: ${cookie}`);
  return m[1]!;
}

/** Once the first credential is registered the Bearer bootstrap path is
 * CLOSED — later enrollments must ride a session cookie for u_admin. */
async function adminCookie(db: any): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  db.prepare(
    `INSERT INTO admin_sessions (id, user_id, token_hash, role, created_at, expires_at)
     VALUES (?, 'u_admin', ?, 'super_admin', '2026-01-01 00:00:00', '2099-01-01 00:00:00')`,
  ).run(`s_admin_${crypto.randomUUID()}`, await sha256Hex(token));
  return token;
}

async function enroll(
  env: ReturnType<typeof makeEnv>,
  opts: { name?: string; auth?: Record<string, string> } = {},
): Promise<{ credential: TestCredential; recoveryCodes: string[] | null; body: Record<string, unknown> }> {
  const auth = opts.auth ?? bearer();
  const optionsRes = await call(env, "/admin/api/auth/webauthn/register/options", {
    method: "POST", headers: auth, body: JSON.stringify({ name: opts.name ?? "Test Key" }),
  });
  expect(optionsRes.status).toBe(200);
  const options = await optionsRes.json() as {
    flow_id: string;
    public_key: { challenge: string; rp: { id: string }; user: { id: string }; attestation: string };
  };
  const credential = await makeCredential();
  const fixture = await buildRegistration({ credential, challenge: options.public_key.challenge, origin: ORIGIN, rpId: RP_ID });
  const verifyRes = await call(env, "/admin/api/auth/webauthn/register/verify", {
    method: "POST", headers: auth,
    body: JSON.stringify({ flow_id: options.flow_id, ...fixture, transports: ["internal"], name: opts.name ?? "Test Key" }),
  });
  expect(verifyRes.status).toBe(200);
  const body = await verifyRes.json() as Record<string, unknown>;
  return { credential, recoveryCodes: (body.recovery_codes as string[] | null) ?? null, body };
}

async function loginMfa(env: ReturnType<typeof makeEnv>): Promise<{ flowId: string; challenge: string; allowIds: string[] }> {
  const res = await call(env, "/admin/api/auth/login", { method: "POST", body: JSON.stringify({ token: TOKEN }) });
  expect(res.status).toBe(202);
  const body = await res.json() as { status: string; flow_id: string; public_key: { challenge: string; rpId: string; allowCredentials: Array<{ id: string }> } };
  expect(body.status).toBe("mfa_required");
  return { flowId: body.flow_id, challenge: body.public_key.challenge, allowIds: body.public_key.allowCredentials.map((c) => c.id) };
}

async function assertLogin(
  env: ReturnType<typeof makeEnv>,
  credential: TestCredential,
  flow: { flowId: string; challenge: string },
  opts: { origin?: string; rpId?: string; signCount?: number; credentialId?: string } = {},
): Promise<Response> {
  const fixture = await buildAssertion({
    credential,
    challenge: flow.challenge,
    origin: opts.origin ?? ORIGIN,
    rpId: opts.rpId ?? RP_ID,
    signCount: opts.signCount ?? 1,
  });
  return call(env, "/admin/api/auth/mfa/assert", {
    method: "POST",
    body: JSON.stringify({ flow_id: flow.flowId, ...fixture, credential_id: opts.credentialId ?? fixture.credential_id }),
  });
}

describe("webauthn enrollment", () => {
  it("issues creation options bound to the configured RP", async () => {
    const db = makeDb();
    const env = env2(db);
    const res = await call(env, "/admin/api/auth/webauthn/register/options", { method: "POST", headers: bearer(), body: "{}" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, any>;
    expect(body.public_key.rp).toEqual({ id: RP_ID, name: RP_ID });
    expect(body.public_key.user.id).toBe("u_admin");
    expect(body.public_key.attestation).toBe("none");
    expect(body.public_key.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }]);
    expect(body.public_key.challenge).toMatch(/^[\w-]{43}$/);
    expect(body.public_key.excludeCredentials).toEqual([]);
  });

  it("verifies a real registration and mints one-time recovery codes", async () => {
    const db = makeDb();
    const env = env2(db);
    const { credential, recoveryCodes } = await enroll(env, { name: "My YubiKey" });
    expect(recoveryCodes).toHaveLength(10);
    const row = db.prepare("SELECT public_key_jwk, alg, name, transports, revoked_at FROM webauthn_credentials WHERE user_id = 'u_admin'").get() as Record<string, unknown>;
    expect(row.name).toBe("My YubiKey");
    expect(row.alg).toBe(-7);
    expect(row.transports).toBe("internal");
    expect(row.revoked_at).toBeNull();
    const jwk = JSON.parse(row.public_key_jwk as string);
    expect(jwk.kty).toBe("EC");
    // The audit row names the credential and the actor.
    const rows = auditRows(db);
    expect(rows.some((r) => r.action === "WEBAUTHN_REGISTER" && r.actor_user_id === "u_admin" &&
      (JSON.parse(r.metadata_json ?? "{}") as Record<string, unknown>).first_credential === true)).toBe(true);
    void credential;
  });

  it("second enrollment: no new recovery codes, first credential excluded", async () => {
    const db = makeDb();
    const env = env2(db);
    const first = await enroll(env);
    // 2FA is now active — Bearer is closed, so the second enrollment rides
    // a u_admin session cookie (exactly what the security panel does).
    const cookie = await adminCookie(db);
    const auth = { Cookie: `crm_session=${cookie}` };
    const optionsRes = await call(env, "/admin/api/auth/webauthn/register/options", { method: "POST", headers: auth, body: "{}" });
    const options = await optionsRes.json() as { public_key: { excludeCredentials: Array<{ id: string }> } };
    expect(options.public_key.excludeCredentials.map((c) => c.id)).toContain(first.credential.credentialIdB64u);
    const second = await enroll(env, { name: "Backup key", auth });
    expect(second.recoveryCodes).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM webauthn_recovery_codes WHERE user_id = 'u_admin' AND used_at IS NULL").get()!.n).toBe(10);
  });

  it("rejects a duplicate credential id with a reason", async () => {
    const db = makeDb();
    const env = env2(db);
    const { credential } = await enroll(env);
    const auth = { Cookie: `crm_session=${await adminCookie(db)}` };
    // Re-register the SAME credential through a fresh flow.
    const optionsRes = await call(env, "/admin/api/auth/webauthn/register/options", { method: "POST", headers: auth, body: "{}" });
    const options = await optionsRes.json() as { flow_id: string; public_key: { challenge: string } };
    const fixture = await buildRegistration({ credential, challenge: options.public_key.challenge, origin: ORIGIN, rpId: RP_ID });
    const res = await call(env, "/admin/api/auth/webauthn/register/verify", {
      method: "POST", headers: auth, body: JSON.stringify({ flow_id: options.flow_id, ...fixture }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, unknown>).reason).toBe("credential_already_registered");
  });

  it("rejects a foreign origin", async () => {
    const db = makeDb();
    const env = env2(db);
    const optionsRes = await call(env, "/admin/api/auth/webauthn/register/options", { method: "POST", headers: bearer(), body: "{}" });
    const options = await optionsRes.json() as { flow_id: string; public_key: { challenge: string } };
    const credential = await makeCredential();
    const fixture = await buildRegistration({ credential, challenge: options.public_key.challenge, origin: "https://evil.example", rpId: RP_ID });
    const res = await call(env, "/admin/api/auth/webauthn/register/verify", {
      method: "POST", headers: bearer(), body: JSON.stringify({ flow_id: options.flow_id, ...fixture }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, unknown>).reason).toBe("origin_rejected");
  });

  it('rejects a non-"none" attestation statement', async () => {
    const db = makeDb();
    const env = env2(db);
    const optionsRes = await call(env, "/admin/api/auth/webauthn/register/options", { method: "POST", headers: bearer(), body: "{}" });
    const options = await optionsRes.json() as { flow_id: string; public_key: { challenge: string } };
    // fmt "packed" with a non-empty attStmt.
    const { buildAuthData, cborEncode, sha256u8, utf8 } = await import("./webauthn-helpers");
    const credential = await makeCredential();
    const authData = buildAuthData(await sha256u8(utf8(RP_ID)), 0x45, 0, {
      credentialId: credential.credentialId, cosePublicKey: credential.coseKey,
    });
    const attObj = cborEncode(new Map([["fmt", "packed"], ["attStmt", new Map([["alg", -7]])], ["authData", authData]]));
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.public_key.challenge, origin: ORIGIN })).toString("base64url");
    const res = await call(env, "/admin/api/auth/webauthn/register/verify", {
      method: "POST", headers: bearer(),
      body: JSON.stringify({ flow_id: options.flow_id, client_data_json: clientData, attestation_object: Buffer.from(attObj).toString("base64url") }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, unknown>).reason).toBe("attestation_fmt_rejected");
  });

  it("503s when WEBAUTHN_RP_ID is not configured; 401s unauthenticated", async () => {
    const db = makeDb();
    const res = await call(env2(db, { rp: false }), "/admin/api/auth/webauthn/register/options", { method: "POST", headers: bearer(), body: "{}" });
    expect(res.status).toBe(503);
    const res2 = await call(env2(db), "/admin/api/auth/webauthn/register/options", { method: "POST", body: "{}" });
    expect(res2.status).toBe(401);
  });

  it("a user cannot complete another user's registration flow", async () => {
    const db = makeDb();
    const env = env2(db);
    const readonlyCookie = await mintSession(db, "readonly");
    // readonly user starts a flow…
    const optionsRes = await call(env, "/admin/api/auth/webauthn/register/options", {
      method: "POST", headers: { Cookie: `crm_session=${readonlyCookie}` }, body: "{}",
    });
    const options = await optionsRes.json() as { flow_id: string; public_key: { challenge: string; user: { id: string } } };
    expect(options.public_key.user.id).toBe("u_readonly");
    // …but the bootstrap super_admin (Bearer) tries to complete it.
    const credential = await makeCredential();
    const fixture = await buildRegistration({ credential, challenge: options.public_key.challenge, origin: ORIGIN, rpId: RP_ID });
    const res = await call(env, "/admin/api/auth/webauthn/register/verify", {
      method: "POST", headers: bearer(), body: JSON.stringify({ flow_id: options.flow_id, ...fixture }),
    });
    expect(res.status).toBe(403);
    expect(auditRows(db).some((r) => r.action === "ACCESS_DENIED")).toBe(true);
  });
});

describe("webauthn bearer lockout", () => {
  it("closes the Bearer path while 2FA is active, reopens when the last credential goes", async () => {
    const db = makeDb();
    const env = env2(db);
    const { credential } = await enroll(env);
    // Bearer is dead now.
    const denied = await call(env, "/admin/api/auth/me", { headers: bearer() });
    expect(denied.status).toBe(401);
    // Complete an MFA login to hold a session cookie.
    const flow = await loginMfa(env);
    const assertRes = await assertLogin(env, credential, flow);
    expect(assertRes.status).toBe(200);
    const cookie = sessionTokenFrom(assertRes);
    // Self-service revocation of the last credential through the session.
    const listRes = await call(env, "/admin/api/auth/webauthn/credentials", { headers: { Cookie: `crm_session=${cookie}` } });
    const list = await listRes.json() as { credentials: Array<{ id: string }> };
    const delRes = await call(env, `/admin/api/auth/webauthn/credentials/${encodeURIComponent(list.credentials[0]!.id)}`, {
      method: "DELETE", headers: { Cookie: `crm_session=${cookie}` },
    });
    expect(delRes.status).toBe(200);
    expect((await delRes.json() as Record<string, unknown>).two_factor_active).toBe(false);
    // Bearer is back: 2FA off means the token alone authenticates again.
    const ok = await call(env, "/admin/api/auth/me", { headers: bearer() });
    expect(ok.status).toBe(200);
  });
});

describe("webauthn two-step login", () => {
  it("token login returns 202 + assert challenge, assert mints a working session", async () => {
    const db = makeDb();
    const env = env2(db);
    const { credential } = await enroll(env);
    const flow = await loginMfa(env);
    expect(flow.allowIds).toEqual([credential.credentialIdB64u]);
    const res = await assertLogin(env, credential, flow, { signCount: 1 });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.user_id).toBe("u_admin");
    expect(body.role).toBe("super_admin");
    // The cookie actually authenticates.
    const cookie = sessionTokenFrom(res);
    const me = await call(env, "/admin/api/auth/me", { headers: { Cookie: `crm_session=${cookie}` } });
    expect(me.status).toBe(200);
    // sign_count advanced, last_used_at recorded, audit row written via:mfa.
    const row = db.prepare("SELECT sign_count, last_used_at FROM webauthn_credentials WHERE id = ?").get(credential.credentialIdB64u) as Record<string, unknown>;
    expect(row.sign_count).toBe(1);
    expect(row.last_used_at).not.toBeNull();
    expect(auditRows(db).some((r) => r.action === "LOGIN" && r.metadata_json?.includes('"mfa"'))).toBe(true);
    // The flow is single-use: replaying it fails even with a valid signature.
    const replay = await assertLogin(env, credential, flow, { signCount: 2 });
    expect(replay.status).toBe(401);
  });

  it("form login renders the MFA step page instead of a redirect", async () => {
    const db = makeDb();
    const env = env2(db);
    await enroll(env);
    const res = await call(env, "/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(TOKEN)}`,
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="mfaData"');
    // The payload block is single-stringified JSON with "<" escaped.
    expect(html).toContain('"flow_id":"');
    expect(html).toContain('"challenge":"');
  });

  it.each([
    ["foreign origin", { origin: "https://evil.example", reason: "origin_rejected" }],
    ["stale challenge from another flow", { reason: "challenge_mismatch" }],
    ["unknown credential id", { credentialId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", reason: "credential_unknown" }],
    ["wrong RP id hash", { rpId: "other.example", reason: "rpid_mismatch" }],
  ] as const)("assert fails closed: %s", async (_name, opts) => {
    const db = makeDb();
    const env = env2(db);
    const { credential } = await enroll(env);
    const flow = await loginMfa(env);
    let staleChallenge = flow.challenge;
    if (opts.reason === "challenge_mismatch") {
      const other = await loginMfa(env);
      staleChallenge = other.challenge; // valid b64u, wrong flow
    }
    const fixture = await buildAssertion({
      credential,
      challenge: staleChallenge,
      origin: "origin" in opts ? (opts.origin as string) : ORIGIN,
      rpId: "rpId" in opts ? (opts.rpId as string) : RP_ID,
      signCount: 1,
    });
    const res = await call(env, "/admin/api/auth/mfa/assert", {
      method: "POST",
      body: JSON.stringify({
        flow_id: flow.flowId,
        ...fixture,
        credential_id: "credentialId" in opts ? (opts.credentialId as string) : fixture.credential_id,
      }),
    });
    expect(res.status).toBe(401);
    expect(auditRows(db).some((r) => r.action === "LOGIN_FAILED" &&
      (JSON.parse(r.metadata_json ?? "{}") as Record<string, unknown>).reason === opts.reason)).toBe(true);
    // The failure counted toward the throttle.
    expect((db.prepare("SELECT failures FROM admin_login_attempts WHERE scope = 'ip'").get() as Record<string, unknown>).failures).toBeGreaterThan(0);
  });

  it("assert fails closed: tampered signature", async () => {
    const db = makeDb();
    const env = env2(db);
    const { credential } = await enroll(env);
    const flow = await loginMfa(env);
    const fixture = await buildAssertion({ credential, challenge: flow.challenge, origin: ORIGIN, rpId: RP_ID, signCount: 1 });
    const tampered = fixture.signature.slice(0, -4) + (fixture.signature.endsWith("AAAA") ? "BBBB" : "AAAA");
    const res = await call(env, "/admin/api/auth/mfa/assert", {
      method: "POST", body: JSON.stringify({ flow_id: flow.flowId, ...fixture, signature: tampered }),
    });
    expect(res.status).toBe(401);
  });

  it("expired flows answer 410; malformed bodies answer 400", async () => {
    const db = makeDb();
    const env = env2(db);
    await enroll(env);
    db.prepare(
      `INSERT INTO webauthn_challenges (id, user_id, purpose, challenge, created_at, expires_at)
       VALUES ('flow-expired', 'u_admin', 'assert', 'Y2hhbGxlbmdl', '2026-01-01 00:00:00', '2026-01-01 00:00:01')`,
    ).run();
    const expired = await call(env, "/admin/api/auth/mfa/assert", {
      method: "POST",
      body: JSON.stringify({
        flow_id: "flow-expired", credential_id: "x", client_data_json: "e30",
        authenticator_data: "e30", signature: "e30",
      }),
    });
    expect(expired.status).toBe(410);
    const badBody = await call(env, "/admin/api/auth/mfa/assert", { method: "POST", body: JSON.stringify({ flow_id: "flow-expired" }) });
    expect(badBody.status).toBe(400);
    const badJson = await call(env, "/admin/api/auth/mfa/assert", { method: "POST", body: "not-json" });
    expect(badJson.status).toBe(400);
  });

  it("signature counter regression looks like a clone; a zero counter (passkey) never does", async () => {
    const db = makeDb();
    const env = env2(db);
    const { credential } = await enroll(env);
    // Seed a counter as if the credential had been used at count 5.
    db.prepare("UPDATE webauthn_credentials SET sign_count = 5 WHERE id = ?").run(credential.credentialIdB64u);
    const flow = await loginMfa(env);
    const regression = await assertLogin(env, credential, flow, { signCount: 3 });
    expect(regression.status).toBe(401);
    expect(auditRows(db).some((r) => (JSON.parse(r.metadata_json ?? "{}") as Record<string, unknown>).reason === "clone_suspected")).toBe(true);
    // A passkey reporting 0 does not trip the check and never lowers the floor.
    const flow2 = await loginMfa(env);
    const zero = await assertLogin(env, credential, flow2, { signCount: 0 });
    expect(zero.status).toBe(200);
    const row = db.prepare("SELECT sign_count FROM webauthn_credentials WHERE id = ?").get(credential.credentialIdB64u) as Record<string, unknown>;
    expect(row.sign_count).toBe(5);
  });

  it("assert fails closed for a disabled user even with a valid signature", async () => {
    const db = makeDb();
    const env = env2(db);
    const { credential } = await enroll(env);
    db.prepare("UPDATE admin_users SET enabled = 0 WHERE id = 'u_admin'").run();
    const flow = await loginMfa(env);
    const res = await assertLogin(env, credential, flow, { signCount: 1 });
    expect(res.status).toBe(401);
  });

  it("five failed asserts lock the caller out with 429", async () => {
    const db = makeDb();
    const env = env2(db);
    const { credential } = await enroll(env);
    // A successful token login CLEARS the ip throttle bucket, so all five
    // flows must be issued up front — then the failures land back-to-back.
    const flows: Array<{ flowId: string; challenge: string }> = [];
    for (let i = 0; i < 5; i++) flows.push(await loginMfa(env));
    for (const flow of flows) {
      const res = await assertLogin(env, credential, flow, { signCount: 1, credentialId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
      expect(res.status).toBe(401);
    }
    const res = await call(env, "/admin/api/auth/mfa/assert", {
      method: "POST",
      body: JSON.stringify({ flow_id: "whatever", credential_id: "x", client_data_json: "e30", authenticator_data: "e30", signature: "e30" }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
  });

  it("login mints directly when no credential is on file (feature dormant per-user)", async () => {
    const db = makeDb();
    const env = env2(db);
    const res = await call(env, "/admin/api/auth/login", { method: "POST", body: JSON.stringify({ token: TOKEN }) });
    expect(res.status).toBe(200);
    sessionTokenFrom(res);
  });

  it("unconfigured RP: login is direct even with credential rows present", async () => {
    const db = makeDb();
    const envRp = env2(db);
    await enroll(envRp);
    const envDormant = env2(db, { rp: false });
    const res = await call(envDormant, "/admin/api/auth/login", { method: "POST", body: JSON.stringify({ token: TOKEN }) });
    expect(res.status).toBe(200);
    sessionTokenFrom(res);
  });
});

describe("webauthn recovery codes", () => {
  async function loginRecovery(env: ReturnType<typeof makeEnv>, code: string): Promise<Response> {
    const flow = await loginMfa(env);
    return call(env, "/admin/api/auth/mfa/recovery", { method: "POST", body: JSON.stringify({ flow_id: flow.flowId, code }) });
  }

  it("a recovery code mints a session and burns itself", async () => {
    const db = makeDb();
    const env = env2(db);
    const { recoveryCodes } = await enroll(env);
    const code = recoveryCodes![0]!;
    const res = await loginRecovery(env, code);
    expect(res.status).toBe(200);
    sessionTokenFrom(res);
    const row = db.prepare(
      "SELECT used_at FROM webauthn_recovery_codes WHERE user_id = 'u_admin' AND used_at IS NOT NULL",
    ).get() as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(auditRows(db).some((r) => r.action === "LOGIN" && r.metadata_json?.includes('"recovery"'))).toBe(true);
    // The same code cannot be used twice.
    const again = await loginRecovery(env, code);
    expect(again.status).toBe(401);
  });

  it("case/space normalization accepts pasted codes; wrong codes throttle", async () => {
    const db = makeDb();
    const env = env2(db);
    const { recoveryCodes } = await enroll(env);
    const res = await loginRecovery(env, `  ${recoveryCodes![1]!.toUpperCase()} `);
    expect(res.status).toBe(200);
    const bad = await loginRecovery(env, "0000-0000-0000-0000");
    expect(bad.status).toBe(401);
    expect((db.prepare("SELECT failures FROM admin_login_attempts WHERE scope = 'ip'").get() as Record<string, unknown>).failures).toBeGreaterThan(0);
  });

  it("regenerating replaces the whole set — old codes die", async () => {
    const db = makeDb();
    const env = env2(db);
    const { credential, recoveryCodes } = await enroll(env);
    const flow = await loginMfa(env);
    const assertRes = await assertLogin(env, credential, flow);
    expect(assertRes.status).toBe(200);
    const cookie = sessionTokenFrom(assertRes);
    const regen = await call(env, "/admin/api/auth/webauthn/recovery/regenerate", {
      method: "POST", headers: { Cookie: `crm_session=${cookie}` },
    });
    expect(regen.status).toBe(200);
    const fresh = (await regen.json() as Record<string, unknown>).recovery_codes as string[];
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(recoveryCodes![0]);
    const oldCode = await loginRecovery(env, recoveryCodes![2]!);
    expect(oldCode.status).toBe(401);
    const newCode = await loginRecovery(env, fresh[0]!);
    expect(newCode.status).toBe(200);
    expect(auditRows(db).some((r) => r.action === "WEBAUTHN_RECOVERY_REGEN")).toBe(true);
  });
});

describe("webauthn cross-user surface", () => {
  it("super_admin can list and revoke another user's credentials; readonly cannot", async () => {
    const db = makeDb();
    const env = env2(db);
    const { credential } = await enroll(env); // u_admin credential

    const superCookie = await mintSession(db, "super_admin");
    const list = await call(env, "/admin/api/auth/webauthn/credentials?user_id=u_admin", { headers: { Cookie: `crm_session=${superCookie}` } });
    expect(list.status).toBe(200);
    const body = await list.json() as { credentials: Array<{ id: string }>; two_factor_active: boolean };
    expect(body.credentials).toHaveLength(1);
    expect(body.two_factor_active).toBe(true);

    const del = await call(env, `/admin/api/auth/webauthn/credentials/${encodeURIComponent(credential.credentialIdB64u)}?user_id=u_admin`, {
      method: "DELETE", headers: { Cookie: `crm_session=${superCookie}` },
    });
    expect(del.status).toBe(200);
    const revokeAudit = auditRows(db).find((r) => r.action === "WEBAUTHN_REVOKE");
    expect(revokeAudit).toBeTruthy();
    expect((JSON.parse(revokeAudit!.metadata_json ?? "{}") as Record<string, unknown>).target_user_id).toBe("u_admin");

    // readonly can manage their OWN (empty) list…
    const readonlyCookie = await mintSession(db, "readonly");
    const own = await call(env, "/admin/api/auth/webauthn/credentials", { headers: { Cookie: `crm_session=${readonlyCookie}` } });
    expect(own.status).toBe(200);
    expect((await own.json() as Record<string, unknown>).two_factor_active).toBe(false);
    // …but not anyone else's, in either direction.
    const forbiddenList = await call(env, "/admin/api/auth/webauthn/credentials?user_id=u_admin", { headers: { Cookie: `crm_session=${readonlyCookie}` } });
    expect(forbiddenList.status).toBe(403);
    const forbiddenDel = await call(env, `/admin/api/auth/webauthn/credentials/${encodeURIComponent(credential.credentialIdB64u)}?user_id=u_admin`, {
      method: "DELETE", headers: { Cookie: `crm_session=${readonlyCookie}` },
    });
    expect(forbiddenDel.status).toBe(403);
    expect(auditRows(db).filter((r) => r.action === "ACCESS_DENIED").length).toBe(2);
  });
});

describe("webauthn hygiene and pages", () => {
  it("cron cleanup vacuums expired flows only", async () => {
    const db = makeDb();
    const env = env2(db);
    db.prepare(
      `INSERT INTO webauthn_challenges (id, user_id, purpose, challenge, created_at, expires_at)
       VALUES ('f-old', 'u_admin', 'register', 'Y2hhbGxlbmdl', '2026-01-01 00:00:00', '2026-01-01 00:00:01'),
              ('f-live', 'u_admin', 'assert', 'Y2hhbGxlbmdl', '2099-01-01 00:00:00', '2099-01-02 00:00:00')`,
    ).run();
    const pruned = await cleanupExpiredChallenges(env);
    expect(pruned).toBe(1);
    const ids = (db.prepare("SELECT id FROM webauthn_challenges").all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(["f-live"]);
    // Missing table is a silent 0 (pre-migration window).
    db.exec("DROP TABLE webauthn_challenges");
    expect(await cleanupExpiredChallenges(env)).toBe(0);
  });

  it("the security panel is soft-walled and self-service", async () => {
    const db = makeDb();
    const env = env2(db);
    const unauth = await call(env, "/admin/security");
    expect(unauth.status).toBe(200);
    expect(await unauth.text()).toContain('name="token"');
    const cookie = await mintSession(db, "readonly");
    const authPage = await call(env, "/admin/security", { headers: { Cookie: `crm_session=${cookie}` } });
    expect(authPage.status).toBe(200);
    const html = await authPage.text();
    expect(html).toContain("双因素");
    expect(html).toContain("恢复码");
  });
});
