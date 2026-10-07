import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";
import {
  computeLeadScore,
  computeLeadScoreV2,
  LEAD_SCORE_WEIGHTS,
} from "../src/index";
import type { CustomerAnalysis } from "../src/index";

/* Phase 5 — Lead Score V2 (建议 §十八, design docs/phase5-lead-score-v2.md).
 *
 * Pinned here:
 *   - the six dimension weights sum to exactly 100 (§4)
 *   - the 不相关 short-circuit zeroes every dimension (§4)
 *   - per-dimension tiering, row by row of the §4 rule table
 *   - computeLeadScore stays the frozen 0-100 total = dimension sum (§3.2)
 *   - the fit-only compat record from score-separation.test.ts keeps its
 *     ≥ 60 total under V2 weights (65 = 30 + 20 + 15)
 *   - the breakdown JSON contract: version key, six dimensions, no total
 *   - completeness inputs (evidence rows) never move any dimension
 */

function analysis(overrides: Partial<CustomerAnalysis> = {}): CustomerAnalysis {
  return {
    customer_segment: "Distributor (water sports)",
    product_categories: "Inflatable boats, SUP",
    company_size: "Medium",
    geographic_coverage: "National",
    business_type: null,
    product_category: null,
    target_market: null,
    personas_and_solutions: {},
    found_contacts: [{ first_name: "Ana", email: "ana@acme.example", cellphone: "+34 600 111 222" }],
    company_profile: null,
    outreach_context: null,
    field_evidence: [{ field_name: "customer_segment", field_value: "Distributor", evidence_text: "quote" }],
    buying_signals: ["expanding"],
    remarks: "ok",
    ...overrides,
  };
}

function total(b: ReturnType<typeof computeLeadScoreV2>): number {
  return b.icp_fit + b.product_fit + b.buyer_role + b.buying_signal + b.reachability + b.strategic_value;
}

describe("weights — §4 pins", () => {
  it("the six dimension weights sum to exactly 100", () => {
    expect(Object.values(LEAD_SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(LEAD_SCORE_WEIGHTS).toEqual({
      icp_fit: 30,
      product_fit: 20,
      buyer_role: 10,
      buying_signal: 15,
      reachability: 15,
      strategic_value: 10,
    });
  });
});

describe("不相关 short-circuit", () => {
  it("zeroes every dimension and the total", () => {
    const b = computeLeadScoreV2(analysis({ customer_segment: "不相关（本地餐馆）" }));
    expect(b).toEqual({
      version: "lead-score-v2",
      icp_fit: 0,
      product_fit: 0,
      buyer_role: 0,
      buying_signal: 0,
      reachability: 0,
      strategic_value: 0,
    });
    expect(computeLeadScore(analysis({ customer_segment: "不相关（本地餐馆）" }))).toBe(0);
  });
});

describe("dimension tiering — §4 rule table", () => {
  it("icp_fit: distributor 30 / dealer|oem|wholesaler 25 / e-commerce 15 / retailer 10 / user|service 5 / unknown 0", () => {
    const dim = (segment: string) => computeLeadScoreV2(analysis({ customer_segment: segment })).icp_fit;
    expect(dim("Distributor")).toBe(30);
    expect(dim("Boat Dealer")).toBe(25);
    expect(dim("OEM Factory")).toBe(25);
    expect(dim("Wholesaler")).toBe(25);
    expect(dim("E-commerce seller")).toBe(15);
    expect(dim("Retailer")).toBe(10);
    expect(dim("End user (local surfer)")).toBe(5);
    expect(dim("Service Provider")).toBe(5);
    expect(dim("Marina")).toBe(0);
  });

  it("product_fit: real categories 20; 信息不足 and empty are absence, not data", () => {
    expect(computeLeadScoreV2(analysis({ product_categories: "Inflatable boats" })).product_fit).toBe(20);
    expect(computeLeadScoreV2(analysis({ product_categories: "信息不足" })).product_fit).toBe(0);
    expect(computeLeadScoreV2(analysis({ product_categories: null })).product_fit).toBe(0);
  });

  it("buyer_role: named contact 10, role-only persona 5, neither 0", () => {
    const personas = { personas: [{ name: "Purchasing", role: "Purchasing Manager", needs: [], pain_points: [] }], solutions: [] };
    expect(computeLeadScoreV2(analysis()).buyer_role).toBe(10);
    expect(computeLeadScoreV2(analysis({ found_contacts: [], personas_and_solutions: personas })).buyer_role).toBe(5);
    expect(computeLeadScoreV2(analysis({ found_contacts: [] })).buyer_role).toBe(0);
  });

  it("buying_signal: any signal 15, none 0", () => {
    expect(computeLeadScoreV2(analysis({ buying_signals: ["expanding", "hiring"] })).buying_signal).toBe(15);
    expect(computeLeadScoreV2(analysis({ buying_signals: [] })).buying_signal).toBe(0);
  });

  it("reachability: email 15 > phone/whatsapp 8 > bare contact 4 > none 0", () => {
    expect(computeLeadScoreV2(analysis()).reachability).toBe(15);
    expect(computeLeadScoreV2(analysis({ found_contacts: [{ cellphone: "+34 600 000 000" }] })).reachability).toBe(8);
    expect(computeLeadScoreV2(analysis({ found_contacts: [{ whatsapp: "+34 611 111 111" }] })).reachability).toBe(8);
    expect(computeLeadScoreV2(analysis({ found_contacts: [{ linkedin_url: "https://linkedin.com/in/x" }] })).reachability).toBe(4);
    expect(computeLeadScoreV2(analysis({ found_contacts: [] })).reachability).toBe(0);
  });

  it("strategic_value: size +5, geographic +5, 信息不足 is absence", () => {
    expect(computeLeadScoreV2(analysis()).strategic_value).toBe(10);
    expect(computeLeadScoreV2(analysis({ geographic_coverage: null })).strategic_value).toBe(5);
    expect(computeLeadScoreV2(analysis({ company_size: null })).strategic_value).toBe(5);
    expect(computeLeadScoreV2(analysis({ company_size: "信息不足", geographic_coverage: "信息不足" })).strategic_value).toBe(0);
  });
});

describe("total contract — §3.2 frozen", () => {
  it("computeLeadScore is exactly the dimension sum", () => {
    const a = analysis();
    expect(computeLeadScore(a)).toBe(total(computeLeadScoreV2(a)));
  });

  it("a full-fit distributor scores 100 with every dimension at its max", () => {
    expect(computeLeadScoreV2(analysis())).toEqual({
      version: "lead-score-v2",
      icp_fit: LEAD_SCORE_WEIGHTS.icp_fit,
      product_fit: LEAD_SCORE_WEIGHTS.product_fit,
      buyer_role: LEAD_SCORE_WEIGHTS.buyer_role,
      buying_signal: LEAD_SCORE_WEIGHTS.buying_signal,
      reachability: LEAD_SCORE_WEIGHTS.reachability,
      strategic_value: LEAD_SCORE_WEIGHTS.strategic_value,
    });
    expect(computeLeadScore(analysis())).toBe(100);
  });

  it("fit-only compat record (score-separation): 30 + 20 + 15 = 65 ≥ 60", () => {
    const fitOnly = analysis({
      found_contacts: [],
      field_evidence: [],
      company_size: null,
      geographic_coverage: null,
    });
    const b = computeLeadScoreV2(fitOnly);
    expect(b.icp_fit).toBe(30);
    expect(b.product_fit).toBe(20);
    expect(b.buyer_role).toBe(0);
    expect(b.buying_signal).toBe(15);
    expect(b.reachability).toBe(0);
    expect(b.strategic_value).toBe(0);
    expect(computeLeadScore(fitOnly)).toBe(65);
  });
});

describe("breakdown JSON contract — §4.1", () => {
  it("serializes to the cached shape: version key, six dimensions, no total", () => {
    const parsed = JSON.parse(JSON.stringify(computeLeadScoreV2(analysis()))) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
      "buyer_role", "buying_signal", "icp_fit", "product_fit",
      "reachability", "strategic_value", "version",
    ]);
    expect(parsed.version).toBe("lead-score-v2");
  });

  it("completeness inputs never move any dimension (evidence is not a lead input)", () => {
    const before = computeLeadScoreV2(analysis());
    const after = computeLeadScoreV2(analysis({
      field_evidence: [...analysis().field_evidence, { field_name: "country", field_value: "Spain" }],
    }));
    expect(after).toEqual(before);
  });
});

describe("admin detail API — breakdown fail-open (§4.2)", () => {
  const TOKEN = "lead-score-v2-master-token";

  class FakeD1 {
    constructor(private db: any) {}
    prepare(sql: string) {
      const db = this.db;
      let bound: unknown[] = [];
      const stmt: any = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        all: async () => ({ results: db.prepare(sql).all(...bound), success: true }),
        first: async () => db.prepare(sql).get(...bound) ?? undefined,
        run: async () => {
          const info = db.prepare(sql).run(...bound);
          return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
        },
      };
      return stmt;
    }
    async batch(stmts: any[]) {
      for (const s of stmts) await s.run();
      return [];
    }
  }

  function detailReq(id: number): Request {
    return new Request(`https://worker.example/admin/api/customers/${id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  }

  it("returns the raw breakdown JSON beside the total when the column exists", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY, company_id TEXT, display_id TEXT, domain TEXT,
        status TEXT, company_name TEXT, legal_name TEXT, trading_name TEXT,
        normalized_domain TEXT, first_name TEXT, last_name TEXT, full_name TEXT,
        title TEXT, department TEXT, linkedin_url TEXT, street_address TEXT,
        zip_city TEXT, country TEXT, country_code TEXT, region TEXT, city TEXT,
        postal_code TEXT, tel TEXT, email TEXT, cellphone TEXT, whatsapp TEXT,
        products_services TEXT, business_tag TEXT, industry TEXT, company_type TEXT,
        business_model TEXT, founded_year TEXT, employee_range TEXT, description TEXT,
        target_markets TEXT, is_manufacturer TEXT, is_importer TEXT, is_distributor TEXT,
        is_wholesaler TEXT, is_retailer TEXT, is_ecommerce TEXT, is_rental TEXT,
        is_oem TEXT, social_accounts TEXT, full_research_text TEXT,
        social_accounts_verified TEXT, customer_segment TEXT, product_categories TEXT,
        company_size TEXT, geographic_coverage TEXT, personas_and_solutions TEXT,
        remarks TEXT, updated_at TEXT, company_profile TEXT, outreach_context TEXT,
        buying_signals TEXT, lead_score INTEGER, source_import_id TEXT,
        data_completeness_score INTEGER, lead_score_breakdown TEXT
      );
      CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id TEXT,
        company_id TEXT, seq INTEGER, first_name TEXT, last_name TEXT, full_name TEXT,
        title TEXT, department TEXT, email TEXT, cellphone TEXT, tel TEXT,
        whatsapp TEXT, linkedin_url TEXT, social_accounts TEXT);
      CREATE TABLE evidence (id INTEGER PRIMARY KEY, company_id TEXT, field_name TEXT,
        field_value TEXT, source_url TEXT, source_type TEXT, evidence_text TEXT,
        confidence REAL, collected_at TEXT);
      INSERT INTO customers (id, company_id, domain, status, company_name, country,
        lead_score, data_completeness_score, lead_score_breakdown)
        VALUES (1, 'acme', 'acme.example', 'completed', 'Acme', 'Spain', 65, 40,
        '{"version":"lead-score-v2","icp_fit":30,"product_fit":20,"buyer_role":0,"buying_signal":15,"reachability":0,"strategic_value":0}');
    `);
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    const res = await handleAdminRequest(detailReq(1), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.lead_score).toBe(65);
    // Raw JSON passthrough — the panel parses; the API does not interpret.
    expect(JSON.parse(body.lead_score_breakdown as string)).toEqual({
      version: "lead-score-v2",
      icp_fit: 30,
      product_fit: 20,
      buyer_role: 0,
      buying_signal: 15,
      reachability: 0,
      strategic_value: 0,
    });
  });

  it("migration-pending database (column missing): breakdown degrades to null, lead_score unaffected", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY, company_id TEXT, display_id TEXT, domain TEXT,
        status TEXT, company_name TEXT, legal_name TEXT, trading_name TEXT,
        normalized_domain TEXT, first_name TEXT, last_name TEXT, full_name TEXT,
        title TEXT, department TEXT, linkedin_url TEXT, street_address TEXT,
        zip_city TEXT, country TEXT, country_code TEXT, region TEXT, city TEXT,
        postal_code TEXT, tel TEXT, email TEXT, cellphone TEXT, whatsapp TEXT,
        products_services TEXT, business_tag TEXT, industry TEXT, company_type TEXT,
        business_model TEXT, founded_year TEXT, employee_range TEXT, description TEXT,
        target_markets TEXT, is_manufacturer TEXT, is_importer TEXT, is_distributor TEXT,
        is_wholesaler TEXT, is_retailer TEXT, is_ecommerce TEXT, is_rental TEXT,
        is_oem TEXT, social_accounts TEXT, full_research_text TEXT,
        social_accounts_verified TEXT, customer_segment TEXT, product_categories TEXT,
        company_size TEXT, geographic_coverage TEXT, personas_and_solutions TEXT,
        remarks TEXT, updated_at TEXT, company_profile TEXT, outreach_context TEXT,
        buying_signals TEXT, lead_score INTEGER, source_import_id TEXT,
        data_completeness_score INTEGER
      );
      CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id TEXT,
        company_id TEXT, seq INTEGER, first_name TEXT, last_name TEXT, full_name TEXT,
        title TEXT, department TEXT, email TEXT, cellphone TEXT, tel TEXT,
        whatsapp TEXT, linkedin_url TEXT, social_accounts TEXT);
      CREATE TABLE evidence (id INTEGER PRIMARY KEY, company_id TEXT, field_name TEXT,
        field_value TEXT, source_url TEXT, source_type TEXT, evidence_text TEXT,
        confidence REAL, collected_at TEXT);
      INSERT INTO customers (id, company_id, domain, status, company_name, country,
        lead_score, data_completeness_score)
        VALUES (1, 'acme', 'acme.example', 'completed', 'Acme', 'Spain', 75, 60);
    `);
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    const res = await handleAdminRequest(detailReq(1), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.lead_score).toBe(75);
    expect(body.lead_score_breakdown).toBeNull();
  });

  it("pre-stage row (breakdown NULL): the API serves null, not a JSON error", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY, company_id TEXT, display_id TEXT, domain TEXT,
        status TEXT, company_name TEXT, legal_name TEXT, trading_name TEXT,
        normalized_domain TEXT, first_name TEXT, last_name TEXT, full_name TEXT,
        title TEXT, department TEXT, linkedin_url TEXT, street_address TEXT,
        zip_city TEXT, country TEXT, country_code TEXT, region TEXT, city TEXT,
        postal_code TEXT, tel TEXT, email TEXT, cellphone TEXT, whatsapp TEXT,
        products_services TEXT, business_tag TEXT, industry TEXT, company_type TEXT,
        business_model TEXT, founded_year TEXT, employee_range TEXT, description TEXT,
        target_markets TEXT, is_manufacturer TEXT, is_importer TEXT, is_distributor TEXT,
        is_wholesaler TEXT, is_retailer TEXT, is_ecommerce TEXT, is_rental TEXT,
        is_oem TEXT, social_accounts TEXT, full_research_text TEXT,
        social_accounts_verified TEXT, customer_segment TEXT, product_categories TEXT,
        company_size TEXT, geographic_coverage TEXT, personas_and_solutions TEXT,
        remarks TEXT, updated_at TEXT, company_profile TEXT, outreach_context TEXT,
        buying_signals TEXT, lead_score INTEGER, source_import_id TEXT,
        data_completeness_score INTEGER, lead_score_breakdown TEXT
      );
      CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id TEXT,
        company_id TEXT, seq INTEGER, first_name TEXT, last_name TEXT, full_name TEXT,
        title TEXT, department TEXT, email TEXT, cellphone TEXT, tel TEXT,
        whatsapp TEXT, linkedin_url TEXT, social_accounts TEXT);
      CREATE TABLE evidence (id INTEGER PRIMARY KEY, company_id TEXT, field_name TEXT,
        field_value TEXT, source_url TEXT, source_type TEXT, evidence_text TEXT,
        confidence REAL, collected_at TEXT);
      INSERT INTO customers (id, company_id, domain, status, company_name, country,
        lead_score, lead_score_breakdown)
        VALUES (1, 'acme', 'acme.example', 'completed', 'Acme', 'Spain', 100, NULL);
    `);
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    const res = await handleAdminRequest(detailReq(1), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.lead_score).toBe(100);
    expect(body.lead_score_breakdown).toBeNull();
  });
});
