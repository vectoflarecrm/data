import { describe, it, expect } from "vitest";

// The relevance precheck helpers live in index.ts, which imports wrangler-only
// types (Ai, D1Database) and admin handlers. Import the compiled module would
// drag in the whole worker; instead these tests re-exercise the exact logic by
// importing the real functions via a narrow surface. To keep the module pure
// for tests, index.ts exports the helpers for unit testing.
import {
  parseRelevanceVerdict,
  isRelevancePrecheckEnabled,
  computeLeadScore,
  type CustomerAnalysis,
} from "../src/index";

describe("parseRelevanceVerdict", () => {
  it("accepts bare RELEVANT", () => {
    expect(parseRelevanceVerdict("RELEVANT")).toBe("relevant");
  });

  it("accepts bare IRRELEVANT", () => {
    expect(parseRelevanceVerdict("IRRELEVANT")).toBe("irrelevant");
  });

  it("is case-insensitive and tolerates surrounding text", () => {
    expect(parseRelevanceVerdict("verdict: Irrelevant.")).toBe("irrelevant");
    expect(parseRelevanceVerdict("The answer is Relevant")).toBe("relevant");
  });

  it("prefers the first match when the model rambles", () => {
    expect(parseRelevanceVerdict("IRRELEVANT because it is not relevant")).toBe("irrelevant");
  });

  it("returns null for unparseable output", () => {
    expect(parseRelevanceVerdict("maybe")).toBeNull();
    expect(parseRelevanceVerdict("")).toBeNull();
  });
});

describe("isRelevancePrecheckEnabled", () => {
  const fakeAi = { run: async () => ({ response: "RELEVANT" }) };

  it("is off when the AI binding is absent", () => {
    expect(isRelevancePrecheckEnabled({} as never)).toBe(false);
  });

  it("is on with a binding and no override", () => {
    expect(isRelevancePrecheckEnabled({ AI: fakeAi } as never)).toBe(true);
  });

  it("can be disabled via RELEVANCE_PRECHECK=off", () => {
    expect(isRelevancePrecheckEnabled({ AI: fakeAi, RELEVANCE_PRECHECK: "off" } as never)).toBe(false);
  });

  it("ignores unknown override values (fail-open)", () => {
    expect(isRelevancePrecheckEnabled({ AI: fakeAi, RELEVANCE_PRECHECK: "on" } as never)).toBe(true);
  });
});

describe("computeLeadScore", () => {
  const base = {
    customer_segment: "Distributor",
    product_categories: "Inflatable Boats",
    company_size: "Medium",
    geographic_coverage: "International",
    personas_and_solutions: { personas: [], solutions: [] },
    found_contacts: [{ email: "a@b.com" }],
    company_profile: null,
    outreach_context: null,
    field_evidence: [],
    buying_signals: [],
    remarks: "",
  } as unknown as CustomerAnalysis;

  it("scores a strong distributor highly", () => {
    expect(computeLeadScore(base)).toBeGreaterThanOrEqual(70);
  });

  it("forces score 0 for irrelevant companies regardless of other fields", () => {
    // Guards against a populated profile/contacts rescuing an irrelevant row.
    const irrelevant = { ...base, customer_segment: "不相关", product_categories: "Inflatable Boats", found_contacts: [{ email: "x@y.com" }] } as CustomerAnalysis;
    expect(computeLeadScore(irrelevant)).toBe(0);
  });

  it("treats the '不相关' marker as a substring (defensive)", () => {
    const variant = { ...base, customer_segment: "不相关（某无关行业）" } as CustomerAnalysis;
    expect(computeLeadScore(variant)).toBe(0);
  });
});
