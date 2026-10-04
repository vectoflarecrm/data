import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";
import { computeLeadScore, computeCompletenessScore } from "../src/index";
import type { CustomerAnalysis, CustomerRow } from "../src/index";

/* Security V2 Stage 15 — Lead Score / Data Completeness separation (spec §16).
 *
 * §16.3 test list, mapped:
 *   同一个 customer：Lead Score 可以高，Completeness 可以低 ✓
 *     (and the mirror: low lead / high completeness)
 *   两者不能自动互相覆盖 ✓ (disjoint inputs: varying one axis's inputs never
 *     moves the other score)
 * Plus: the §16.2 dimension accounting, an irrelevant company keeping its
 * completeness (fit 0 ≠ unknown record), and the admin detail API exposing
 * both scores with a migration-pending fallback.
 */

const TOKEN = "score-separation-master-token";

function row(overrides: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: 1,
    company_id: "acme",
    display_id: null,
    domain: "acme.example",
    status: "processing",
    company_name: null,
    country: null,
    customer_segment: null,
    full_research_text: null,
    personas_and_solutions: null,
    remarks: null,
    ...overrides,
  };
}

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

describe("computeCompletenessScore — §16.2 dimensions", () => {
  it("a fully known record scores 100 (10 × 10 points)", () => {
    const score = computeCompletenessScore(
      row({ company_name: "Acme Boats", country: "Spain" }),
      analysis(),
      3, // verified social accounts
    );
    expect(score).toBe(100);
  });

  it("each dimension is worth exactly 10 points and independent of the others", () => {
    // Only domain + freshness (the pass itself) are guaranteed.
    expect(computeCompletenessScore(row(), analysis({ found_contacts: [], field_evidence: [], product_categories: null }), 0)).toBe(20);
    // +identity
    expect(computeCompletenessScore(row({ company_name: "Acme" }), analysis({ found_contacts: [], field_evidence: [], product_categories: null }), 0)).toBe(30);
    // +country, +contact, +email, +phone, +social, +products, +evidence stack linearly.
    const withContact = analysis({ found_contacts: [{ first_name: "Ana", email: "a@x.com", cellphone: "+34 600 000 000" }] });
    expect(computeCompletenessScore(row({ company_name: "Acme", country: "Spain" }), withContact, 2)).toBe(100);
    // A phone-only contact still counts BOTH the contact-person and phone
    // dimensions: domain + contact + phone + freshness.
    const phoneOnly = analysis({ found_contacts: [{ cellphone: "+34 600 000 000" }], field_evidence: [], product_categories: null });
    expect(computeCompletenessScore(row(), phoneOnly, 0)).toBe(40);
    // "信息不足" verdicts are absence, not data.
    expect(computeCompletenessScore(row({ company_name: "Acme" }), analysis({ product_categories: "信息不足", found_contacts: [] , field_evidence: [] }), 0)).toBe(30);
  });
});

describe("§16.3 — the two axes are independent", () => {
  it("same customer: high lead score with low completeness (fit ≠ knowledge)", () => {
    // Perfect fit: distributor + product match + buying signal — but a bare
    // record: no name, no country, no contacts, no social, no evidence.
    // Completeness still sees the product categories (a genuinely shared
    // fact both axes legitimately read — §16.1 product fit / §16.2 products).
    const fitOnly = analysis({
      found_contacts: [],
      field_evidence: [],
      company_size: null,
      geographic_coverage: null,
    });
    const lead = computeLeadScore(fitOnly);
    const completeness = computeCompletenessScore(row(), fitOnly, 0);
    expect(lead).toBeGreaterThanOrEqual(60);
    // domain + products + freshness.
    expect(completeness).toBe(30);
    expect(lead).toBeGreaterThan(completeness);
  });

  it("same customer: low lead score with high completeness (well-known ≠ worth pursuing)", () => {
    // Judged irrelevant — lead 0 by definition — yet the record is fully
    // known: identity, country, named contact with email+phone, socials,
    // products, evidence, freshly researched. Fit 0 says nothing about how
    // well we know the company, and vice versa.
    const knownButIrrelevant = analysis({
      customer_segment: "不相关（本地餐馆）",
      product_categories: "Swimwear",
      found_contacts: [{ first_name: "Sara", email: "sara@x.com", whatsapp: "+34 611 111 111" }],
      field_evidence: [{ field_name: "country", field_value: "Spain" }],
      buying_signals: [],
      company_size: null,
      geographic_coverage: null,
    });
    expect(computeLeadScore(knownButIrrelevant)).toBe(0);
    expect(computeCompletenessScore(row({ company_name: "Surf Shop", country: "Spain" }), knownButIrrelevant, 2)).toBe(100);
  });

  it("completeness inputs never move the lead score (no auto-overwrite)", () => {
    const base = analysis();
    const leadBefore = computeLeadScore(base);
    // Evidence rows are a completeness dimension; adding them cannot bribe the
    // lead score. Identity/country/socials live on the customer row, which the
    // lead score does not even receive as an argument — structurally separate.
    const leadAfter = computeLeadScore(analysis({ field_evidence: [...base.field_evidence, { field_name: "country", field_value: "Spain" }] }));
    expect(leadAfter).toBe(leadBefore);
  });

  it("pure fit inputs (segment, buying signals) never move the completeness score", () => {
    const customer = row({ company_name: "Acme", country: "Spain" });
    const strongFit = analysis(); // distributor + buying signal
    const weakFit = analysis({ customer_segment: "End user (local surfer)", buying_signals: [] });
    // Same record knowledge, opposite fit verdicts: the completeness verdict
    // is identical because segment/signals are not completeness inputs.
    expect(computeCompletenessScore(customer, strongFit, 2)).toBe(100);
    expect(computeCompletenessScore(customer, weakFit, 2)).toBe(100);
  });
});

describe("admin detail API — both scores on one response", () => {
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

  it("returns lead_score and data_completeness_score as separate fields", async () => {
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
    // Two axes, two fields, independently stored values.
    expect(body.lead_score).toBe(75);
    expect(body.data_completeness_score).toBe(60);
  });

  it("migration-pending database (column missing): completeness degrades to null, lead_score unaffected", async () => {
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
        buying_signals TEXT, lead_score INTEGER, source_import_id TEXT
      );
      CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id TEXT,
        company_id TEXT, seq INTEGER, first_name TEXT, last_name TEXT, full_name TEXT,
        title TEXT, department TEXT, email TEXT, cellphone TEXT, tel TEXT,
        whatsapp TEXT, linkedin_url TEXT, social_accounts TEXT);
      CREATE TABLE evidence (id INTEGER PRIMARY KEY, company_id TEXT, field_name TEXT,
        field_value TEXT, source_url TEXT, source_type TEXT, evidence_text TEXT,
        confidence REAL, collected_at TEXT);
      INSERT INTO customers (id, company_id, domain, status, company_name, country, lead_score)
        VALUES (1, 'acme', 'acme.example', 'completed', 'Acme', 'Spain', 75);
    `);
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    const res = await handleAdminRequest(detailReq(1), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.lead_score).toBe(75);
    expect(body.data_completeness_score).toBeNull();
  });
});
