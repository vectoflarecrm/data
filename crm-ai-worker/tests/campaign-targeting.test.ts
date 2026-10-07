import { describe, it, expect } from "vitest";
import {
  parseSegmentFilters,
  serializeFilters,
  deserializeFilters,
  buildSegmentWhere,
  segmentClause,
  previewSegment,
  EMPTY_FILTERS,
} from "../src/campaigns";
import { LEAD_SCORE_DIMENSIONS, LEAD_SCORE_WEIGHTS } from "../src/lead-score-dims";
import type { AdminEnv } from "../src/admin";

/* Phase 6 Stage 45 (docs/phase6-campaign-targeting.md): two additive
 * targeting dimensions over the frozen Phase 5 contract —
 *   §2.1 has_buying_signal  — EXISTS over research_signals, is_current = 1
 *   §2.2 dimension_floors   — per-dimension minimums via json_extract on
 *                             customers.lead_score_breakdown
 * Both default OFF, so every stored filter payload and every existing
 * screen behaves byte-identically until an operator opts in. */

describe("parseSegmentFilters: has_buying_signal", () => {
  it("defaults to OFF like the other opt-in dimensions", () => {
    expect(parseSegmentFilters({}).hasBuyingSignal).toBe(false);
    expect(parseSegmentFilters(undefined)).toEqual({ ...EMPTY_FILTERS });
    // Legacy stored JSON (pre-Phase-6 shape) parses to the same defaults.
    expect(parseSegmentFilters({ countries: "Spain" }).hasBuyingSignal).toBe(false);
  });

  it("uses the same truthy semantics as has_email / exclude_sent", () => {
    expect(parseSegmentFilters({ has_buying_signal: true }).hasBuyingSignal).toBe(true);
    expect(parseSegmentFilters({ has_buying_signal: 1 }).hasBuyingSignal).toBe(true);
    expect(parseSegmentFilters({ has_buying_signal: "1" }).hasBuyingSignal).toBe(true);
    expect(parseSegmentFilters({ has_buying_signal: false }).hasBuyingSignal).toBe(false);
    expect(parseSegmentFilters({ has_buying_signal: 0 }).hasBuyingSignal).toBe(false);
  });
});

describe("parseSegmentFilters: dimension_floors", () => {
  it("defaults to empty and drops zero floors (a no-op floor)", () => {
    expect(parseSegmentFilters({}).dimensionFloors).toEqual({});
    const f = parseSegmentFilters({ dimension_floors: { icp_fit: 25, product_fit: 0 } });
    expect(f.dimensionFloors).toEqual({ icp_fit: 25 });
  });

  it("accepts every pinned dimension up to its weight", () => {
    const all = Object.fromEntries(
      LEAD_SCORE_DIMENSIONS.map((d) => [d, LEAD_SCORE_WEIGHTS[d]]),
    );
    const f = parseSegmentFilters({ dimension_floors: all });
    expect(f.dimensionFloors).toEqual(all);
  });

  it("rejects unknown dimension keys instead of ignoring them (typo guard)", () => {
    expect(() => parseSegmentFilters({ dimension_floors: { icp_fitx: 10 } })).toThrow(/未知维度/);
    expect(() => parseSegmentFilters({ dimension_floors: { total: 50 } })).toThrow(/未知维度/);
  });

  it("rejects out-of-range or non-integer floors per dimension weight", () => {
    expect(() => parseSegmentFilters({ dimension_floors: { icp_fit: 31 } })).toThrow(/icp_fit 门槛必须在 0-30 之间/);
    expect(() => parseSegmentFilters({ dimension_floors: { buyer_role: -1 } })).toThrow(/buyer_role 门槛必须在 0-10 之间/);
    expect(() => parseSegmentFilters({ dimension_floors: { product_fit: 2.5 } })).toThrow(/product_fit 门槛必须在 0-20 之间/);
    expect(() => parseSegmentFilters({ dimension_floors: { icp_fit: "high" } })).toThrow(/icp_fit 门槛必须在 0-30 之间/);
  });

  it("rejects non-object payloads", () => {
    expect(() => parseSegmentFilters({ dimension_floors: [1, 2] })).toThrow(/必须是 JSON 对象/);
    expect(() => parseSegmentFilters({ dimension_floors: "icp_fit" })).toThrow(/必须是 JSON 对象/);
    expect(() => parseSegmentFilters({ dimension_floors: 30 })).toThrow(/必须是 JSON 对象/);
  });
});

describe("filters round-trip through storage (Phase 6 fields)", () => {
  it("serializes to snake_case and back without loss", () => {
    const original = parseSegmentFilters({
      has_buying_signal: true,
      dimension_floors: { icp_fit: 25, strategic_value: 5 },
      countries: "Spain",
    });
    const restored = deserializeFilters(serializeFilters(original));
    expect(restored).toEqual(original);
    // The wire shape keeps the snake_case convention of the other fields.
    const raw = JSON.parse(serializeFilters(original)) as Record<string, unknown>;
    expect(raw.has_buying_signal).toBe(true);
    expect(raw.dimension_floors).toEqual({ icp_fit: 25, strategic_value: 5 });
  });

  it("reads legacy stored JSON (pre-Phase-6) as both dimensions OFF", () => {
    const legacy = JSON.stringify({
      countries: ["Spain"],
      min_lead_score: 60,
      has_email: true,
      exclude_sent: true,
      customer_ids: [3],
    });
    const restored = deserializeFilters(legacy);
    expect(restored.hasBuyingSignal).toBe(false);
    expect(restored.dimensionFloors).toEqual({});
    expect(restored.countries).toEqual(["Spain"]);
    expect(restored.minLeadScore).toBe(60);
  });
});

describe("buildSegmentWhere: signal EXISTS + dimension floors", () => {
  const base = { requireCompleted: true, requireEmail: true };

  it("adds nothing by default (stored payloads behave identically)", () => {
    const { where, binds } = buildSegmentWhere(EMPTY_FILTERS, base);
    expect(where).toEqual(["status = 'completed'", "(email IS NOT NULL AND email != '')"]);
    expect(binds).toEqual([]);
  });

  it("correlates the EXISTS against the outer customers table in bare mode", () => {
    const { where } = buildSegmentWhere(parseSegmentFilters({ has_buying_signal: true }), base);
    expect(where).toContain(
      "EXISTS (SELECT 1 FROM research_signals rs WHERE rs.customer_id = customers.company_id AND rs.is_current = 1)",
    );
  });

  it("uses the alias when the caller queries under one (SQLite forbids the original name)", () => {
    const { where } = buildSegmentWhere(
      parseSegmentFilters({ has_buying_signal: true }),
      { ...base, table: "c" },
    );
    expect(where).toContain(
      "EXISTS (SELECT 1 FROM research_signals rs WHERE rs.customer_id = c.company_id AND rs.is_current = 1)",
    );
  });

  it("emits floors in the pinned dimension order, whatever the input order", () => {
    const { where, binds } = buildSegmentWhere(
      parseSegmentFilters({ dimension_floors: { strategic_value: 5, icp_fit: 25 } }),
      base,
    );
    expect(where[2]).toBe("COALESCE(CAST(json_extract(lead_score_breakdown, '$.icp_fit') AS INTEGER), 0) >= ?");
    expect(where[3]).toBe("COALESCE(CAST(json_extract(lead_score_breakdown, '$.strategic_value') AS INTEGER), 0) >= ?");
    expect(binds).toEqual([25, 5]);
  });

  it("qualifies the breakdown column with the caller's table alias", () => {
    const { where } = buildSegmentWhere(
      parseSegmentFilters({ dimension_floors: { icp_fit: 25 } }),
      { ...base, table: "c" },
    );
    expect(where[2]).toContain("json_extract(c.lead_score_breakdown, '$.icp_fit')");
  });

  it("keeps the bind count aligned with the placeholders across both dimensions", () => {
    const { clause, binds } = segmentClause(
      parseSegmentFilters({
        has_buying_signal: true,
        dimension_floors: { icp_fit: 25, buying_signal: 15 },
        countries: "Spain",
      }),
      base,
    );
    const placeholders = (clause.match(/\?/g) ?? []).length;
    expect(placeholders).toBe(binds.length);
  });
});

/* The correlation trap this stage exists to avoid: inside the EXISTS an
 * unqualified customer_id would resolve to the INNER research_signals
 * column — `rs.customer_id = rs.customer_id` is always true, so every
 * company would match as soon as ANY signal row existed anywhere. Run the
 * real generated SQL to prove the qualified reference narrows correctly. */
describe("generated SQL: signal + floor targeting on sqlite", () => {
  async function makeDb() {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY, company_id TEXT, status TEXT, email TEXT,
        lead_score INTEGER, lead_score_breakdown TEXT
      );
      CREATE TABLE research_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL,
        signal_text TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO customers VALUES
        (1,'comp_a','completed','a@x.com',90,'{"icp_fit":30,"reachability":15}'),
        (2,'comp_b','completed','b@x.com',70,'{"icp_fit":30}'),
        (3,'comp_c','completed','c@x.com',85,'{"icp_fit":15}'),
        (4,'comp_d','completed','d@x.com',60,'{"icp_fit":15}'),
        (5,'comp_e','completed','e@x.com',55,NULL),
        (6,'comp_f','completed','f@x.com',50,'{"reachability":15}');
      INSERT INTO research_signals (customer_id, signal_text, is_current) VALUES
        ('comp_a','asked for pricing',1),
        ('comp_b','visited booth',0),
        ('comp_d','downloaded catalog',1);
    `);
    return db;
  }

  const runBare = (db: InstanceType<Awaited<ReturnType<typeof makeDb>>>, filters: unknown) => {
    const parsed = parseSegmentFilters(filters);
    const { clause, binds } = segmentClause(parsed, { requireCompleted: true, requireEmail: true });
    return db.prepare(`SELECT id FROM customers ${clause} ORDER BY id`)
      .all(...binds).map((r) => Number((r as { id: number }).id));
  };

  const runAliased = (db: InstanceType<Awaited<ReturnType<typeof makeDb>>>, filters: unknown) => {
    const parsed = parseSegmentFilters(filters);
    const { clause, binds } = segmentClause(parsed, { requireCompleted: true, requireEmail: true, table: "c" });
    return db.prepare(`SELECT c.id FROM customers c ${clause} ORDER BY c.id`)
      .all(...binds).map((r) => Number((r as { id: number }).id));
  };

  it("matches only companies with a CURRENT signal (superseded rows do not count)", async () => {
    const db = await makeDb();
    expect(runBare(db, { has_buying_signal: true })).toEqual([1, 4]);
    db.close();
  });

  it("does not leak other companies' signals (the correlation regression)", async () => {
    const db = await makeDb();
    // comp_c has no signal rows at all; with the always-true self-comparison
    // bug it would match alongside comp_a/comp_d. It must stay excluded.
    expect(runBare(db, { has_buying_signal: true })).not.toContain(3);
    expect(runBare(db, { has_buying_signal: true })).not.toContain(2);
    db.close();
  });

  it("agrees between bare and aliased forms", async () => {
    const db = await makeDb();
    const filters = { has_buying_signal: true, dimension_floors: { icp_fit: 20 } };
    expect(runAliased(db, filters)).toEqual(runBare(db, filters));
    expect(runAliased(db, filters)).toEqual([1]);
    db.close();
  });

  it("applies a floor via json_extract and treats a NULL breakdown as 0", async () => {
    const db = await makeDb();
    // icp_fit >= 20: comp_a (30) and comp_b (30); comp_c/comp_d (15), the
    // pre-Stage-43 NULL row (5) and the dim-less row (6) read as 0.
    expect(runBare(db, { dimension_floors: { icp_fit: 20 } })).toEqual([1, 2]);
    // A floor asserts knowledge: no positive floor can pass on NULL.
    expect(runBare(db, { dimension_floors: { icp_fit: 1 } })).not.toContain(5);
    // A dimension missing from the stored JSON also reads as 0.
    expect(runBare(db, { dimension_floors: { icp_fit: 1 } })).not.toContain(6);
    // ...while a dimension the row does have still works for that row.
    expect(runBare(db, { dimension_floors: { reachability: 8 } })).toEqual([1, 6]);
    db.close();
  });

  it("ANDs the signal gate with the floors (both must hold)", async () => {
    const db = await makeDb();
    // Signals: comp_a, comp_d. icp_fit >= 20: comp_a, comp_b. Intersection: comp_a.
    expect(runBare(db, { has_buying_signal: true, dimension_floors: { icp_fit: 20 } })).toEqual([1]);
    db.close();
  });

  it("leaves the unfiltered baseline untouched (all six rows)", async () => {
    const db = await makeDb();
    expect(runBare(db, {})).toEqual([1, 2, 3, 4, 5, 6]);
    db.close();
  });
});

/* previewSegment is the operator-facing safety gate: its counts must already
 * reflect the new targeting dimensions, not just the raw builder. */
class FakeD1 {
  constructor(private db: any) {}

  prepare(sql: string) {
    const db = this.db;
    let bound: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...bound) as T[], success: true };
      },
      async first<T>() {
        return (db.prepare(sql).get(...bound) ?? undefined) as T | undefined;
      },
      async run() {
        const info = db.prepare(sql).run(...bound);
        return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
      },
    };
  }

  async batch(stmts: any[]) {
    for (const s of stmts) await s.run();
    return [];
  }
}

describe("previewSegment reflects the Phase 6 dimensions end to end", () => {
  it("narrows matching / by_country / sample by signal and floor", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY, display_id TEXT, company_id TEXT, company_name TEXT,
        status TEXT, email TEXT, country TEXT, customer_segment TEXT,
        lead_score INTEGER, lead_score_breakdown TEXT
      );
      CREATE TABLE outreach_emails (
        id INTEGER PRIMARY KEY, customer_id INTEGER, brand_name TEXT, status TEXT
      );
      CREATE TABLE research_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL,
        signal_text TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO customers VALUES
        (1,'d1','comp_a','Alpha','completed','a@x.com','Spain','Distributor',95,'{"icp_fit":30}'),
        (2,'d2','comp_b','Beta','completed','b@x.com','Spain','Dealer',70,'{"icp_fit":30}'),
        (3,'d3','comp_c','Gamma','completed','c@x.com','France','Dealer',80,'{"icp_fit":15}');
      INSERT INTO research_signals (customer_id, signal_text, is_current) VALUES
        ('comp_a','asked for pricing',1),
        ('comp_b','visited booth',0);
    `);

    const env = { DB: new FakeD1(db) } as unknown as AdminEnv;

    const baseline = await previewSegment(env, parseSegmentFilters({}), null);
    expect(baseline.matching).toBe(3);

    const targeted = await previewSegment(
      env,
      parseSegmentFilters({ has_buying_signal: true, dimension_floors: { icp_fit: 25 } }),
      null,
    );
    expect(targeted.matching).toBe(1);
    expect(targeted.sample[0].company_name).toBe("Alpha");
    expect(targeted.by_country).toEqual([{ country: "Spain", n: 1 }]);

    // Signal alone: superseded rows still do not count.
    const signalsOnly = await previewSegment(env, parseSegmentFilters({ has_buying_signal: true }), null);
    expect(signalsOnly.matching).toBe(1);

    db.close();
  });
});
