import { describe, it, expect } from "vitest";
import {
  parseSegmentFilters,
  serializeFilters,
  deserializeFilters,
  buildSegmentWhere,
  segmentClause,
  previewSegment,
  createGroup,
  updateGroup,
  EMPTY_FILTERS,
} from "../src/campaigns";
import { LEAD_SCORE_DIMENSIONS, LEAD_SCORE_WEIGHTS, type LeadScoreWeights } from "../src/lead-score-dims";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";

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

/* Stage 46: the 海选 pre-filter endpoint carries the new query param through
 * handleAdminRequest — the panel checkbox is only useful if the count the
 * operator sees is narrowed by it. */
describe("pre-filter endpoint: has_buying_signal query param", () => {
  const BASE = "https://worker.example";
  const TOKEN = "correct-horse-battery-staple";

  function call(env: AdminEnv, path: string): Promise<Response> {
    return handleAdminRequest(
      new Request(`${BASE}${path}`, {
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      }),
      env,
    ) as Promise<Response>;
  }

  it("narrows the matching count to companies with current signals", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY, company_id TEXT, display_id TEXT, domain TEXT, status TEXT,
        company_name TEXT, legal_name TEXT, trading_name TEXT, normalized_domain TEXT,
        first_name TEXT, last_name TEXT, full_name TEXT, title TEXT, department TEXT, linkedin_url TEXT,
        street_address TEXT, zip_city TEXT, country TEXT, country_code TEXT, region TEXT, city TEXT, postal_code TEXT,
        tel TEXT, email TEXT, cellphone TEXT, whatsapp TEXT, products_services TEXT, business_tag TEXT,
        industry TEXT, company_type TEXT, business_model TEXT, founded_year TEXT, employee_range TEXT,
        description TEXT, target_markets TEXT, is_manufacturer TEXT, is_importer TEXT, is_distributor TEXT,
        is_wholesaler TEXT, is_retailer TEXT, is_ecommerce TEXT, is_rental TEXT, is_oem TEXT, social_accounts TEXT,
        full_research_text TEXT, social_accounts_verified TEXT, customer_segment TEXT,
        product_categories TEXT, company_size TEXT, geographic_coverage TEXT,
        personas_and_solutions TEXT, remarks TEXT, updated_at TEXT,
        company_profile TEXT, outreach_context TEXT, buying_signals TEXT, lead_score INTEGER,
        source_import_id TEXT, lead_score_breakdown TEXT
      );
      CREATE TABLE research_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL,
        signal_text TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO customers (id, company_id, status, email, company_name, country, lead_score) VALUES
        (1,'c1','completed','a@x.com','Acme','US',90),
        (2,'c2','completed','b@x.com','Beta','US',80),
        (3,'c3','completed','c@x.com','Gamma','US',70);
      INSERT INTO research_signals (customer_id, signal_text, is_current) VALUES
        ('c1','asked for pricing',1),
        ('c2','visited booth',0);
    `);
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;

    // Without the param the endpoint behaves exactly as before (Stage 45's
    // "default OFF" guarantee, now pinned at the HTTP surface too).
    const before = await call(env, "/admin/api/customers/pre-filter");
    expect(before.status).toBe(200);
    expect(((await before.json()) as { matching: number }).matching).toBe(3);

    const after = await call(env, "/admin/api/customers/pre-filter?has_buying_signal=1");
    expect(after.status).toBe(200);
    const body = (await after.json()) as { matching: number; sample: Array<{ company_name: string }> };
    expect(body.matching).toBe(1);
    expect(body.sample[0].company_name).toBe("Acme");

    db.close();
  });
});

/* ── Phase 8 Stage 50: persona_roles + per_person (docs/phase8-persona-campaigns.md) ──
 * §2.1 persona_roles — EXISTS over research_personas (is_current = 1, exact
 *    role IN), shared builder so 海选 and the campaign screen agree.
 * §2.2 per_person — one email-bearing contact per company; the preview and
 *    the snapshot must use the SAME pick (lowest seq, ties by id). */
describe("parseSegmentFilters: persona_roles + per_person", () => {
  it("defaults both OFF so stored payloads and old screens behave identically", () => {
    expect(parseSegmentFilters({}).personaRoles).toEqual([]);
    expect(parseSegmentFilters({}).perPerson).toBe(false);
    expect(parseSegmentFilters(undefined)).toEqual({ ...EMPTY_FILTERS });
  });

  it("accepts a list or a comma string, dedupes and caps like the other lists", () => {
    expect(parseSegmentFilters({ persona_roles: ["采购总监", "采购总监", " "]}).personaRoles).toEqual(["采购总监"]);
    expect(parseSegmentFilters({ persona_roles: "门店老板,采购总监" }).personaRoles).toEqual(["门店老板", "采购总监"]);
    expect(() => parseSegmentFilters({ persona_roles: Array.from({ length: 11 }, (_, i) => `r${i}`) }))
      .toThrow(/persona_roles 最多/);
  });

  it("per_person uses the same truthy semantics as has_buying_signal", () => {
    expect(parseSegmentFilters({ per_person: true }).perPerson).toBe(true);
    expect(parseSegmentFilters({ per_person: 1 }).perPerson).toBe(true);
    expect(parseSegmentFilters({ per_person: "1" }).perPerson).toBe(true);
    expect(parseSegmentFilters({ per_person: false }).perPerson).toBe(false);
    expect(parseSegmentFilters({ per_person: 0 }).perPerson).toBe(false);
  });

  it("round-trips both fields through storage in snake_case", () => {
    const original = parseSegmentFilters({ persona_roles: ["采购总监"], per_person: true });
    const restored = deserializeFilters(serializeFilters(original));
    expect(restored).toEqual(original);
    const raw = JSON.parse(serializeFilters(original)) as Record<string, unknown>;
    expect(raw.persona_roles).toEqual(["采购总监"]);
    expect(raw.per_person).toBe(true);
  });

  it("reads legacy stored JSON (pre-Phase-8) as persona OFF / company grain", () => {
    const legacy = JSON.stringify({ countries: ["Spain"], has_buying_signal: true });
    const restored = deserializeFilters(legacy);
    expect(restored.personaRoles).toEqual([]);
    expect(restored.perPerson).toBe(false);
    expect(restored.hasBuyingSignal).toBe(true);
  });
});

describe("buildSegmentWhere: persona_roles EXISTS", () => {
  const base = { requireCompleted: true, requireEmail: true };

  it("adds nothing by default", () => {
    const { where, binds } = buildSegmentWhere(EMPTY_FILTERS, base);
    expect(where.join(" ")).not.toContain("research_personas");
    expect(binds).toEqual([]);
  });

  it("correlates against the outer table in bare mode and under an alias", () => {
    const bare = buildSegmentWhere(parseSegmentFilters({ persona_roles: ["采购总监"] }), base);
    expect(bare.where.join(" ")).toContain(
      "EXISTS (SELECT 1 FROM research_personas rp WHERE rp.customer_id = customers.company_id AND rp.is_current = 1",
    );
    const aliased = buildSegmentWhere(
      parseSegmentFilters({ persona_roles: ["采购总监"] }),
      { ...base, table: "c" },
    );
    expect(aliased.where.join(" ")).toContain("rp.customer_id = c.company_id");
  });

  it("binds one placeholder per role in order", () => {
    const { where, binds } = buildSegmentWhere(
      parseSegmentFilters({ persona_roles: ["采购总监", "门店老板"] }),
      base,
    );
    expect(where[where.length - 1]).toContain("IN (?,?)");
    expect(binds).toEqual(["采购总监", "门店老板"]);
  });
});

/* The same correlation trap as has_buying_signal: inside the EXISTS an
 * unqualified customer_id would resolve to the INNER research_personas
 * column and match every company as soon as any persona existed anywhere. */
describe("generated SQL: persona targeting on sqlite", () => {
  async function makeDb() {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE customers (id INTEGER PRIMARY KEY, company_id TEXT, status TEXT, email TEXT);
      CREATE TABLE research_personas (
        id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL,
        persona_role TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE research_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL,
        signal_text TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO customers VALUES
        (1,'comp_a','completed','a@x.com'),
        (2,'comp_b','completed','b@x.com'),
        (3,'comp_c','completed','c@x.com'),
        (4,'comp_d','completed','d@x.com');
      INSERT INTO research_personas (customer_id, persona_role, is_current) VALUES
        ('comp_a','采购总监',1),
        ('comp_b','采购总监',0),
        ('comp_d','门店老板',1),
        ('comp_d','采购总监',1);
    `);
    return db;
  }

  const run = async (filters: unknown) => {
    const db = await makeDb();
    const parsed = parseSegmentFilters(filters);
    const { clause, binds } = segmentClause(parsed, { requireCompleted: true, requireEmail: true });
    const ids = db.prepare(`SELECT id FROM customers ${clause} ORDER BY id`)
      .all(...binds).map((r) => Number((r as { id: number }).id));
    db.close();
    return ids;
  };

  it("matches only companies with a CURRENT persona carrying the exact role", async () => {
    expect(await run({ persona_roles: "采购总监" })).toEqual([1, 4]);
  });

  it("superseded persona rows do not count (is_current = 0)", async () => {
    expect(await run({ persona_roles: "采购总监" })).not.toContain(2);
  });

  it("never leaks a company without persona rows (the correlation regression)", async () => {
    expect(await run({ persona_roles: "门店老板" })).toEqual([4]);
    expect(await run({ persona_roles: "门店老板" })).not.toContain(3);
  });

  it("ANDs with the other dimensions instead of replacing them", async () => {
    // comp_d matches 门店老板 but has no current signal.
    expect(await run({ persona_roles: "门店老板", has_buying_signal: true })).toEqual([]);
  });

  it("leaves the unfiltered baseline untouched", async () => {
    expect(await run({})).toEqual([1, 2, 3, 4]);
  });
});

describe("previewSegment: persona + per-person grain end to end", () => {
  async function makeEnv() {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY, display_id TEXT, company_id TEXT, company_name TEXT,
        status TEXT, email TEXT, country TEXT, customer_segment TEXT,
        lead_score INTEGER, lead_score_breakdown TEXT
      );
      CREATE TABLE outreach_emails (
        id INTEGER PRIMARY KEY, customer_id INTEGER, brand_name TEXT, status TEXT, contact_id INTEGER
      );
      CREATE TABLE research_personas (
        id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL,
        persona_role TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE contacts (
        id INTEGER PRIMARY KEY, contact_id TEXT, company_id TEXT, seq INTEGER,
        first_name TEXT, last_name TEXT, title TEXT, email TEXT
      );
      INSERT INTO customers VALUES
        (1,'d1','comp_a','Alpha','completed','a@x.com','Spain','Distributor',95,NULL),
        (2,'d2','comp_b','Beta','completed','b@x.com','Spain','Dealer',70,NULL),
        (3,'d3','comp_c','Gamma','completed',NULL,'France','Dealer',80,NULL);
      INSERT INTO research_personas (customer_id, persona_role, is_current) VALUES
        ('comp_a','采购总监',1),
        ('comp_b','门店老板',0);
      INSERT INTO contacts VALUES
        (11,'p_a2','comp_a',2,'A','Two','Owner','a2@x.com'),
        (12,'p_a1','comp_a',1,'A','One','Buyer','a1@x.com'),
        (21,'p_b1','comp_b',1,'B','One','Buyer',NULL);
      INSERT INTO outreach_emails (id, customer_id, brand_name, status, contact_id) VALUES
        (101,1,'Afarer','draft',12),
        (102,2,'Afarer','draft',NULL);
    `);
    return { env: { DB: new FakeD1(db) } as unknown as AdminEnv, db };
  }

  it("narrows the preview by current personas", async () => {
    const { env, db } = await makeEnv();
    // Baseline with the default has_email: comp_c has no company mailbox, so
    // two of the three companies are matchable at company grain.
    const baseline = await previewSegment(env, parseSegmentFilters({}), null);
    expect(baseline.matching).toBe(2);
    const targeted = await previewSegment(env, parseSegmentFilters({ persona_roles: "采购总监" }), null);
    expect(targeted.matching).toBe(1);
    expect(targeted.sample[0].company_name).toBe("Alpha");
    db.close();
  });

  it("per-person: counts only companies with an email-bearing contact, not company mailboxes", async () => {
    const { env, db } = await makeEnv();
    const p = await previewSegment(env, parseSegmentFilters({ per_person: true }), "Afarer");
    // comp_a has the picked contact a1@x.com; comp_b's only contact has no
    // email; comp_c has no contacts at all — matching is comp_a alone.
    expect(p.matching).toBe(1);
    // The already count is contact-grain: draft 101 belongs to the PICKED
    // contact (12), so comp_a counts as already handled; a company-grain
    // draft (102) must not leak into the per-person count.
    expect(p.already).toBe(1);
    expect(p.pending).toBe(0);
    expect(p.sample[0].has_draft).toBe(1);
    db.close();
  });

  it("per-person: a company-grain draft alone does not mark the contact as covered", async () => {
    const { env, db } = await makeEnv();
    db.exec("UPDATE outreach_emails SET contact_id = NULL WHERE id = 101");
    const p = await previewSegment(env, parseSegmentFilters({ per_person: true }), "Afarer");
    expect(p.matching).toBe(1);
    expect(p.already).toBe(0);
    expect(p.pending).toBe(1);
    db.close();
  });

  it("company grain is unchanged: drafts count per company mailbox as before", async () => {
    const { env, db } = await makeEnv();
    const p = await previewSegment(env, parseSegmentFilters({}), "Afarer");
    expect(p.matching).toBe(2); // comp_a + comp_b have company emails
    expect(p.already).toBe(2); // 101 (contact draft still counts for the company) + 102
    db.close();
  });
});

/* Stage 50: the 海选 pre-filter endpoint carries persona_roles through the
 * shared builder (design §2.1), so counting and action=queue narrow by the
 * same roles the campaign screen will use. */
describe("pre-filter endpoint: persona_roles query param", () => {
  const BASE = "https://worker.example";
  const TOKEN = "correct-horse-battery-staple";

  function call(env: AdminEnv, path: string): Promise<Response> {
    return handleAdminRequest(
      new Request(`${BASE}${path}`, {
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      }),
      env,
    ) as Promise<Response>;
  }

  it("narrows the matching count to companies with current personas", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY, company_id TEXT, display_id TEXT, domain TEXT, status TEXT,
        company_name TEXT, legal_name TEXT, trading_name TEXT, normalized_domain TEXT,
        first_name TEXT, last_name TEXT, full_name TEXT, title TEXT, department TEXT, linkedin_url TEXT,
        street_address TEXT, zip_city TEXT, country TEXT, country_code TEXT, region TEXT, city TEXT, postal_code TEXT,
        tel TEXT, email TEXT, cellphone TEXT, whatsapp TEXT, products_services TEXT, business_tag TEXT,
        industry TEXT, company_type TEXT, business_model TEXT, founded_year TEXT, employee_range TEXT,
        description TEXT, target_markets TEXT, is_manufacturer TEXT, is_importer TEXT, is_distributor TEXT,
        is_wholesaler TEXT, is_retailer TEXT, is_ecommerce TEXT, is_rental TEXT, is_oem TEXT, social_accounts TEXT,
        full_research_text TEXT, social_accounts_verified TEXT, customer_segment TEXT,
        product_categories TEXT, company_size TEXT, geographic_coverage TEXT,
        personas_and_solutions TEXT, remarks TEXT, updated_at TEXT,
        company_profile TEXT, outreach_context TEXT, buying_signals TEXT, lead_score INTEGER,
        source_import_id TEXT, lead_score_breakdown TEXT
      );
      CREATE TABLE research_personas (
        id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL,
        persona_role TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO customers (id, company_id, status, email, company_name, country, lead_score) VALUES
        (1,'c1','completed','a@x.com','Acme','US',90),
        (2,'c2','completed','b@x.com','Beta','US',80),
        (3,'c3','completed','c@x.com','Gamma','US',70);
      INSERT INTO research_personas (customer_id, persona_role, is_current) VALUES
        ('c1','采购总监',1),
        ('c2','采购总监',0);
    `);
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;

    // Without the param the endpoint behaves exactly as before.
    const before = await call(env, "/admin/api/customers/pre-filter");
    expect(((await before.json()) as { matching: number }).matching).toBe(3);

    const after = await call(env, "/admin/api/customers/pre-filter?persona_roles=" + encodeURIComponent("采购总监"));
    expect(after.status).toBe(200);
    const body = (await after.json()) as { matching: number; sample: Array<{ company_name: string }> };
    expect(body.matching).toBe(1);
    expect(body.sample[0].company_name).toBe("Acme");

    db.close();
  });
});

/* ── Phase 10 Stage 56: effective-weight floor clamps
 * (docs/phase10-lead-score-config.md §3). Dimension floors validate against
 * the weights effective at segment build time — operator-tuned via
 * lead_score_config, loaded fail-open; every omitted-weights call site above
 * keeps the pinned-defaults behavior byte-for-byte. ── */

const TUNED_WEIGHTS: LeadScoreWeights = {
  icp_fit: 60, product_fit: 10, buyer_role: 10,
  buying_signal: 10, reachability: 5, strategic_value: 5,
};

describe("Phase 10: dimension floors clamp against the effective weights", () => {
  it("accepts a floor the tuned config can reach and rejects one it cannot", () => {
    expect(parseSegmentFilters({ dimension_floors: { icp_fit: 40 } }, TUNED_WEIGHTS).dimensionFloors)
      .toEqual({ icp_fit: 40 });
    expect(() => parseSegmentFilters({ dimension_floors: { icp_fit: 61 } }, TUNED_WEIGHTS))
      .toThrow(/icp_fit 门槛必须在 0-60 之间/);
  });

  it("the omitted-weights path keeps the pinned-defaults clamp exactly", () => {
    // 40 is reachable under TUNED_WEIGHTS but NOT under the code defaults —
    // the single-argument call must keep rejecting it (existing behavior).
    expect(() => parseSegmentFilters({ dimension_floors: { icp_fit: 40 } }))
      .toThrow(/icp_fit 门槛必须在 0-30 之间/);
  });

  it("deserializeFilters threads the weights (stored group JSON at build time)", () => {
    const stored = JSON.stringify({ dimension_floors: { icp_fit: 40 } });
    expect(deserializeFilters(stored, TUNED_WEIGHTS).dimensionFloors).toEqual({ icp_fit: 40 });
    // Under the code defaults the same floor 40 exceeds the 0-30 clamp, and
    // deserializeFilters is fail-open by design — stored JSON degrades to
    // EMPTY_FILTERS, never a throw (weights or not, corrupt or invalid).
    expect(deserializeFilters(stored).dimensionFloors).toEqual({});
    expect(
      deserializeFilters(JSON.stringify({ dimension_floors: { icp_fit: 61 } }), TUNED_WEIGHTS),
    ).toEqual({ ...EMPTY_FILTERS });
    expect(deserializeFilters("{broken", TUNED_WEIGHTS)).toEqual({ ...EMPTY_FILTERS });
  });

  it("createGroup/updateGroup load the tuned weights from the database (fail-open pre-tune and pre-migration)", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const GROUPS_DDL = `
      CREATE TABLE outreach_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        filters TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`;
    const CONFIG_DDL = `
      CREATE TABLE lead_score_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        weights_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      );`;

    // Pre-migration database (no lead_score_config table at all): the load
    // fails open to the code defaults — group creation works, clamp stays 30.
    const bare = new DatabaseSync(":memory:");
    bare.exec(GROUPS_DDL);
    const bareEnv = { DB: new FakeD1(bare) } as unknown as AdminEnv;
    await expect(
      createGroup(bareEnv, { name: "g1", filters: { dimension_floors: { icp_fit: 40 } } }),
    ).rejects.toThrow(/0-30/);
    expect(await createGroup(bareEnv, { name: "g1", filters: { dimension_floors: { icp_fit: 30 } } })).toBe(1);
    bare.close();

    // Tuned database: the same floor 40 that the defaults rejected is now a
    // valid segment; floors past the tuned max still reject with its range.
    const db = new DatabaseSync(":memory:");
    db.exec(GROUPS_DDL + CONFIG_DDL);
    const env = { DB: new FakeD1(db) } as unknown as AdminEnv;
    // No config row yet (never tuned): still the code defaults.
    await expect(
      createGroup(env, { name: "g1", filters: { dimension_floors: { icp_fit: 40 } } }),
    ).rejects.toThrow(/0-30/);
    db.prepare(
      "INSERT INTO lead_score_config (id, weights_json, updated_at) VALUES (1, ?, '2026-01-01 00:00:00')",
    ).run(JSON.stringify(TUNED_WEIGHTS));
    const id = await createGroup(env, { name: "g1", filters: { dimension_floors: { icp_fit: 40 } } });
    expect(id).toBe(1);
    await expect(
      updateGroup(env, id, { filters: { dimension_floors: { icp_fit: 61 } } }),
    ).rejects.toThrow(/0-60/);
    await updateGroup(env, id, { filters: { dimension_floors: { icp_fit: 55 } } });
    const row = db.prepare("SELECT filters FROM outreach_groups WHERE id = ?").get(id) as { filters: string };
    expect(JSON.parse(row.filters).dimension_floors).toEqual({ icp_fit: 55 });
    db.close();
  });
});
