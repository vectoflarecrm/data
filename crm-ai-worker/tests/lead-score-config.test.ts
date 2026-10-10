import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  parseLeadScoreWeights,
  loadLeadScoreConfig,
  loadLeadScoreWeights,
  saveLeadScoreWeights,
  type LeadScoreConfigEnv,
} from "../src/lead-score-config";
import { LEAD_SCORE_WEIGHTS, type LeadScoreWeights } from "../src/lead-score-dims";
import { SCHEMA_SQL, makeDb, makeEnv, call, bearer, mintSession, FakeD1 } from "./security/_helpers";

/* Phase 10 Stage 55 — lead-score weight configuration
 * (docs/phase10-lead-score-config.md §2). Pinned here:
 *   - validation: exactly the six dimension keys, integers 0-100, sum
 *     EXACTLY 100 (the frozen 0-100 total contract), booleans/strings/
 *     floats rejected with a reason;
 *   - fail-open reads: missing table (migration pending), missing row
 *     (never tuned), corrupt JSON and hand-edited invalid rows all resolve
 *     to the code defaults — scoring never goes down;
 *   - fail-loud writes: saveLeadScoreWeights throws on a missing table;
 *   - the HTTP surface: GET answers defaults pre-tune, PUT validates with
 *     400 + reason, the old→new retune roundtrips, the audit row carries
 *     old_weights/new_weights;
 *   - RBAC: mutations are scores.write (super_admin + operator), reads
 *     ride customers.read.
 */

const MIGRATION_0029 = readFileSync(
  new URL("../migrations/0029_lead_score_config.sql", import.meta.url),
  "utf8",
);

/** A valid non-default profile (sum exactly 100). */
const CUSTOM: LeadScoreWeights = {
  icp_fit: 40,
  product_fit: 15,
  buyer_role: 5,
  buying_signal: 15,
  reachability: 15,
  strategic_value: 10,
};

function moduleEnv(db: unknown): LeadScoreConfigEnv {
  return { DB: new FakeD1(db) } as unknown as LeadScoreConfigEnv;
}

describe("parseLeadScoreWeights — validation", () => {
  it("accepts a valid custom profile and the code defaults", () => {
    expect(parseLeadScoreWeights(CUSTOM)).toEqual({ ok: true, weights: CUSTOM });
    expect(parseLeadScoreWeights(LEAD_SCORE_WEIGHTS)).toEqual({ ok: true, weights: LEAD_SCORE_WEIGHTS });
  });

  it("rejects non-object input: array, null, number, string, malformed JSON", () => {
    for (const raw of [[CUSTOM], null, 100, "weights"]) {
      const res = parseLeadScoreWeights(raw);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("weights must be a JSON object");
    }
  });

  it("rejects a missing dimension key, naming it", () => {
    const partial: Record<string, number> = { ...CUSTOM };
    delete partial.strategic_value;
    const res = parseLeadScoreWeights(partial);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("missing dimension weight: strategic_value");
  });

  it("rejects an unknown key (a typo'd future dimension is an error, not a silent ignore)", () => {
    const extra: Record<string, number> = { ...CUSTOM, icp_fitt: 1 };
    const res = parseLeadScoreWeights(extra);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("unknown dimension key: icp_fitt");
  });

  it("rejects non-integers: floats, numeric strings and booleans", () => {
    // Boolean is the Stage 53 contactsPerCompany lesson: Number(true) === 1
    // would slip through a Number()-based check; typeof-first does not.
    for (const bad of [1.5, "30", true, false]) {
      const res = parseLeadScoreWeights({ ...CUSTOM, icp_fit: bad });
      expect(res.ok, `icp_fit=${String(bad)}`).toBe(false);
      if (!res.ok) expect(res.error).toContain("weight for icp_fit must be an integer");
    }
  });

  it("rejects out-of-range weights: negative and above 100", () => {
    for (const bad of [-1, 101]) {
      const res = parseLeadScoreWeights({ ...CUSTOM, reachability: bad });
      expect(res.ok, `reachability=${bad}`).toBe(false);
      if (!res.ok) expect(res.error).toContain("weight for reachability must be between 0 and 100");
    }
  });

  it("rejects sums below and above exactly 100, reporting the actual sum", () => {
    const low: Record<string, number> = { ...CUSTOM, strategic_value: 9 };
    const high: Record<string, number> = { ...CUSTOM, strategic_value: 11 };
    const resLow = parseLeadScoreWeights(low);
    const resHigh = parseLeadScoreWeights(high);
    expect(resLow.ok).toBe(false);
    expect(resHigh.ok).toBe(false);
    if (!resLow.ok) expect(resLow.error).toContain("got 99");
    if (!resHigh.ok) expect(resHigh.error).toContain("got 101");
  });
});

describe("load/save roundtrip (real sqlite)", () => {
  it("migration 0029 and schema.sql create the same column shape, and the migration is idempotent", () => {
    const byMigration = new DatabaseSync(":memory:");
    byMigration.exec(MIGRATION_0029);
    byMigration.exec(MIGRATION_0029); // idempotent re-run is a no-op
    const bySchema = new DatabaseSync(":memory:");
    bySchema.exec(SCHEMA_SQL);
    const cols = (db: DatabaseSync): unknown =>
      (
        db.prepare("PRAGMA table_info(lead_score_config)").all() as Array<{
          name: string;
          type: string;
          notnull: number;
        }>
      ).map((c) => [c.name, c.type, c.notnull]);
    expect(cols(byMigration)).toEqual(cols(bySchema));
    // The single-row invariant lives in the table, not the writer.
    const ddl = byMigration
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'lead_score_config'")
      .get() as { sql: string };
    expect(ddl.sql).toContain("CHECK (id = 1)");
  });

  it("fresh table (never tuned) resolves to the defaults with a null updated_at", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(MIGRATION_0029);
    const config = await loadLeadScoreConfig(moduleEnv(db));
    expect(config.weights).toEqual(LEAD_SCORE_WEIGHTS);
    expect(config.updatedAt).toBeNull();
  });

  it("save then load roundtrips the custom profile, the timestamp and the actor", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(MIGRATION_0029);
    const env = moduleEnv(db);
    const updatedAt = await saveLeadScoreWeights(env, CUSTOM, "u_op");
    expect(updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(await loadLeadScoreWeights(env)).toEqual(CUSTOM);
    const config = await loadLeadScoreConfig(env);
    expect(config.updatedAt).toBe(updatedAt);
    const row = db
      .prepare("SELECT weights_json, updated_by FROM lead_score_config WHERE id = 1")
      .get() as { weights_json: string; updated_by: string };
    expect(row.updated_by).toBe("u_op");
    // Single row — the second save overwrites in place, never inserts.
    await saveLeadScoreWeights(env, LEAD_SCORE_WEIGHTS, "u_op");
    expect((db.prepare("SELECT COUNT(*) AS n FROM lead_score_config").get() as { n: number }).n).toBe(1);
  });

  it("missing table (migration pending) fails open to defaults", async () => {
    const db = new DatabaseSync(":memory:"); // no tables at all
    expect(await loadLeadScoreWeights(moduleEnv(db))).toEqual(LEAD_SCORE_WEIGHTS);
  });

  it("corrupt or hand-edited invalid stored rows fail open to defaults, not a throw", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(MIGRATION_0029);
    db.prepare("INSERT INTO lead_score_config (id, weights_json, updated_at) VALUES (1, ?, '2026-01-01 00:00:00')")
      .run('{"icp_fit":30,'); // truncated JSON
    expect(await loadLeadScoreWeights(moduleEnv(db))).toEqual(LEAD_SCORE_WEIGHTS);
    db.prepare("UPDATE lead_score_config SET weights_json = ? WHERE id = 1").run(
      JSON.stringify({ ...CUSTOM, strategic_value: 9 }), // valid JSON, sum 99
    );
    expect(await loadLeadScoreWeights(moduleEnv(db))).toEqual(LEAD_SCORE_WEIGHTS);
  });

  it("saveLeadScoreWeights is fail-loud on a missing table (a config PUT must not pretend to save)", async () => {
    const db = new DatabaseSync(":memory:");
    await expect(saveLeadScoreWeights(moduleEnv(db), CUSTOM, null)).rejects.toThrow("no such table");
  });
});

describe("API surface — /admin/api/lead-score/config", () => {
  function put(env: ReturnType<typeof makeEnv>, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return call(env, "/admin/api/lead-score/config", {
      method: "PUT",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("GET answers the defaults with a null updated_at before the first tune", async () => {
    const env = makeEnv(makeDb());
    const res = await call(env, "/admin/api/lead-score/config", { headers: bearer() });
    expect(res.status).toBe(200);
    const d = (await res.json()) as { weights: LeadScoreWeights; defaults: LeadScoreWeights; updated_at: string | null };
    expect(d.weights).toEqual(LEAD_SCORE_WEIGHTS);
    expect(d.defaults).toEqual(LEAD_SCORE_WEIGHTS);
    expect(d.updated_at).toBeNull();
  });

  it("PUT with a valid profile roundtrips through GET (super_admin bearer)", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const res = await put(env, CUSTOM, bearer());
    expect(res.status).toBe(200);
    const putBody = (await res.json()) as { ok: boolean; weights: LeadScoreWeights; updated_at: string };
    expect(putBody.ok).toBe(true);
    expect(putBody.weights).toEqual(CUSTOM);
    expect(putBody.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
    const getRes = await call(env, "/admin/api/lead-score/config", { headers: bearer() });
    const d = (await getRes.json()) as { weights: LeadScoreWeights; updated_at: string };
    expect(d.weights).toEqual(CUSTOM);
    expect(d.updated_at).toBe(putBody.updated_at);
    // The retune is audited with old→new weights (old = the defaults here).
    const auditRows = db
      .prepare("SELECT actor_role, metadata_json FROM audit_logs WHERE action = 'UPDATE_SCORE_CONFIG'")
      .all() as Array<{ actor_role: string; metadata_json: string }>;
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].actor_role).toBe("super_admin");
    const meta = JSON.parse(auditRows[0].metadata_json) as { old_weights: LeadScoreWeights; new_weights: LeadScoreWeights };
    expect(meta.old_weights).toEqual(LEAD_SCORE_WEIGHTS);
    expect(meta.new_weights).toEqual(CUSTOM);
  });

  it("PUT rejects invalid payloads with 400 + reason and stores nothing", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const cases: Array<[unknown, string]> = [
      [{ ...CUSTOM, strategic_value: 9 }, "sum"],          // 99
      [{ ...CUSTOM, icp_fit: true }, "integer"],           // boolean
      [{ ...CUSTOM, buyer_role: 1.5 }, "integer"],         // float
      [{ icp_fit: 40, product_fit: 15, buying_signal: 15, reachability: 15, strategic_value: 10 }, "missing"], // no buyer_role
      [{ ...CUSTOM, extra_dim: 1 }, "unknown dimension key"],
      ["not-an-object", "JSON object"],
      ["{broken", "JSON object"],                          // malformed JSON body
    ];
    for (const [body, needle] of cases) {
      const res = await put(env, body, bearer());
      expect(res.status, `body=${JSON.stringify(body)}`).toBe(400);
      const d = (await res.json()) as { detail: string };
      expect(d.detail).toContain(needle);
    }
    // Nothing was stored by any rejected PUT.
    expect((db.prepare("SELECT COUNT(*) AS n FROM lead_score_config").get() as { n: number }).n).toBe(0);
  });

  it("unauthenticated PUT is a 401, not a validation pass", async () => {
    const env = makeEnv(makeDb());
    const res = await put(env, CUSTOM);
    expect(res.status).toBe(401);
  });

  it("RBAC: PUT is scores.write — operator passes, researcher/sender/readonly get 403; GET is customers.read for every role", async () => {
    for (const role of ["operator", "researcher", "sender", "readonly"]) {
      const db = makeDb();
      const env = makeEnv(db);
      const token = await mintSession(db, role);
      const expected = role === "operator" ? 200 : 403;
      const res = await put(env, CUSTOM, { Cookie: `crm_session=${token}` });
      expect(res.status, `role ${role} PUT`).toBe(expected);
      const getRes = await call(env, "/admin/api/lead-score/config", { headers: { Cookie: `crm_session=${token}` } });
      expect(getRes.status, `role ${role} GET`).toBe(200);
    }
  });
});
