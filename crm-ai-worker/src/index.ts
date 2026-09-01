import { handleAdminRequest } from "./admin";

interface CustomerRow {
  id: number;
  company_id: string;
  domain: string;
  status: string;
  company_name: string | null;
  country: string | null;
  customer_segment: string | null;
  personas_and_solutions: string | null;
  remarks: string | null;
}

interface Env {
  DB: D1Database;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  GOOGLE_SEARCH_API_KEY?: string;
  GOOGLE_SEARCH_ENGINE_ID?: string;
  SEARLO_API_KEY?: string;
  ADMIN_PANEL_TOKEN?: string;
}

interface GoogleSearchResult {
  title: string;
  link: string;
  snippet: string;
}

interface GoogleSearchResponse {
  items?: Array<{
    title: string;
    link: string;
    snippet: string;
  }>;
}

interface CustomerAnalysis {
  customer_segment: string;
  personas_and_solutions: unknown;
  remarks: string;
}

const BATCH_SIZE = 1;
const FETCH_TIMEOUT_MS = 15_000;
const AI_TIMEOUT_MS = 30_000;
const MAX_SOURCE_PAGES = 5;
const MAX_SEARCH_RESULTS = 5;
const INTER_SOURCE_DELAY_MS = 2_000;
const SEARCH_QUERIES = [
  (name: string, country: string) => `"${name}" ${country} water sports company`,
  (name: string) => `"${name}" distributor dealer inflatable boat SUP kayak`,
  (name: string) => `"${name}" about team contact email phone`,
];
const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash-lite", "gemini-2.0-flash"];
const STALE_PROCESSING_MINUTES = 30;
const RETRYABLE_WEBSITE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const AI_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const INTER_CUSTOMER_DELAY_MS = 5_000;
const RATE_LIMIT_BASE_DELAY_MS = 30_000;
const MAX_RETRIES = 3;
const COMPANY_MARKER = (companyId: string) => `【合并数据公司ID: ${companyId}】`;

function withCompanyMarker(remarks: string | null | undefined, companyId: string): string {
  const marker = COMPANY_MARKER(companyId);
  const base = (remarks ?? "").trimEnd();
  return base.endsWith(marker) ? base : `${base}${base ? "\n" : ""}${marker}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryCount(remarks: string | null | undefined): number {
  if (!remarks) return 0;
  const match = remarks.match(/\[retry:(\d+)\]/);
  return match ? parseInt(match[1], 10) : 0;
}

function stripRetryTag(remarks: string): string {
  return remarks.replace(/\n?\[retry:\d+\]/g, "").trimEnd();
}

function normalizeDomain(value: string): string {
  const candidate = value.trim();
  if (!candidate) throw new Error("domain is empty");
  const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("domain must use HTTP or HTTPS");
  }
  return url.toString();
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "crm-ai-worker/0.1" },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWebsite(url: string): Promise<Response> {
  let response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  if (!RETRYABLE_WEBSITE_STATUSES.has(response.status)) return response;
  await new Promise((resolve) => setTimeout(resolve, 250));
  response = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  return response;
}

function websiteError(response: Response): Error {
  const detail = response.status === 526
    ? " (origin SSL certificate invalid)"
    : response.status === 530
      ? " (origin/DNS unavailable)"
      : "";
  return new Error(`website HTTP ${response.status}${detail}`);
}

async function extractPageText(response: Response): Promise<string> {
  const parts: string[] = [];
  const addText = (text: string) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean) parts.push(clean);
  };

  const rewriter = new HTMLRewriter()
    .on("title", { text(text) { addText(text.text); } })
    .on("meta", {
      element(element) {
        const name = (element.getAttribute("name") ?? "").toLowerCase();
        const prop = (element.getAttribute("property") ?? "").toLowerCase();
        if (name === "description" || prop === "og:description") {
          addText(element.getAttribute("content") ?? "");
        }
        if (name === "keywords") {
          addText("关键词: " + (element.getAttribute("content") ?? ""));
        }
      },
    })
    .on("p", { text(text) { addText(text.text); } })
    .on("h1", { text(text) { addText("[标题] " + text.text); } })
    .on("h2", { text(text) { addText("[小标题] " + text.text); } })
    .on("li", { text(text) { addText("• " + text.text); } });

  await rewriter.transform(response).arrayBuffer();
  return parts.join("\n").slice(0, 15_000);
}

async function extractLinks(response: Response): Promise<string[]> {
  const links: string[] = [];
  const rewriter = new HTMLRewriter()
    .on("a", {
      element(element) {
        const href = element.getAttribute("href") ?? "";
        if (href && (href.includes("linkedin.com") || href.includes("facebook.com") || href.includes("instagram.com") || href.includes("twitter.com") || href.includes("x.com") || href.includes("youtube.com") || href.includes("tiktok.com"))) {
          try {
            const url = new URL(href, response.url);
            links.push(url.toString());
          } catch { /* ignore invalid URLs */ }
        }
      },
    });
  try {
    await rewriter.transform(response.clone()).arrayBuffer();
  } catch { /* ignore */ }
  return [...new Set(links)].slice(0, MAX_SOURCE_PAGES);
}

async function googleSearch(query: string, env: Env): Promise<GoogleSearchResult[]> {
  if (!env.GOOGLE_SEARCH_API_KEY || !env.GOOGLE_SEARCH_ENGINE_ID) return [];
  try {
    const params = new URLSearchParams({
      key: env.GOOGLE_SEARCH_API_KEY,
      cx: env.GOOGLE_SEARCH_ENGINE_ID,
      q: query,
      num: String(MAX_SEARCH_RESULTS),
    });
    const resp = await fetchWithTimeout(
      `https://www.googleapis.com/customsearch/v1?${params.toString()}`,
      FETCH_TIMEOUT_MS,
    );
    if (!resp.ok) return [];
    const data: GoogleSearchResponse = await resp.json();
    return (data.items ?? []).map((item) => ({
      title: item.title,
      link: item.link,
      snippet: item.snippet,
    }));
  } catch {
    return [];
  }
}

async function searloSearch(query: string, env: Env): Promise<GoogleSearchResult[]> {
  if (!env.SEARLO_API_KEY) return [];
  try {
    const resp = await fetchWithTimeout(
      `https://api.searlo.com/search?q=${encodeURIComponent(query)}&num=${MAX_SEARCH_RESULTS}`,
      FETCH_TIMEOUT_MS,
      { headers: { "Authorization": `Bearer ${env.SEARLO_API_KEY}` } },
    );
    if (!resp.ok) return [];
    const data = await resp.json() as { results?: Array<{ title: string; url: string; snippet: string }> };
    return (data.results ?? []).map((item) => ({
      title: item.title,
      link: item.url,
      snippet: item.snippet,
    }));
  } catch {
    return [];
  }
}

async function duckduckgoSearch(query: string): Promise<GoogleSearchResult[]> {
  try {
    const resp = await fetchWithTimeout(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      FETCH_TIMEOUT_MS,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; CRM-ResearchBot/1.0)" } },
    );
    if (!resp.ok) return [];
    const html = await resp.text();
    const results: GoogleSearchResult[] = [];
    // Extract search results from DuckDuckGo HTML
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([^<]+)<\/a>/g;
    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < MAX_SEARCH_RESULTS) {
      results.push({
        title: match[2].replace(/<[^>]+>/g, "").trim(),
        link: match[1],
        snippet: match[3].replace(/<[^>]+>/g, "").trim(),
      });
    }
    // Fallback: simpler regex
    if (results.length === 0) {
      const simpleRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      while ((match = simpleRegex.exec(html)) !== null && results.length < MAX_SEARCH_RESULTS) {
        const title = match[2].replace(/<[^>]+>/g, "").trim();
        if (title && !title.startsWith("http")) {
          results.push({ title, link: match[1], snippet: "" });
        }
      }
    }
    return results;
  } catch {
    return [];
  }
}

async function multiEngineSearch(query: string, env: Env): Promise<GoogleSearchResult[]> {
  // Try Google first, then Searlo, then DuckDuckGo
  let results = await googleSearch(query, env);
  if (results.length > 0) return results;

  results = await searloSearch(query, env);
  if (results.length > 0) return results;

  results = await duckduckgoSearch(query);
  return results;
}

async function searchCompanyInfo(companyName: string, country: string, env: Env): Promise<string> {
  const allResults: GoogleSearchResult[] = [];
  const seenUrls = new Set<string>();

  for (const queryFn of SEARCH_QUERIES) {
    const query = queryFn(companyName, country);
    const results = await multiEngineSearch(query, env);
    for (const r of results) {
      if (!seenUrls.has(r.link)) {
        seenUrls.add(r.link);
        allResults.push(r);
      }
    }
    await sleep(INTER_SOURCE_DELAY_MS);
  }

  if (allResults.length === 0) return "";

  // Fetch content from top search results
  const pages: string[] = [];
  for (const result of allResults.slice(0, MAX_SEARCH_RESULTS)) {
    try {
      // Skip the company's own website (already fetched)
      const resp = await fetchWithTimeout(result.link, FETCH_TIMEOUT_MS);
      if (resp.ok) {
        const text = await extractPageText(resp);
        if (text.length > 100) {
          pages.push(`\n=== 搜索结果: ${result.title} ===\nURL: ${result.link}\n摘要: ${result.snippet}\n内容: ${text.slice(0, 2_000)}`);
        }
      }
      await sleep(INTER_SOURCE_DELAY_MS);
    } catch { /* skip failed pages */ }
  }

  return pages.length > 0
    ? `\n\n--- Google 搜索结果 (${allResults.length}条) ---\n${pages.join("\n")}`
    : `\n\n--- Google 搜索摘要 (${allResults.length}条) ---\n${allResults.map((r) => `${r.title}: ${r.snippet}`).join("\n")}`;
}

async function fetchAdditionalSources(companyName: string, domain: string, env: Env): Promise<string> {
  const sources: string[] = [];
  const sourceLabels: string[] = [];

  // 1. Try fetching About/Contact/Team pages from the same domain
  const subPages = ["/about", "/about-us", "/contact", "/team", "/company", "/products", "/services"];
  for (const path of subPages) {
    if (sources.length >= 3) break;
    try {
      const url = normalizeDomain(domain.replace(/\/$/, "") + path);
      const resp = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if (resp.ok) {
        const text = await extractPageText(resp);
        if (text.length > 100) {
          sources.push(`\n=== ${path} 页面内容 ===\n${text.slice(0, 3_000)}`);
          sourceLabels.push(path);
        }
      }
      await sleep(INTER_SOURCE_DELAY_MS);
    } catch { /* skip failed sub-pages */ }
  }

  // 2. Try fetching social media links found on the main website
  try {
    const mainResp = await fetchWithTimeout(normalizeDomain(domain), FETCH_TIMEOUT_MS);
    if (mainResp.ok) {
      const socialLinks = await extractLinks(mainResp);
      for (const link of socialLinks.slice(0, 3)) {
        try {
          const resp = await fetchWithTimeout(link, FETCH_TIMEOUT_MS);
          if (resp.ok) {
            const text = await extractPageText(resp);
            if (text.length > 100) {
              const platform = link.includes("linkedin") ? "LinkedIn" : link.includes("facebook") ? "Facebook" : link.includes("instagram") ? "Instagram" : "社交媒体";
              sources.push(`\n=== ${platform} 页面内容 ===\n${text.slice(0, 3_000)}`);
              sourceLabels.push(platform);
            }
          }
          await sleep(INTER_SOURCE_DELAY_MS);
        } catch { /* skip failed social pages */ }
      }
    }
  } catch { /* skip if main site fails */ }

  return sources.length > 0
    ? `\n\n--- 额外信息来源 (${sourceLabels.join(", ")}) ---\n${sources.join("\n")}`
    : "";
}

function parseAnalysis(content: string): CustomerAnalysis {
  const trimmed = content.trim();
  if (trimmed.startsWith("```") || trimmed.endsWith("```")) {
    throw new Error("AI response was not pure JSON");
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("AI response must be a JSON object");
  }
  const object = parsed as Record<string, unknown>;
  if (typeof object.customer_segment !== "string" || !object.customer_segment.trim()) {
    throw new Error("AI response has no valid customer_segment");
  }
  if (typeof object.remarks !== "string") {
    throw new Error("AI response has no valid remarks");
  }
  if (!("personas_and_solutions" in object)) {
    throw new Error("AI response has no personas_and_solutions");
  }
  return {
    customer_segment: object.customer_segment.trim(),
    personas_and_solutions: object.personas_and_solutions,
    remarks: object.remarks.trim(),
  };
}

async function analyzeCustomer(
  customer: CustomerRow,
  researchContext: string,
  env: Env,
): Promise<CustomerAnalysis> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const requestedModel = env.GEMINI_MODEL || DEFAULT_MODEL;
    const models = [requestedModel, ...FALLBACK_MODELS].filter(
      (model, index, all) => all.indexOf(model) === index,
    );
    let lastModelError = "Gemini model is unavailable";
    for (const model of models) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            "x-goog-api-key": env.GEMINI_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{
                text: `你是一名高级B2B市场数据分析师，专注于水上运动行业（inflatable boats, RIB boats, SUPs, kayaks, yachts, kitesurfing, windsurfing等）。

你的核心原则：
1. 数据真实性高于一切——宁可留空，绝不编造
2. 只根据提供的多源信息作答，不得编造任何事实
3. 如果信息不足，明确标注"信息不足，需进一步验证"
4. 必须只返回一个合法JSON对象，禁止Markdown、代码围栏和额外说明

分析要求：
- 交叉验证多个信息来源，确保数据准确
- 识别公司的核心业务模式（制造商/分销商/零售商/租赁/培训等）
- 分析其在水上运动行业的具体定位
- 识别关键决策者和采购负责人
- 评估其作为潜在客户的价值`,
              }],
            },
            contents: [{
              role: "user",
              parts: [{
                text: `请深度分析以下企业信息，交叉验证多个来源的数据，提供详细的客户画像。

## 基本信息
- 公司识别码：${customer.company_id}
- 企业网址：${customer.domain}

## 多源研究数据
${researchContext || "（未获取到有效信息）"}

## 分析要求
1. 客户细分：该公司的核心业务是什么？在水上运动行业中扮演什么角色？
2. 客户画像：识别2-5个关键角色（如采购经理、产品总监、创始人等），分析每个角色的需求和痛点
3. 解决方案：针对每个角色，提供具体的解决方案建议
4. 备注：总结公司的关键信息、潜在合作机会和风险点
5. 信息来源标注：注明分析结论来自哪个信息来源`,
              }],
            }],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  customer_segment: { type: "STRING" },
                  personas_and_solutions: {
                    type: "OBJECT",
                    properties: {
                      personas: {
                        type: "ARRAY",
                        items: {
                          type: "OBJECT",
                          properties: {
                            name: { type: "STRING" },
                            role: { type: "STRING" },
                            needs: { type: "ARRAY", items: { type: "STRING" } },
                            pain_points: { type: "ARRAY", items: { type: "STRING" } },
                          },
                          required: ["name", "needs"],
                        },
                      },
                      solutions: {
                        type: "ARRAY",
                        items: {
                          type: "OBJECT",
                          properties: {
                            name: { type: "STRING" },
                            value: { type: "STRING" },
                            target_persona: { type: "STRING" },
                          },
                          required: ["name", "value"],
                        },
                      },
                    },
                    required: ["personas", "solutions"],
                  },
                  remarks: { type: "STRING" },
                },
                required: ["customer_segment", "personas_and_solutions", "remarks"],
              },
            },
          }),
        },
      );
      if (response.ok) {
        const payload: unknown = await response.json();
        const content = (
          payload as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
          }
        ).candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof content !== "string") throw new Error("Gemini response has no text content");
        return parseAnalysis(content);
      }

      const errorBody = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 240);
      lastModelError = `Gemini HTTP ${response.status}${errorBody ? `: ${errorBody}` : ""}`;

      // 429 = rate limit, 503 = model overloaded: try next model
      if (response.status !== 404) throw new Error(lastModelError);
    }
    throw new Error(lastModelError);
  } finally {
    clearTimeout(timer);
  }
}

async function claimCustomers(env: Env): Promise<CustomerRow[]> {
  // Recover jobs abandoned by a timed-out invocation before claiming new work.
  await env.DB.prepare(`
    UPDATE customers
    SET status = 'pending', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'processing'
      AND updated_at < datetime('now', '-${STALE_PROCESSING_MINUTES} minutes')
  `).run();

  // One UPDATE atomically claims the first three pending rows. This avoids the
  // SELECT-then-UPDATE race between overlapping Cron invocations.
  const result = await env.DB.prepare(`
    UPDATE customers
    SET status = 'processing', updated_at = CURRENT_TIMESTAMP
    WHERE id IN (
      SELECT id FROM customers
      WHERE status = 'pending'
      ORDER BY id
      LIMIT ?
    )
    RETURNING id, company_id, domain, status, company_name, country, customer_segment, personas_and_solutions, remarks
  `).bind(BATCH_SIZE).all<CustomerRow>();
  return result.results;
}

function isRetryableAiError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  // Gemini429 (rate limit),500/502/503/504 (server errors) are retryable
  for (const code of AI_RETRYABLE_STATUSES) {
    if (msg.includes(`HTTP ${code}`)) return true;
  }
  return false;
}

async function processCustomer(customer: CustomerRow, env: Env): Promise<D1PreparedStatement> {
  const retryCount = getRetryCount(customer.remarks);
  try {
    // Step 1: Fetch main website
    let pageText = "";
    try {
      const response = await fetchWebsite(normalizeDomain(customer.domain));
      if (!response.ok) throw websiteError(response);
      pageText = await extractPageText(response);
    } catch (e) {
      // If main site fails, continue with empty text — additional sources may still work
      if (e instanceof Error && !e.message.includes("HTTP 404")) {
        // For non-404 errors, still try to gather info from other sources
      } else {
        throw e; // 404 on main site is fatal
      }
    }

    // Step 2: Google search for company information
    const companyName = customer.company_name || customer.company_id;
    const country = customer.country || "";
    const googleResults = await searchCompanyInfo(companyName, country, env);

    // Step 3: Fetch additional sources (sub-pages, social media)
    const additionalText = await fetchAdditionalSources(companyName, customer.domain, env);

    // Step 4: Combine all research data
    const researchContext = pageText
      ? `=== 主网站内容 ===\n${pageText}${googleResults}${additionalText}`
      : `=== 主网站无法访问 ===${googleResults}${additionalText}`;

    if (researchContext.length < 50) {
      throw new Error("无法从任何来源获取有效信息");
    }

    // Step 4: AI deep analysis
    const analysis = await analyzeCustomer(customer, researchContext, env);
    const personas = JSON.stringify(analysis.personas_and_solutions);
    const remarks = withCompanyMarker(analysis.remarks, customer.company_id);
    return env.DB.prepare(`
      UPDATE customers
      SET status = 'completed', customer_segment = ?, personas_and_solutions = ?, remarks = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'processing'
    `).bind(analysis.customer_segment, personas, remarks, customer.id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const shouldRetry = isRetryableAiError(error) && retryCount < MAX_RETRIES;

    if (shouldRetry) {
      const cleanRemarks = stripRetryTag(customer.remarks ?? "");
      const nextRetryTag = `\n[retry:${retryCount + 1}]`;
      const remarks = withCompanyMarker(`${cleanRemarks}${nextRetryTag}处理失败（第${retryCount + 1}次重试）：${reason}`, customer.company_id);
      return env.DB.prepare(`
        UPDATE customers
        SET status = 'pending', remarks = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'processing'
      `).bind(remarks, customer.id);
    }

    const remarks = withCompanyMarker(`处理失败：${reason}`, customer.company_id);
    return env.DB.prepare(`
      UPDATE customers
      SET status = 'failed', remarks = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'processing'
    `).bind(remarks, customer.id);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const adminResponse = await handleAdminRequest(request, env);
    return adminResponse ?? new Response("Not Found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const customers = await claimCustomers(env);
    if (!customers.length) return;
    // Process sequentially with delays to respect Gemini rate limits
    const updates: D1PreparedStatement[] = [];
    for (let i = 0; i < customers.length; i++) {
      if (i > 0) await sleep(INTER_CUSTOMER_DELAY_MS);
      updates.push(await processCustomer(customers[i], env));
    }
    await env.DB.batch(updates);
    ctx.waitUntil(Promise.resolve());
  },
} satisfies ExportedHandler<Env>;
