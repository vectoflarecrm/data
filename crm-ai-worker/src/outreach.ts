import { AdminEnv } from "./admin";

/* ── Brand definitions ── */
export interface BrandConfig {
  brand_name: string;
  product_category: string; // SUPs | Inflatable boats | RIB boats
  company_intro: string;
  enabled: boolean;
}

export interface OutreachEmail {
  id: number;
  customer_id: number | null;
  company_id: string | null;
  display_id: string | null;
  company_name: string | null;
  email_to: string | null;
  product_category: string | null;
  brand_name: string | null;
  subject: string | null;
  body: string | null;
  status: string;
  sent_at: string | null;
  created_at: string | null;
}

/* ── Default brand configs (placeholders for company intros) ── */
const DEFAULT_BRANDS: BrandConfig[] = [
  {
    brand_name: "Afarer",
    product_category: "SUPs",
    company_intro: "[Afarer公司简介待填写]",
    enabled: false,
  },
  {
    brand_name: "Aquafarer",
    product_category: "Inflatable boats",
    company_intro: "[Aquafarer公司简介待填写]",
    enabled: false,
  },
  {
    brand_name: "Neptunor",
    product_category: "RIB boats",
    company_intro: "[Neptunor公司简介待填写]",
    enabled: false,
  },
];

/* ── Initialize default brand settings if table is empty ── */
export async function initBrandSettings(env: AdminEnv): Promise<void> {
  const count = await env.DB.prepare("SELECT COUNT(*) as cnt FROM outreach_settings")
    .first<{ cnt: number }>();
  if (count && count.cnt > 0) return;

  const stmts = DEFAULT_BRANDS.map((b) =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO outreach_settings (brand_name, product_category, company_intro, enabled) VALUES (?, ?, ?, ?)"
    ).bind(b.brand_name, b.product_category, b.company_intro, b.enabled ? 1 : 0)
  );
  await env.DB.batch(stmts);
}

/* ── Get all brand settings ── */
export async function getBrandSettings(env: AdminEnv): Promise<BrandConfig[]> {
  await initBrandSettings(env);
  const result = await env.DB.prepare(
    "SELECT brand_name, product_category, company_intro, enabled FROM outreach_settings ORDER BY id"
  ).all<{ brand_name: string; product_category: string; company_intro: string; enabled: number }>();
  return result.results.map((r) => ({
    brand_name: r.brand_name,
    product_category: r.product_category,
    company_intro: r.company_intro || "",
    enabled: r.enabled === 1,
  }));
}

/* ── Update a brand setting ── */
export async function updateBrandSetting(
  env: AdminEnv,
  brandName: string,
  updates: Partial<Pick<BrandConfig, "company_intro" | "enabled">>
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (updates.company_intro !== undefined) {
    sets.push("company_intro = ?");
    binds.push(updates.company_intro);
  }
  if (updates.enabled !== undefined) {
    sets.push("enabled = ?");
    binds.push(updates.enabled ? 1 : 0);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = CURRENT_TIMESTAMP");
  binds.push(brandName);
  await env.DB.prepare(`UPDATE outreach_settings SET ${sets.join(", ")} WHERE brand_name = ?`)
    .bind(...binds)
    .run();
}

/* ── Build AI prompt for outreach email generation ── */
function buildOutreachPrompt(
  brand: BrandConfig,
  company: {
    company_name: string | null;
    display_id: string | null;
    domain: string | null;
    first_name: string | null;
    last_name: string | null;
    title: string | null;
    email: string | null;
    products_services: string | null;
    business_tag: string | null;
    customer_segment: string | null;
    country: string | null;
    full_research_text: string | null;
    description: string | null;
  }
): string {
  const contactName = [company.first_name, company.last_name].filter(Boolean).join(" ") || "Sir/Madam";
  const firstName = company.first_name || "there";

  return `你是一名专业的B2B营销专家，擅长撰写针对水上运动行业的个性化开发信。

## 你的身份
你代表 **${brand.brand_name}** 公司，以下是我们公司的简介：
${brand.company_intro}

## 产品类别
我们主要经营：**${brand.product_category}**

## 目标客户信息
- 公司名称：${company.company_name || "未知"}
- 客户ID：${company.display_id || company.company_id}
- 网站：${company.domain || "未知"}
- 联系人：${contactName}（${company.title || "职位未知"}）
- 邮箱：${company.email || "未知"}
- 国家：${company.country || "未知"}
- 经营产品：${company.products_services || "未知"}
- 业务标签：${company.business_tag || "未知"}
- 客户细分：${company.customer_segment || "未知"}
- 公司描述：${company.description || "未知"}
- 完整研究资料：${(company.full_research_text || "").slice(0, 3000)}

## 写作要求

1. **邮件主题（Subject）**：简洁有力，不超过60字符，突出合作价值
2. **邮件正文（Body）**：
   - 开头：用 ${firstName} 称呼，提及他们的公司名和具体业务
   - 中间：介绍 ${brand.brand_name} 的产品如何与他们的业务互补（引用他们的具体产品或业务模式）
   - 结尾：提出具体的合作建议（如样品、报价、展会见面等）
   - 语言：英文，专业但亲切
   - 长度：150-250词
   - 必须个性化：引用该公司的具体产品、市场定位或业务特点
   - 禁止使用模板化的套话

3. **严格禁止**：
   - 编造虚假信息
   - 使用"Dear Sir/Madam"等泛泛称呼（除非确实不知道联系人姓名）
   - 承诺无法兑现的条件

请返回纯JSON格式：
{
  "subject": "邮件主题",
  "body": "邮件正文（纯文本，用\\n换行）"
}`;
}

/* ── Generate outreach emails using AI ── */
export async function generateOutreachEmails(
  env: AdminEnv,
  brandName: string,
  limit: number = 10
): Promise<{ generated: number; errors: string[] }> {
  const brands = await getBrandSettings(env);
  const brand = brands.find((b) => b.brand_name === brandName);
  if (!brand) throw new Error(`Brand ${brandName} not found`);
  if (!brand.enabled) throw new Error(`Brand ${brandName} is not enabled`);
  if (!brand.company_intro || brand.company_intro.startsWith("[")) {
    throw new Error(`Brand ${brandName} company intro not configured`);
  }

  // Find companies that match this product category and have email
  const productKeyword = brand.product_category.toLowerCase();
  const customers = await env.DB.prepare(`
    SELECT id, company_id, display_id, company_name, domain, first_name, last_name,
           title, email, products_services, business_tag, customer_segment, country,
           full_research_text, description
    FROM customers
    WHERE status = 'completed'
      AND email IS NOT NULL AND email != ''
      AND (
        LOWER(products_services) LIKE '%' || ? || '%'
        OR LOWER(customer_segment) LIKE '%' || ? || '%'
        OR LOWER(business_tag) LIKE '%' || ? || '%'
        OR LOWER(description) LIKE '%' || ? || '%'
      )
      AND id NOT IN (
        SELECT customer_id FROM outreach_emails
        WHERE brand_name = ? AND customer_id IS NOT NULL
      )
    LIMIT ?
  `)
    .bind(productKeyword, productKeyword, productKeyword, productKeyword, brandName, limit)
    .all<{
      id: number;
      company_id: string;
      display_id: string | null;
      company_name: string | null;
      domain: string | null;
      first_name: string | null;
      last_name: string | null;
      title: string | null;
      email: string | null;
      products_services: string | null;
      business_tag: string | null;
      customer_segment: string | null;
      country: string | null;
      full_research_text: string | null;
      description: string | null;
    }>();

  const errors: string[] = [];
  let generated = 0;

  for (const customer of customers.results) {
    try {
      const prompt = buildOutreachPrompt(brand, customer);
      const result = await callAiForOutreach(env, prompt);
      if (!result) {
        errors.push(`${customer.display_id || customer.company_id}: AI returned empty`);
        continue;
      }

      await env.DB.prepare(`
        INSERT INTO outreach_emails
          (customer_id, company_id, display_id, company_name, email_to,
           product_category, brand_name, subject, body, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')
      `)
        .bind(
          customer.id,
          customer.company_id,
          customer.display_id,
          customer.company_name,
          customer.email,
          brand.product_category,
          brand.brand_name,
          result.subject,
          result.body
        )
        .run();

      generated++;
      // Rate limit: 2 seconds between AI calls
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      errors.push(`${customer.display_id || customer.company_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { generated, errors };
}

/* ── Call AI to generate outreach email ── */
async function callAiForOutreach(
  env: AdminEnv,
  prompt: string
): Promise<{ subject: string; body: string } | null> {
  // Try Gemini first
  if (env.GEMINI_API_KEY) {
    try {
      return await callGeminiOutreach(env, prompt);
    } catch { /* try next */ }
  }

  // Try OpenAI-compatible APIs (Groq, Mistral, DeepSeek)
  const openaiKeys = [
    { key: env.GROQ_API_KEY, url: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.1-70b-versatile" },
    { key: env.MISTRAL_API_KEY, url: "https://api.mistral.ai/v1/chat/completions", model: "mistral-large-latest" },
    { key: env.DEEPSEEK_API_KEY, url: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat" },
  ];
  for (const api of openaiKeys) {
    if (!api.key) continue;
    try {
      return await callOpenAIOutreach(api.url, api.key, api.model, prompt);
    } catch { /* try next */ }
  }

  return null;
}

async function callGeminiOutreach(
  env: AdminEnv,
  prompt: string
): Promise<{ subject: string; body: string }> {
  const key = env.GEMINI_API_KEY!;
  const model = env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) throw new Error(`Gemini ${response.status}`);
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini empty response");
  return JSON.parse(text);
}

async function callOpenAIOutreach(
  apiUrl: string,
  apiKey: string,
  model: string,
  prompt: string
): Promise<{ subject: string; body: string }> {
  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 1024,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) throw new Error(`API ${response.status}`);
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("API empty response");
  return JSON.parse(content);
}

/* ── Get outreach emails ── */
export async function getOutreachEmails(
  env: AdminEnv,
  filters: { brand?: string; status?: string; limit?: number; offset?: number }
): Promise<{ items: OutreachEmail[]; total: number }> {
  const where: string[] = [];
  const binds: unknown[] = [];

  if (filters.brand) {
    where.push("brand_name = ?");
    binds.push(filters.brand);
  }
  if (filters.status) {
    where.push("status = ?");
    binds.push(filters.status);
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(filters.limit || 50, 200);
  const offset = filters.offset || 0;

  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM outreach_emails ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`
    )
      .bind(...binds, limit, offset)
      .all<OutreachEmail>(),
    env.DB.prepare(`SELECT COUNT(*) as total FROM outreach_emails ${clause}`)
      .bind(...binds)
      .first<{ total: number }>(),
  ]);

  return { items: rows.results, total: count?.total ?? 0 };
}

/* ── Update outreach email status ── */
export async function updateOutreachEmail(
  env: AdminEnv,
  id: number,
  updates: Partial<Pick<OutreachEmail, "status" | "subject" | "body">>
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (updates.status !== undefined) {
    sets.push("status = ?");
    binds.push(updates.status);
    if (updates.status === "sent") {
      sets.push("sent_at = CURRENT_TIMESTAMP");
    }
  }
  if (updates.subject !== undefined) {
    sets.push("subject = ?");
    binds.push(updates.subject);
  }
  if (updates.body !== undefined) {
    sets.push("body = ?");
    binds.push(updates.body);
  }
  if (sets.length === 0) return;
  binds.push(id);
  await env.DB.prepare(`UPDATE outreach_emails SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}

/* ── Delete outreach email ── */
export async function deleteOutreachEmail(env: AdminEnv, id: number): Promise<void> {
  await env.DB.prepare("DELETE FROM outreach_emails WHERE id = ?").bind(id).run();
}

/* ── Get outreach statistics ── */
export async function getOutreachStats(env: AdminEnv): Promise<{
  total: number;
  draft: number;
  sent: number;
  by_brand: Array<{ brand_name: string; count: number }>;
}> {
  const [total, draft, sent, byBrand] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as cnt FROM outreach_emails").first<{ cnt: number }>(),
    env.DB.prepare("SELECT COUNT(*) as cnt FROM outreach_emails WHERE status = 'draft'").first<{ cnt: number }>(),
    env.DB.prepare("SELECT COUNT(*) as cnt FROM outreach_emails WHERE status = 'sent'").first<{ cnt: number }>(),
    env.DB.prepare(
      "SELECT brand_name, COUNT(*) as count FROM outreach_emails GROUP BY brand_name"
    ).all<{ brand_name: string; count: number }>(),
  ]);

  return {
    total: total?.cnt ?? 0,
    draft: draft?.cnt ?? 0,
    sent: sent?.cnt ?? 0,
    by_brand: byBrand.results,
  };
}
