import { describe, it, expect } from "vitest";
import {
  parseSegmentFilters,
  serializeFilters,
  deserializeFilters,
  buildSegmentWhere,
  segmentClause,
  EMPTY_FILTERS,
} from "../src/campaigns";

describe("parseSegmentFilters", () => {
  it("accepts comma-separated strings and arrays alike", () => {
    const fromString = parseSegmentFilters({ countries: "Spain, France" });
    const fromArray = parseSegmentFilters({ countries: ["Spain", "France"] });
    expect(fromString.countries).toEqual(["Spain", "France"]);
    expect(fromArray.countries).toEqual(fromString.countries);
  });

  it("drops blank entries, trims and de-duplicates", () => {
    const f = parseSegmentFilters({ segments: " Dealer , , Dealer,Distributor " });
    expect(f.segments).toEqual(["Dealer", "Distributor"]);
  });

  it("defaults to requiring an email and excluding already-sent customers", () => {
    const f = parseSegmentFilters({});
    expect(f.hasEmail).toBe(true);
    expect(f.excludeSent).toBe(true);
  });

  it("honours explicit false for has_email / exclude_sent", () => {
    const f = parseSegmentFilters({ has_email: false, exclude_sent: false });
    expect(f.hasEmail).toBe(false);
    expect(f.excludeSent).toBe(false);
  });

  it("rejects an out-of-range lead score", () => {
    expect(() => parseSegmentFilters({ min_lead_score: 101 })).toThrow(/0-100/);
    expect(() => parseSegmentFilters({ min_lead_score: -1 })).toThrow(/0-100/);
  });

  it("keeps only positive integer customer ids and caps the count", () => {
    expect(parseSegmentFilters({ customer_ids: "3, 4, x, 0, -2, 4" }).customerIds).toEqual([3, 4]);
    const many = Array.from({ length: 501 }, (_, i) => i + 1);
    expect(() => parseSegmentFilters({ customer_ids: many })).toThrow(/最多/);
  });

  it("rejects a non-object payload", () => {
    expect(() => parseSegmentFilters("Spain")).toThrow(/JSON 对象/);
    expect(() => parseSegmentFilters([1, 2])).toThrow(/JSON 对象/);
  });

  it("truncates absurdly long values instead of passing them to SQL", () => {
    const f = parseSegmentFilters({ countries: "x".repeat(500) });
    expect(f.countries[0]).toHaveLength(50);
  });
});

describe("filters round-trip through storage", () => {
  it("serializes to the snake_case wire shape and back", () => {
    const original = parseSegmentFilters({
      countries: "Spain",
      segments: "Dealer",
      products: "SUP",
      keywords: "paddle",
      min_lead_score: 70,
      exclude_sent: true,
      customer_ids: [1, 2],
    });
    const restored = deserializeFilters(serializeFilters(original));
    expect(restored).toEqual(original);
  });

  it("falls back to empty filters on corrupt stored JSON", () => {
    expect(deserializeFilters("{not json")).toEqual(EMPTY_FILTERS);
    expect(deserializeFilters(null)).toEqual(EMPTY_FILTERS);
  });
});

describe("buildSegmentWhere", () => {
  const base = { requireCompleted: true, requireEmail: true };

  it("always requires a researched customer with a recipient for campaigns", () => {
    const { where, binds } = buildSegmentWhere(EMPTY_FILTERS, base);
    expect(where).toEqual(["status = 'completed'", "(email IS NOT NULL AND email != '')"]);
    expect(binds).toEqual([]);
  });

  it("omits the email requirement when the caller does not ask for it (海选 opt-in)", () => {
    const { where } = buildSegmentWhere(EMPTY_FILTERS, { requireCompleted: true, requireEmail: false });
    expect(where).toEqual(["status = 'completed'"]);
  });

  it("ORs the values within one dimension and ANDs across dimensions", () => {
    const { where, binds } = buildSegmentWhere(
      parseSegmentFilters({ countries: "Spain,France", segments: "Dealer" }),
      base,
    );
    expect(where[2]).toBe("(country LIKE ? OR country LIKE ?)");
    expect(where[3]).toBe("(customer_segment LIKE ?)");
    expect(binds).toEqual(["%Spain%", "%France%", "%Dealer%"]);
  });

  it("searches both product columns for the products dimension", () => {
    const { where, binds } = buildSegmentWhere(parseSegmentFilters({ products: "SUP" }), base);
    expect(where[2]).toBe("((product_categories LIKE ? OR products_services LIKE ?))");
    expect(binds).toEqual(["%SUP%", "%SUP%"]);
  });

  it("applies the lead score floor only when positive", () => {
    expect(buildSegmentWhere(parseSegmentFilters({ min_lead_score: 0 }), base).where).toHaveLength(2);
    const withScore = buildSegmentWhere(parseSegmentFilters({ min_lead_score: 60 }), base);
    expect(withScore.where).toContain("lead_score >= ?");
    expect(withScore.binds).toEqual([60]);
  });

  it("adds the per-brand already-sent exclusion only when a brand is given", () => {
    const withoutBrand = buildSegmentWhere(
      parseSegmentFilters({ exclude_sent: true }),
      { ...base, brandName: null },
    );
    expect(withoutBrand.where).toHaveLength(2);

    const withBrand = buildSegmentWhere(
      parseSegmentFilters({ exclude_sent: true }),
      { ...base, brandName: "Afarer" },
    );
    expect(withBrand.where[2]).toMatch(/id NOT IN/);
    expect(withBrand.binds).toEqual(["Afarer"]);
  });

  it("skips the exclusion when the operator opts out", () => {
    const { where, binds } = buildSegmentWhere(
      parseSegmentFilters({ exclude_sent: false }),
      { ...base, brandName: "Afarer" },
    );
    expect(where).toHaveLength(2);
    expect(binds).toEqual([]);
  });

  it("qualifies every column with the caller's table alias", () => {
    const { where, binds } = buildSegmentWhere(
      parseSegmentFilters({ countries: "Spain", customer_ids: [1, 2] }),
      { ...base, table: "c" },
    );
    expect(where[0]).toBe("c.status = 'completed'");
    expect(where[1]).toBe("(c.email IS NOT NULL AND c.email != '')");
    expect(where[2]).toBe("(c.country LIKE ?)");
    expect(where[3]).toBe("c.id IN (?,?)");
    expect(binds).toEqual(["%Spain%", 1, 2]);
  });

  it("produces a bind count that matches the placeholder count", () => {
    const { clause, binds } = segmentClause(
      parseSegmentFilters({
        countries: "Spain,France,Italy",
        products: "SUP,RIB",
        keywords: "a,b",
        min_lead_score: 55,
        customer_ids: [7, 8, 9],
        exclude_sent: true,
      }),
      { ...base, brandName: "Afarer" },
    );
    const placeholders = (clause.match(/\?/g) ?? []).length;
    expect(placeholders).toBe(binds.length);
  });
});

/* The clause is concatenated into hand-written SELECTs, so a syntax slip would
 * only surface as a 500 on the live panel. Run the real generated SQL against
 * an in-memory SQLite to keep the shape honest. */
describe("generated SQL runs on sqlite", () => {
  it("selects exactly the customers the filters describe", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY, status TEXT, email TEXT, country TEXT,
        customer_segment TEXT, product_categories TEXT, products_services TEXT,
        company_name TEXT, description TEXT, business_tag TEXT, lead_score INTEGER
      );
      CREATE TABLE outreach_emails (id INTEGER PRIMARY KEY, customer_id INTEGER, brand_name TEXT, status TEXT);
      INSERT INTO customers VALUES
        (1,'completed','a@es.com','Spain','Dealer','SUP',NULL,'Aqua Co','paddleboards','Retailer',90),
        (2,'completed','b@fr.com','France','Distributor','RIB',NULL,'Boat SAR','rib boats',NULL,75),
        (3,'completed',NULL,'Spain','Dealer','SUP',NULL,'NoMail','x',NULL,88),
        (4,'pending','d@de.com','Germany','Dealer','SUP',NULL,'Pending','x',NULL,99),
        (5,'completed','e@es.com','Spain','Retailer','SUP',NULL,'Sent Co','x',NULL,80);
      INSERT INTO outreach_emails VALUES (1,5,'Afarer','sent');
    `);

    const run = (filters: unknown, brandName: string | null = "Afarer") => {
      const parsed = parseSegmentFilters(filters);
      const { clause, binds } = segmentClause(parsed, {
        requireCompleted: true,
        requireEmail: true,
        brandName: parsed.excludeSent ? brandName : null,
        table: "c",
      });
      const sql = `SELECT c.id FROM customers c ${clause} ORDER BY c.id`;
      return db.prepare(sql).all(...binds).map((r) => Number((r as { id: number }).id));
    };

    // Spain + Dealer, researched, has an email, Afarer not yet sent to.
    // Baseline gate: completed + email leaves 1,2,5; the per-brand already-sent
    // exclusion then removes 5.
    expect(run({})).toEqual([1, 2]);
    expect(run({ countries: "Spain", segments: "Dealer" })).toEqual([1]);
    // Bypassing the sent-exclusion lets the already-mailed row back in.
    expect(run({ countries: "Spain", exclude_sent: false })).toEqual([1, 5]);
    // A lead-score floor narrows further (5 scores 80, so 85 drops it).
    expect(run({ countries: "Spain", exclude_sent: false, min_lead_score: 85 })).toEqual([1]);
    expect(run({ countries: "Spain", exclude_sent: false, min_lead_score: 80 })).toEqual([1, 5]);
    // Keyword search spans company name / description / business_tag (NOT
    // customer_segment, which is its own dimension).
    expect(run({ keywords: "Boat", exclude_sent: false })).toEqual([2]);
    expect(run({ keywords: "Retailer" })).toEqual([1]);
    // Manual picks intersect with the other criteria rather than replacing them:
    // 3 has no email and 4 is still pending, so only 1 survives.
    expect(run({ customer_ids: [1, 3, 4] })).toEqual([1]);
    expect(run({ customer_ids: [1, 3, 4], exclude_sent: false })).toEqual([1]);
    // An empty filter set never returns never-queried or unreachable rows.
    expect(run({}, null)).toEqual([1, 2, 5]);

    db.close();
  });

  it("runs the grouped country rollup the preview renders", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE customers (id INTEGER PRIMARY KEY, status TEXT, email TEXT, country TEXT,
        customer_segment TEXT, product_categories TEXT, products_services TEXT,
        company_name TEXT, description TEXT, business_tag TEXT, lead_score INTEGER);
      INSERT INTO customers VALUES
        (1,'completed','a@x.com','Spain',NULL,NULL,NULL,NULL,NULL,NULL,10),
        (2,'completed','b@x.com','Spain',NULL,NULL,NULL,NULL,NULL,NULL,10),
        (3,'completed','c@x.com','France',NULL,NULL,NULL,NULL,NULL,NULL,10);
    `);
    const { clause, binds } = segmentClause(EMPTY_FILTERS, {
      requireCompleted: true,
      requireEmail: true,
      table: "c",
    });
    const rows = db
      .prepare(`SELECT c.country, COUNT(*) AS n FROM customers c ${clause} GROUP BY c.country ORDER BY n DESC`)
      .all(...binds) as Array<{ country: string; n: number }>;
    expect(rows[0]).toEqual({ country: "Spain", n: 2 });

    db.close();
  });
});
