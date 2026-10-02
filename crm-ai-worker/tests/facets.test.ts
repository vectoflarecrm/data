import { describe, it, expect } from "vitest";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";
import { keywordCandidates, parseFacets, productTokens } from "../src/facets";

/* The filter bars stopped being free-text inputs: the panel now offers
 * selection lists whose counts must equal what 统计匹配 will return for that
 * single value, otherwise the number next to an option is a lie. These tests
 * pin the two things that could silently drift — the LIKE semantics (case
 * folding, cross-value substrings) and the vocabularies mined for products and
 * keywords. */

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

const TOKEN = "correct-horse-battery-staple";

async function makeEnv() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY, status TEXT, country TEXT, email TEXT,
      customer_segment TEXT, product_categories TEXT, products_services TEXT,
      company_name TEXT, description TEXT, business_tag TEXT, lead_score INTEGER
    );
  `);
  const insert = db.prepare(`
    INSERT INTO customers
      (id, status, country, email, customer_segment, product_categories,
       products_services, company_name, description, business_tag, lead_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rows: Array<[number, string, string, string | null, string, string, string, string, string, string]> = [
    // id, status, country, email, segment, product_categories, products_services,
    // company_name, description, business_tag
    [1, "completed", "Spain", "a@x.com", "Dealer", "Kayaks, Accessories",
      "kayak sales", "Blue Kayak Co", "经销皮划艇与冲浪器材。已验证为有效邮箱", ""],
    // Case variant of row 1's segment: LIKE folds ASCII case, so both spellings
    // must land in one option with one shared count.
    [2, "completed", "MOROCCO", null, "dealer", "",
      "sale of Kayaks", "Surf Shop Alpha", "[Dealer] 验证为有效邮箱，冲浪学校", ""],
    [3, "completed", "Morocco", "b@x.com", "Service Provider", "不相关", "",
      "Surf Shop Beta", "[Dealer] 验证为有效邮箱，冲浪学校", ""],
    [4, "completed", "Spain", null, "Dealer", "None", "",
      "Mega Surf Co", "[Dealer] 验证为有效邮箱，冲浪学校", ""],
    // "US" is a substring of "USA": the filter for US matches both rows, so the
    // facet count must come from LIKE rather than from a GROUP BY.
    [5, "completed", "US", "c@x.com", "Distributor", "Kayaks", "",
      "Costa Surf School", "[Dealer] 验证为有效邮箱，冲浪学校", ""],
    [6, "completed", "USA", null, "Dealer", "", "",
      "Aqua Marina", "冲浪板维修服务", ""],
    // Unresearched rows must not appear in any count.
    [7, "pending", "Spain", "d@x.com", "Dealer", "Kayaks", "kayak",
      "Pending Co", "surf 经销商", ""],
  ];
  for (const r of rows) insert.run(...r, 50);
  return {
    db,
    env: { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv,
  };
}

function facetReq(query = "", authed = true): Request {
  return new Request(`https://worker.example/admin/api/customers/filter-options${query}`, {
    headers: authed ? { Cookie: `crm_admin_token=${TOKEN}` } : {},
  });
}

async function fetchOptions(query = "") {
  const { env } = await makeEnv();
  const res = await handleAdminRequest(facetReq(query), env);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    countries: Array<{ v: string; n: number; ne: number }>;
    segments: Array<{ v: string; n: number; ne: number }>;
    products: Array<{ v: string; n: number; ne: number }>;
    keywords: Array<{ v: string; n: number; ne: number }>;
  };
}

describe("GET /admin/api/customers/filter-options", () => {
  it("requires the admin session", async () => {
    const { env } = await makeEnv();
    const res = await handleAdminRequest(facetReq("", false), env);
    expect(res.status).toBe(401);
  });

  it("counts countries with the filter's LIKE semantics, merging case variants", async () => {
    const { countries } = await fetchOptions();
    const byValue = new Map(countries.map((o) => [o.v, o]));
    expect([...byValue.keys()].sort()).toEqual(["MOROCCO", "Spain", "US", "USA"]);
    // MOROCCO + Morocco collapse into one option; the count covers both rows.
    expect(byValue.get("MOROCCO")).toEqual({ v: "MOROCCO", n: 2, ne: 1 });
    expect(byValue.get("Spain")).toEqual({ v: "Spain", n: 2, ne: 1 });
    // The pending Spain row is out; the substring row US/USA is in.
    expect(byValue.get("US")).toEqual({ v: "US", n: 2, ne: 1 });
    expect(byValue.get("USA")).toEqual({ v: "USA", n: 1, ne: 0 });
  });

  it("merges segment spellings the way LIKE does and keeps emailable counts", async () => {
    const { segments } = await fetchOptions();
    const dealer = segments.find((o) => o.v.toLowerCase() === "dealer");
    // 3 × Dealer + 1 × dealer; only row 1 has an address among them.
    expect(dealer).toEqual({ v: "Dealer", n: 4, ne: 1 });
    expect(segments.map((o) => o.v)).toEqual(["Dealer", "Distributor", "Service Provider"]);
  });

  it("splits product_categories, drops pipeline verdicts, counts prose matches", async () => {
    const { products } = await fetchOptions();
    expect(products.map((o) => o.v)).toEqual(["Kayaks", "Accessories"]);
    // Kayaks: rows 1 and 5 by category plus row 2 by products_services prose.
    expect(products[0]).toEqual({ v: "Kayaks", n: 3, ne: 2 });
    expect(products[1]).toEqual({ v: "Accessories", n: 1, ne: 1 });
    // 不相关 / None are verdicts, not products.
    expect(products.map((o) => o.v)).not.toContain("不相关");
    expect(products.map((o) => o.v)).not.toContain("None");
  });

  it("offers only business terms as keywords: no bracket tags, no pipeline notes", async () => {
    const { keywords } = await fetchOptions();
    expect(keywords.map((o) => o.v)).toEqual(["surf", "冲浪学校"]);
    expect(keywords.find((o) => o.v === "surf")).toEqual({ v: "surf", n: 4, ne: 2 });
    // Four rows carry "[Dealer]" and four carry "验证为有效邮箱"; neither may
    // become an option — the first duplicates 细分, the second is pipeline noise.
    expect(keywords.map((o) => o.v)).not.toContain("dealer");
    expect(keywords.map((o) => o.v)).not.toContain("验证为有效邮箱");
  });

  it("honours ?facets= so the 海选 panel can skip the keyword sample", async () => {
    const picked = await fetchOptions("?facets=countries");
    expect(picked.countries.length).toBeGreaterThan(0);
    expect(picked.segments).toEqual([]);
    expect(picked.products).toEqual([]);
    expect(picked.keywords).toEqual([]);
  });

  it("always returns every facet key so callers need no guards", async () => {
    const all = await fetchOptions();
    expect(Object.keys(all).sort()).toEqual(["countries", "keywords", "products", "segments"]);
  });
});

describe("parseFacets", () => {
  it("defaults to every facet when the parameter is absent or blank", () => {
    expect(parseFacets(null)).toEqual(["countries", "segments", "products", "keywords"]);
    expect(parseFacets("  ")).toEqual(["countries", "segments", "products", "keywords"]);
  });

  it("keeps only known names in canonical order", () => {
    expect(parseFacets("keywords, countries, bogus")).toEqual(["countries", "keywords"]);
  });
});

describe("productTokens", () => {
  it("splits combos, de-duplicates within one, and merges case variants", () => {
    const tokens = productTokens([
      { combo: "Kayaks, Kayaks, Accessories", n: 3 },
      { combo: "kayaks", n: 1 },
    ]);
    expect(tokens.map((t) => t.v)).toEqual(["Kayaks", "Accessories"]);
    expect(tokens[0].n).toBe(4); // 3 (once, not twice) + 1
  });

  it("drops verdicts, placeholders, and over-long AI hedging", () => {
    const tokens = productTokens([
      { combo: "不相关, 信息不足，需进一步验证, None, N/A", n: 9 },
      { combo: "Sports Equipment (likely including water sports accessories and apparel)", n: 7 },
      { combo: "Kayaks", n: 2 },
    ]);
    expect(tokens.map((t) => t.v)).toEqual(["Kayaks"]);
  });
});

describe("keywordCandidates", () => {
  const rows = [
    { company_name: "Surf One", description: "[Dealer] 验证为有效邮箱，冲浪学校" },
    { company_name: "Surf Two", description: "[Dealer] 验证为有效邮箱，冲浪学校" },
    { company_name: "Surf Three", description: "[Dealer] 验证为有效邮箱，冲浪学校" },
    { company_name: "Surf Four", description: "[Dealer] 验证为有效邮箱，冲浪学校" },
    { company_name: "Google Map Page", description: "只出现一次的词" },
  ];

  it("keeps frequent business terms in both scripts", () => {
    expect(keywordCandidates(rows).map((c) => c.v)).toEqual(["surf", "冲浪学校"]);
  });

  it("never offers bracket tags, pipeline notes, or link-prose words", () => {
    const offered = keywordCandidates(rows).map((c) => c.v);
    for (const junk of ["dealer", "验证为有效邮箱", "google", "map", "page", "只出现一次的词"]) {
      expect(offered).not.toContain(junk);
    }
  });

  it("needs at least four rows before a term earns a slot", () => {
    const three = rows.slice(0, 3);
    expect(keywordCandidates(three).map((c) => c.v)).not.toContain("surf");
  });
});
