import { describe, it, expect } from "vitest";
import {
  buildIdentityAnchors,
  matchPageIdentity,
  AI_SYSTEM_PROMPT,
  buildUserPrompt,
  type CustomerRow,
} from "../src/index";

/* 抓取精度：目标公司身份锚点。第三方搜索结果页进入研究上下文之前必须
 * 提到目标公司本身——公司名变体（大小写/分隔符/读音符号无关）或官网
 * 域名。整页讲别家公司的一律不收；摘要兜底同样过滤。这一层挡"整页无
 * 关"，多公司页面内部"其他公司"数据的隔离由提示词层负责（下方断言）。 */

const customer: CustomerRow = {
  id: 1,
  company_id: "acme-marine",
  display_id: "C-0001",
  domain: "acme-marine.example",
  status: "pending",
  company_name: "Acme Marine Supplies",
  country: "ES",
  customer_segment: null,
  personas_and_solutions: null,
  remarks: null,
};

describe("buildIdentityAnchors", () => {
  it("strips corporate stopwords from the name and keeps significant tokens in order", () => {
    const a = buildIdentityAnchors("Aqua Marine Ltd", "https://aquamarine.example");
    expect(a.nameTokens).toEqual(["aqua", "marine"]);
    expect(a.nameKey).toBe("aquamarine");
    expect(a.domainHosts).toEqual(["aquamarine.example"]);
    expect(a.nameRegex).not.toBeNull();
  });

  it("strips diacritics so Café del Mar matches Cafe del Mar", () => {
    const a = buildIdentityAnchors("Café del Mar", "cafedelmar.example");
    expect(a.nameTokens).toEqual(["cafe", "del", "mar"]);
    expect(matchPageIdentity("Cafe del Mar boat rental", a)).toBe("name");
  });

  it("falls back to domain-only identity when the name is all stopwords", () => {
    const a = buildIdentityAnchors("Trading Co", "tradingco.example");
    expect(a.nameTokens).toEqual([]);
    expect(a.nameRegex).toBeNull();
    expect(matchPageIdentity("Trading Co homepage", a)).toBeNull();
    expect(matchPageIdentity("listed on tradingco.example", a)).toBe("domain");
  });

  it("tolerates a missing/invalid domain", () => {
    const noDomain = buildIdentityAnchors("Aqua Marine");
    expect(noDomain.domainHosts).toEqual([]);
    const badDomain = buildIdentityAnchors("Aqua Marine", "not a domain at all");
    expect(badDomain.domainHosts).toEqual([]);
    expect(matchPageIdentity("Aqua Marine distributor", badDomain)).toBe("name");
  });
});

describe("matchPageIdentity", () => {
  const anchors = buildIdentityAnchors("Aqua Marine Ltd", "https://aquamarine.example");

  it("matches a domain mention (directory pages link the official site)", () => {
    expect(matchPageIdentity("See https://aquamarine.example/about for details", anchors)).toBe("domain");
  });

  it("matches the company name across separator styles", () => {
    expect(matchPageIdentity("Aqua Marine is a distributor of inflatable boats", anchors)).toBe("name");
    expect(matchPageIdentity("AquaMarine Ltd, based in Valencia", anchors)).toBe("name");
    expect(matchPageIdentity("About Aqua-Marine Supplies", anchors)).toBe("name");
  });

  it("rejects pages about a different company", () => {
    expect(matchPageIdentity("Bluewave Boats is a kayak manufacturer in Italy", anchors)).toBeNull();
    expect(matchPageIdentity("Aquaflow Marine sells paddle boards", anchors)).toBeNull();
  });

  it("enforces word boundaries so a single generic token does not match inside longer words", () => {
    const marine = buildIdentityAnchors("Marine", "marine.example");
    expect(matchPageIdentity("Submarine Parts Co", marine)).toBeNull();
    expect(matchPageIdentity("Marine distributor since 1998", marine)).toBe("name");
  });

  it("long keys also match punctuation-joined variants via the collapsed fallback", () => {
    const long = buildIdentityAnchors("Aqua Marine Supplies", "ams.example");
    // Dots defeat the regex separator class, but the collapsed substring catches it.
    expect(matchPageIdentity("profile at aqua.marine.supplies.es", long)).toBe("name");
  });

  it("returns null on empty text", () => {
    expect(matchPageIdentity("", anchors)).toBeNull();
  });
});

describe("prompts carry the company identity rules", () => {
  it("the system prompt puts identity verification before any extraction", () => {
    expect(AI_SYSTEM_PROMPT).toContain("公司身份核验");
    expect(AI_SYSTEM_PROMPT).toContain("只允许描述这一家公司");
    expect(AI_SYSTEM_PROMPT).toContain("不是目标公司");
    expect(AI_SYSTEM_PROMPT).toContain("当前就职于目标公司");
  });

  it("the user prompt names the target company and bans cross-company data", () => {
    const prompt = buildUserPrompt(customer, "研究数据");
    expect(prompt).toContain("公司名称：Acme Marine Supplies");
    expect(prompt).toContain("严禁写入其他公司的数据");
    expect(prompt).toContain("LinkedIn 页面必须属于目标公司");
  });
});
