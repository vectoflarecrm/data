import { describe, it, expect } from "vitest";
import {
  computeLeadScoreV2,
} from "../src/index";
import type { LeadScoreInputs } from "../src/lead-score-engine";
import { LEAD_SCORE_WEIGHTS, type LeadScoreWeights } from "../src/lead-score-dims";
import { saveLeadScoreWeights, type LeadScoreConfigEnv } from "../src/lead-score-config";
import { makeDb, makeEnv, call, bearer, mintSession, FakeD1 } from "./security/_helpers";

/* Phase 10 Stage 57 — the re-score sweep (docs/phase10-lead-score-config.md
 * §4): after a weight retune the stored per-customer scores are stale until
 * POST /admin/api/lead-score/rescore rebuilds each completed row's inputs
 * from the stored analysis columns + the LIVE contacts table. Pinned here:
 *   - completed rows with a segment are recomputed under the SAVED weights
 *     (the tuned profile, not the code defaults);
 *   - 不相关 rows re-zero (score 0, all-zero breakdown) and pending rows /
 *     data_completeness_score are untouched (separate axes — the sweep never
 *     re-runs research);
 *   - merge-visibility: a contact added after the analysis moves
 *     buyer_role/reachability without re-research;
 *   - no config row = fail-open: the sweep applies the code defaults;
 *   - the audit row carries RESCORE_LEADS with counts + applied weights;
 *   - RBAC: scores.write (super_admin + operator); readonly is 403;
 *   - the sweep walks id-cursor chunks (100 rows per query).
 */

/** A tuned profile that visibly re-tiers every dimension (sum exactly 100). */
const TUNED: LeadScoreWeights = {
  icp_fit: 60,
  product_fit: 10,
  buyer_role: 10,
  buying_signal: 10,
  reachability: 5,
  strategic_value: 5,
};

interface SweepResponse {
  ok: boolean;
  scanned: number;
  rescored: number;
  zeroed: number;
}

interface CustomerRow {
  id: number;
  lead_score: number | null;
  lead_score_breakdown: string | null;
  data_completeness_score: number | null;
}

interface SeedOptions {
  status?: string;
  segment?: string | null;
  products?: string | null;
  size?: string | null;
  coverage?: string | null;
  personas?: string | null;
  signals?: string | null;
  leadScore?: number | null;
  breakdown?: string | null;
  completeness?: number | null;
}

function seedCustomer(db: ReturnType<typeof makeDb>, n: number, opts: SeedOptions = {}): void {
  db.prepare(
    `INSERT INTO customers (id, company_id, domain, status, customer_segment, product_categories, company_size, geographic_coverage, personas_and_solutions, buying_signals, lead_score, lead_score_breakdown, data_completeness_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    n,
    `c_${n}`,
    `example${n}.com`,
    opts.status ?? "completed",
    opts.segment ?? null,
    opts.products ?? null,
    opts.size ?? null,
    opts.coverage ?? null,
    opts.personas ?? null,
    opts.signals ?? null,
    opts.leadScore ?? null,
    opts.breakdown ?? null,
    opts.completeness ?? null,
  );
}

function seedContact(
  db: ReturnType<typeof makeDb>,
  n: number,
  companyId: string,
  firstName: string | null,
  email: string | null,
): void {
  db.prepare(
    "INSERT INTO contacts (id, contact_id, company_id, seq, first_name, email) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(n, `ct_${n}`, companyId, n, firstName, email);
}

function getCustomer(db: ReturnType<typeof makeDb>, id: number): CustomerRow {
  return db
    .prepare("SELECT id, lead_score, lead_score_breakdown, data_completeness_score FROM customers WHERE id = ?")
    .get(id) as CustomerRow;
}

function auditMetadata(db: ReturnType<typeof makeDb>, action: string): Array<Record<string, unknown>> {
  return (
    db.prepare("SELECT metadata_json FROM audit_logs WHERE action = ?").all(action) as Array<{
      metadata_json: string;
    }>
  ).map((row) => JSON.parse(row.metadata_json) as Record<string, unknown>);
}

async function sweep(env: ReturnType<typeof makeEnv>): Promise<SweepResponse> {
  const res = await call(env, "/admin/api/lead-score/rescore", { method: "POST", headers: bearer() });
  expect(res.status).toBe(200);
  return (await res.json()) as SweepResponse;
}

describe("POST /admin/api/lead-score/rescore — the sweep", () => {
  it("rescores completed rows under the saved weights, re-zeroes 不相关, skips pending/unscored rows and completeness", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    await saveLeadScoreWeights({ DB: new FakeD1(db) } as unknown as LeadScoreConfigEnv, TUNED, "u_admin");

    // A: a fully-populated distributor, scored 100 under the DEFAULT profile
    // (30/20/10/15/15/10). Under TUNED the same inputs re-tier to 60/10/10/10/5/5.
    const personasA = JSON.stringify({
      personas: [{ name: "Ana", role: "采购总监", needs: [], pain_points: [] }],
      solutions: [],
    });
    seedCustomer(db, 1, {
      segment: "Distributor (water sports)",
      products: "Inflatable boats",
      size: "Medium",
      coverage: "National",
      personas: personasA,
      signals: JSON.stringify(["expanding product line"]),
      leadScore: 100,
      breakdown: JSON.stringify({
        version: "lead-score-v2",
        icp_fit: 30, product_fit: 20, buyer_role: 10, buying_signal: 15, reachability: 15, strategic_value: 10,
      }),
      completeness: 40,
    });
    seedContact(db, 1, "c_1", "Ana", "ana@acme.example");
    // B: 不相关 with a stale non-zero score — worthless by definition.
    seedCustomer(db, 2, {
      segment: "不相关（服务商）",
      leadScore: 30,
      breakdown: JSON.stringify({
        version: "lead-score-v2",
        icp_fit: 30, product_fit: 0, buyer_role: 0, buying_signal: 0, reachability: 0, strategic_value: 0,
      }),
    });
    // C: pending — not analyzed yet, the sweep must not touch it.
    seedCustomer(db, 3, { status: "pending", segment: "Distributor", leadScore: 55 });
    // D: completed but never analyzed (segment NULL) — out of scope.
    seedCustomer(db, 4, { leadScore: null });

    const body = await sweep(env);
    expect(body).toEqual({ ok: true, scanned: 2, rescored: 1, zeroed: 1 });

    // A: re-tiered under TUNED — the exact engine output for the same inputs.
    const expected = computeLeadScoreV2(
      {
        customer_segment: "Distributor (water sports)",
        product_categories: "Inflatable boats",
        company_size: "Medium",
        geographic_coverage: "National",
        personas_and_solutions: { personas: [{ name: "Ana", role: "采购总监", needs: [], pain_points: [] }], solutions: [] },
        buying_signals: ["expanding product line"],
        found_contacts: [{ first_name: "Ana", last_name: null, email: "ana@acme.example", cellphone: null, whatsapp: null }],
      } satisfies LeadScoreInputs,
      TUNED,
    );
    const rowA = getCustomer(db, 1);
    expect(rowA.lead_score).toBe(100);
    expect(JSON.parse(rowA.lead_score_breakdown ?? "{}")).toEqual(expected);
    expect(rowA.data_completeness_score).toBe(40); // separate axis, untouched

    // B: re-zeroed — score 0 and an all-zero v2 breakdown.
    const rowB = getCustomer(db, 2);
    expect(rowB.lead_score).toBe(0);
    expect(JSON.parse(rowB.lead_score_breakdown ?? "{}")).toEqual({
      version: "lead-score-v2",
      icp_fit: 0, product_fit: 0, buyer_role: 0, buying_signal: 0, reachability: 0, strategic_value: 0,
    });

    // C + D: untouched.
    expect(getCustomer(db, 3).lead_score).toBe(55);
    expect(getCustomer(db, 4).lead_score).toBeNull();

    // The audit row carries the counts + the applied (tuned) weights.
    const audits = auditMetadata(db, "RESCORE_LEADS");
    expect(audits.length).toBe(1);
    expect(audits[0].scanned).toBe(2);
    expect(audits[0].rescored).toBe(1);
    expect(audits[0].zeroed).toBe(1);
    expect(audits[0].weights).toEqual(TUNED);
  });

  it("merge-visibility: a contact added after the analysis moves buyer_role/reachability (fail-open to code defaults)", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    // No lead_score_config row: the sweep must apply the code defaults.
    seedCustomer(db, 1, {
      segment: "Distributor (water sports)",
      products: "Inflatable boats",
      size: "Medium",
      coverage: "National",
      personas: JSON.stringify({ personas: [], solutions: [] }),
      signals: JSON.stringify(["expanding product line"]),
      // The ORIGINAL analysis found no contact person — the stored cache
      // says buyer_role 0 / reachability 0.
      leadScore: 75,
      breakdown: JSON.stringify({
        version: "lead-score-v2",
        icp_fit: 30, product_fit: 20, buyer_role: 0, buying_signal: 15, reachability: 0, strategic_value: 10,
      }),
    });
    // Post-analysis: a named contact with an email landed in the contacts
    // table (panel add / merge). The sweep reads the LIVE table.
    seedContact(db, 1, "c_1", "Ana", "ana@acme.example");

    const body = await sweep(env);
    expect(body).toEqual({ ok: true, scanned: 1, rescored: 1, zeroed: 0 });

    const row = getCustomer(db, 1);
    expect(row.lead_score).toBe(100);
    const breakdown = JSON.parse(row.lead_score_breakdown ?? "{}") as Record<string, number>;
    expect(breakdown.buyer_role).toBe(LEAD_SCORE_WEIGHTS.buyer_role); // named contact
    expect(breakdown.reachability).toBe(LEAD_SCORE_WEIGHTS.reachability); // email

    // Fail-open provenance: the audit row records the CODE DEFAULTS.
    expect(auditMetadata(db, "RESCORE_LEADS")[0].weights).toEqual(LEAD_SCORE_WEIGHTS);
  });

  it("RBAC: operator (scores.write) may sweep, readonly may not", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    seedCustomer(db, 1, { segment: "Distributor" });

    const readonlyToken = await mintSession(db, "readonly");
    const denied = await call(env, "/admin/api/lead-score/rescore", {
      method: "POST",
      headers: { Cookie: `crm_session=${readonlyToken}` },
    });
    expect(denied.status).toBe(403);
    expect(getCustomer(db, 1).lead_score).toBeNull(); // nothing ran

    const operatorToken = await mintSession(db, "operator");
    const allowed = await call(env, "/admin/api/lead-score/rescore", {
      method: "POST",
      headers: { Cookie: `crm_session=${operatorToken}` },
    });
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as SweepResponse).scanned).toBe(1);
  });

  it("walks id-cursor chunks — 105 completed rows across two chunks", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    for (let i = 1; i <= 105; i++) {
      seedCustomer(db, i, { segment: "用户 (User)" });
    }
    const body = await sweep(env);
    expect(body.scanned).toBe(105);
    expect(body.rescored).toBe(105); // 用户 tiers to 5 — scored, not zeroed
    expect(getCustomer(db, 105).lead_score).toBe(5);
  });
});
