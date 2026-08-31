import { handleAdminRequest } from "./admin";

interface CustomerRow {
  id: number;
  company_id: string;
  domain: string;
  status: string;
  customer_segment: string | null;
  personas_and_solutions: string | null;
  remarks: string | null;
}

interface Env {
  DB: D1Database;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  ADMIN_PANEL_TOKEN?: string;
}

interface CustomerAnalysis {
  customer_segment: string;
  personas_and_solutions: unknown;
  remarks: string;
}

const BATCH_SIZE = 3;
const FETCH_TIMEOUT_MS = 10_000;
const AI_TIMEOUT_MS = 15_000;
const DEFAULT_MODEL = "gemini-2.5-flash-lite";
const COMPANY_MARKER = (companyId: string) => `【合并数据公司ID: ${companyId}】`;

function withCompanyMarker(remarks: string | null | undefined, companyId: string): string {
  const marker = COMPANY_MARKER(companyId);
  const base = (remarks ?? "").trimEnd();
  return base.endsWith(marker) ? base : `${base}${base ? "\n" : ""}${marker}`;
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
        if ((element.getAttribute("name") ?? "").toLowerCase() === "description") {
          addText(element.getAttribute("content") ?? "");
        }
      },
    })
    .on("p", { text(text) { addText(text.text); } });

  await rewriter.transform(response).arrayBuffer();
  return parts.join("\n").slice(0, 12_000);
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
  pageText: string,
  env: Env,
): Promise<CustomerAnalysis> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const model = env.GEMINI_MODEL || DEFAULT_MODEL;
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
              text: "你是 B2B CRM 分析助手。只能根据提供的网页文本作答，不得编造事实。必须只返回一个合法 JSON 对象，禁止 Markdown、代码围栏和额外说明。",
            }],
          },
          contents: [{
            role: "user",
            parts: [{
              text: `请分析以下企业网页信息，并严格按客户细分群体组织客户画像和解决方案。\n\n公司识别码：${customer.company_id}\n企业网址：${customer.domain}\n网页纯文本：\n${pageText || "（未提取到文本）"}`,
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
                          needs: { type: "ARRAY", items: { type: "STRING" } },
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
    if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const content = (
      payload as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
      }
    ).candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof content !== "string") throw new Error("Gemini response has no text content");
    return parseAnalysis(content);
  } finally {
    clearTimeout(timer);
  }
}

async function claimCustomers(env: Env): Promise<CustomerRow[]> {
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
    RETURNING id, company_id, domain, status, customer_segment, personas_and_solutions, remarks
  `).bind(BATCH_SIZE).all<CustomerRow>();
  return result.results;
}

async function processCustomer(customer: CustomerRow, env: Env): Promise<D1PreparedStatement> {
  try {
    const response = await fetchWithTimeout(normalizeDomain(customer.domain), FETCH_TIMEOUT_MS);
    if (!response.ok) throw new Error(`website HTTP ${response.status}`);
    const pageText = await extractPageText(response);
    const analysis = await analyzeCustomer(customer, pageText, env);
    const personas = JSON.stringify(analysis.personas_and_solutions);
    const remarks = withCompanyMarker(analysis.remarks, customer.company_id);
    return env.DB.prepare(`
      UPDATE customers
      SET status = 'completed', customer_segment = ?, personas_and_solutions = ?, remarks = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'processing'
    `).bind(analysis.customer_segment, personas, remarks, customer.id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
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
    const updates = await Promise.all(customers.map((customer) => processCustomer(customer, env)));
    await env.DB.batch(updates);
    ctx.waitUntil(Promise.resolve());
  },
} satisfies ExportedHandler<Env>;
