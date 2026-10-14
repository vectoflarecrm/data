import { describe, it, expect } from "vitest";
import {
  buildIdentityAnchors,
  matchPageIdentity,
  sanitizeFoundContacts,
  extractOwnContent,
  cleanResearchContextForAi,
  AI_SYSTEM_PROMPT,
  buildUserPrompt,
  type CustomerRow,
  type CustomerAnalysis,
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

/* 抓取精度第三层：确定性联系人过滤。提示词要求模型逐来源比对并舍弃异
 * 司内容（可审计），这一层用规则兜底——从目录/榜单页漏进 found_contacts
 * 的别家公司企业邮箱、公司主页等非人物 LinkedIn 页，在入库前被剔除。
 * 公共邮箱服务商、目标自家域名（含子域）、自家网页原文逐字出现的邮箱
 * 不受影响；绝不过滤电话/WhatsApp/姓名。 */
const baseAnalysis: CustomerAnalysis = {
  customer_segment: "Distributor",
  product_categories: "Inflatable Boats",
  company_size: "Small",
  geographic_coverage: "National",
  business_type: "Wholesale",
  product_category: "Inflatable Boats",
  target_market: "Europe",
  personas_and_solutions: [],
  found_contacts: [],
  company_profile: null,
  outreach_context: null,
  field_evidence: [],
  buying_signals: [],
  remarks: "已舍弃来源: 无",
};

describe("sanitizeFoundContacts", () => {
  it("keeps emails on the customer's own domain, including subdomains", () => {
    const analysis: CustomerAnalysis = { ...baseAnalysis, found_contacts: [
      { first_name: "Ana", last_name: "Lopez", email: "sales@acme-marine.example" },
      { first_name: "Luis", last_name: "Ortega", email: "luis@mail.acme-marine.example" },
    ] };
    const out = sanitizeFoundContacts(analysis, "", "acme-marine.example");
    expect(out.found_contacts[0].email).toBe("sales@acme-marine.example");
    expect(out.found_contacts[1].email).toBe("luis@mail.acme-marine.example");
  });

  it("keeps public-provider emails regardless of the customer domain", () => {
    const analysis: CustomerAnalysis = { ...baseAnalysis, found_contacts: [
      { first_name: "Marco", last_name: "Rossi", email: "marco.rossi@gmail.com" },
    ] };
    const out = sanitizeFoundContacts(analysis, "", "acme-marine.example");
    expect(out.found_contacts[0].email).toBe("marco.rossi@gmail.com");
  });

  it("strips foreign corporate emails scraped from directory pages", () => {
    const analysis: CustomerAnalysis = { ...baseAnalysis, found_contacts: [
      { first_name: "Elena", last_name: "Garcia", title: "CEO", email: "elena@bluewave-boats.example" },
    ] };
    const out = sanitizeFoundContacts(analysis, "", "acme-marine.example");
    expect(out.found_contacts[0].email).toBeUndefined();
    // The person row survives (name still present); only the wrong email is gone.
    expect(out.found_contacts[0].title).toBe("CEO");
  });

  it("keeps a separate-mail-domain email when it appears verbatim in the customer's own pages", () => {
    const analysis: CustomerAnalysis = { ...baseAnalysis, found_contacts: [
      { first_name: "Ana", last_name: "Lopez", email: "compras@acmemarine-mail.example" },
    ] };
    const own = "Email: compras@acmemarine-mail.example (采购部)";
    const out = sanitizeFoundContacts(analysis, own, "acme-marine.example");
    expect(out.found_contacts[0].email).toBe("compras@acmemarine-mail.example");
  });

  it("drops contacts left with nothing after cleaning", () => {
    const analysis: CustomerAnalysis = { ...baseAnalysis, found_contacts: [
      { email: "info@bluewave-boats.example" },
      { first_name: "Ana", email: "sales@acme-marine.example" },
    ] };
    const out = sanitizeFoundContacts(analysis, "", "acme-marine.example");
    expect(out.found_contacts).toHaveLength(1);
    expect(out.found_contacts[0].first_name).toBe("Ana");
  });

  it("clears non-person LinkedIn URLs but keeps person profiles", () => {
    const analysis: CustomerAnalysis = { ...baseAnalysis, found_contacts: [
      { first_name: "Ana", last_name: "Lopez", linkedin_url: "https://www.linkedin.com/in/ana-lopez-acme/" },
      { first_name: "Bob", last_name: "Nil", linkedin_url: "https://www.linkedin.com/company/bluewave-boats/" },
    ] };
    const out = sanitizeFoundContacts(analysis, "", "acme-marine.example");
    expect(out.found_contacts[0].linkedin_url).toContain("/in/");
    expect(out.found_contacts[1].linkedin_url).toBeUndefined();
  });

  it("handles a missing customer domain without throwing", () => {
    const analysis: CustomerAnalysis = { ...baseAnalysis, found_contacts: [
      { first_name: "A", email: "a@gmail.com" },
      { first_name: "B", email: "b@bluewave-boats.example" },
    ] };
    const out = sanitizeFoundContacts(analysis, "", "");
    expect(out.found_contacts[0].email).toBe("a@gmail.com");
    expect(out.found_contacts[1].email).toBeUndefined();
  });

  it("leaves the rest of the analysis untouched", () => {
    const out = sanitizeFoundContacts(baseAnalysis, "", "acme-marine.example");
    expect(out.customer_segment).toBe("Distributor");
    expect(out.remarks).toBe("已舍弃来源: 无");
  });
});

describe("extractOwnContent", () => {
  const savedResearch = [
    "=== 主网站内容 ===",
    "Acme Marine Supplies, wholesale of inflatable boats. sales@acme-marine.example",
    "",
    "--- 搜索结果页面 (2条) ---",
    "Bluewave Boats: elena@bluewave-boats.example",
    "",
    "--- 额外信息来源 (/about, LinkedIn) ---",
    "=== /about 页面内容 ===",
    "Founded in 1998 in Valencia.",
    "=== LinkedIn 页面内容 ===",
    "Acme Marine | LinkedIn company page",
  ].join("\n");

  it("pulls the main-website and additional blocks, skipping third-party search pages", () => {
    const own = extractOwnContent(savedResearch);
    expect(own).toContain("sales@acme-marine.example");
    expect(own).toContain("Founded in 1998");
    expect(own).not.toContain("bluewave-boats.example");
  });

  it("does not truncate the additional block at its internal sub-headers", () => {
    const own = extractOwnContent(savedResearch);
    expect(own).toContain("LinkedIn company page");
  });

  it("returns empty text when no own-source blocks exist", () => {
    expect(extractOwnContent("--- 搜索结果页面 (1条) ---\nother")).toBe("");
  });
});

/* 抓取信息降噪：电商 UI 按钮、cookie/GDPR 弹窗、语言切换器、分页等零信
 * 号行在送入 AI 前删除；地址/电话/价格/批发等 B2B 线索行必须保留。 */
describe("cleanResearchContextForAi removes UI noise but keeps B2B signal lines", () => {
  it("drops e-commerce UI, consent and language-switcher lines", () => {
    const raw = [
      "=== 主网站内容 ===",
      "Add to cart",
      "Shop now",
      "We use cookies to improve your experience",
      "EN | DE | FR",
      "Next",
      "Previous page",
      "Subscribe to our newsletter",
      "Your email address*",
      "Wholesale inflatable boats and RIB tender",
      "Calle del Mar 12, 46003 Valencia, Spain",
      "Tel: +34 963 123 456",
      "Price: EUR 1,299 per unit",
    ].join("\n");
    const cleaned = cleanResearchContextForAi(raw);
    expect(cleaned).not.toContain("Add to cart");
    expect(cleaned).not.toContain("Shop now");
    expect(cleaned).not.toContain("We use cookies");
    expect(cleaned).not.toContain("EN | DE | FR");
    expect(cleaned).not.toContain("Subscribe to our newsletter");
    expect(cleaned).not.toContain("Your email address");
    expect(cleaned).toContain("Wholesale inflatable boats");
    expect(cleaned).toContain("Calle del Mar 12");
    expect(cleaned).toContain("+34 963 123 456");
    expect(cleaned).toContain("EUR 1,299");
  });
});

describe("prompts require per-source comparison and a discard audit line", () => {
  it("the system prompt demands per-source comparison and a remarks audit line", () => {
    expect(AI_SYSTEM_PROMPT).toContain("逐来源比对");
    expect(AI_SYSTEM_PROMPT).toContain("已舍弃来源");
  });

  it("the user prompt repeats the comparison step and the audit line", () => {
    const prompt = buildUserPrompt(customer, "研究数据");
    expect(prompt).toContain("逐来源比对");
    expect(prompt).toContain("已舍弃来源");
  });
});
