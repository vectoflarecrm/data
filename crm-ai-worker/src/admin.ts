import {
  getBrandSettings,
  updateBrandSetting,
  generateOutreachEmails,
  getOutreachEmails,
  updateOutreachEmail,
  deleteOutreachEmail,
  getOutreachStats,
} from "./outreach";
import {
  getQuota,
  sendOutreachEmail,
  sendDelayMs,
  GmailEnv,
  GmailConfigError,
} from "./gmail";
import { invalidateProviderCache } from "./provider-keys";
import { parseBulkKeyEntries } from "./bulk-keys";

export interface AdminEnv extends GmailEnv {
  DB: D1Database;
  ADMIN_PANEL_TOKEN?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_API_KEY_2?: string;
  GEMINI_API_KEY_3?: string;
  GEMINI_API_KEY_4?: string;
  GEMINI_API_KEY_5?: string;
  GEMINI_API_KEY_6?: string;
  GEMINI_API_KEY_7?: string;
  GEMINI_API_KEY_8?: string;
  GEMINI_API_KEY_9?: string;
  GEMINI_API_KEY_10?: string;
  GEMINI_API_KEY_11?: string;
  GEMINI_API_KEY_12?: string;
  GEMINI_API_KEY_13?: string;
  GEMINI_API_KEY_14?: string;
  GEMINI_API_KEY_15?: string;
  GEMINI_API_KEY_16?: string;
  GEMINI_API_KEY_17?: string;
  GEMINI_API_KEY_18?: string;
  GEMINI_API_KEY_19?: string;
  GEMINI_API_KEY_20?: string;
  GEMINI_API_KEY_21?: string;
  GEMINI_API_KEY_22?: string;
  GEMINI_API_KEY_23?: string;
  GEMINI_API_KEY_24?: string;
  GEMINI_API_KEY_25?: string;
  GEMINI_API_KEY_26?: string;
  GEMINI_API_KEY_27?: string;
  GEMINI_API_KEY_28?: string;
  GEMINI_API_KEY_29?: string;
  GEMINI_API_KEY_30?: string;
  GEMINI_API_KEY_31?: string;
  GEMINI_API_KEY_32?: string;
  GEMINI_API_KEY_33?: string;
  GEMINI_API_KEY_34?: string;
  GEMINI_API_KEY_35?: string;
  GEMINI_API_KEY_36?: string;
  GEMINI_API_KEY_37?: string;
  GEMINI_API_KEY_38?: string;
  GEMINI_API_KEY_39?: string;
  GEMINI_API_KEY_40?: string;
  GROQ_API_KEY?: string;
  GROQ_API_KEY_2?: string;
  GROQ_MODEL?: string;
  CEREBRAS_API_KEY?: string;
  CEREBRAS_API_KEY_2?: string;
  CEREBRAS_MODEL?: string;
  ZHIPU_API_KEY?: string;
  ZHIPU_API_KEY_2?: string;
  ZHIPU_MODEL?: string;
  NVIDIA_API_KEY?: string;
  NVIDIA_API_KEY_2?: string;
  NVIDIA_MODEL?: string;
  AMD_API_KEY?: string;
  AMD_API_KEY_2?: string;
  AMD_MODEL?: string;
  MISTRAL_API_KEY?: string;
  MISTRAL_API_KEY_2?: string;
  MISTRAL_MODEL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_API_KEY_2?: string;
  DEEPSEEK_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_API_KEY_2?: string;
  OPENROUTER_API_KEY_3?: string;
  OPENROUTER_MODEL?: string;
  BRAVE_API_KEY?: string;
  BRAVE_API_KEY_2?: string;
  FIRECRAWL_API_KEY?: string;
  // Optional total-RPM limiter overrides (see src/rate-limit.ts)
  GEMINI_RPM?: string;
  GROQ_RPM?: string;
  CEREBRAS_RPM?: string;
  MISTRAL_RPM?: string;
  DEEPSEEK_RPM?: string;
  ZHIPU_RPM?: string;
  NVIDIA_RPM?: string;
  AMD_RPM?: string;
  OPENROUTER_RPM?: string;
  // Cloudflare API credentials for the panel's secret-management page
  // (bootstrap once via CI/`wrangler secret put`; keys then rotate in-panel)
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  WORKER_SCRIPT_NAME?: string;
}

interface AdminCustomer {
  id: number;
  company_id: string;
  domain: string;
  status: string;
  company_name: string | null;
  legal_name: string | null;
  trading_name: string | null;
  normalized_domain: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  title: string | null;
  department: string | null;
  linkedin_url: string | null;
  street_address: string | null;
  zip_city: string | null;
  country: string | null;
  country_code: string | null;
  region: string | null;
  city: string | null;
  postal_code: string | null;
  tel: string | null;
  email: string | null;
  cellphone: string | null;
  whatsapp: string | null;
  products_services: string | null;
  business_tag: string | null;
  industry: string | null;
  company_type: string | null;
  business_model: string | null;
  founded_year: number | null;
  employee_range: string | null;
  description: string | null;
  target_markets: string | null;
  is_manufacturer: number | null;
  is_importer: number | null;
  is_distributor: number | null;
  is_wholesaler: number | null;
  is_retailer: number | null;
  is_ecommerce: number | null;
  is_rental: number | null;
  is_oem: number | null;
  social_accounts: string | null;
  customer_segment: string | null;
  personas_and_solutions: string | null;
  remarks: string | null;
  updated_at: string;
}

const CUSTOMER_COLUMNS = `
  id, company_id, display_id, domain, status, company_name, legal_name, trading_name, normalized_domain,
  first_name, last_name, full_name, title, department, linkedin_url,
  street_address, zip_city, country, country_code, region, city, postal_code,
  tel, email, cellphone, whatsapp, products_services, business_tag,
  industry, company_type, business_model, founded_year, employee_range,
  description, target_markets, is_manufacturer, is_importer, is_distributor,
  is_wholesaler, is_retailer, is_ecommerce, is_rental, is_oem, social_accounts,
  full_research_text, social_accounts_verified, customer_segment,
  product_categories, company_size, geographic_coverage,
  personas_and_solutions, remarks, updated_at
`;
const CUSTOMER_STATUSES = new Set(["pending", "processing", "completed", "failed"]);
const COOKIE_NAME = "crm_admin_token";
const SESSION_MAX_AGE = 60 * 60;

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function readCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("Cookie")?.split(";") ?? [];
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

async function constantTimeSecretMatch(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

async function isAuthenticated(request: Request, env: AdminEnv): Promise<boolean> {
  if (!env.ADMIN_PANEL_TOKEN) return false;
  const authorization = request.headers.get("Authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;
  const candidate = bearer || readCookie(request, COOKIE_NAME);
  return candidate ? constantTimeSecretMatch(candidate, env.ADMIN_PANEL_TOKEN) : false;
}

function authFailure(request: Request): Response {
  if (new URL(request.url).pathname.startsWith("/admin/api/")) {
    return jsonResponse({ detail: "Admin authentication required" }, 401);
  }
  return htmlResponse(ADMIN_LOGIN_HTML, 401);
}

function validateText(value: unknown, field: string, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  if (value.length > maxLength) throw new Error(`${field} is too long`);
  return value.trim();
}

function validateDomain(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("domain is required");
  const candidate = value.trim();
  const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("domain must use HTTP or HTTPS");
  }
  return url.toString();
}

function normalizePersonaJson(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("personas_and_solutions must be valid JSON");
    }
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("personas_and_solutions must be a JSON object or array");
  }
  const serialized = JSON.stringify(parsed);
  if (serialized.length > 30_000) throw new Error("personas_and_solutions is too long");
  return serialized;
}

function parseCustomerId(pathname: string): number | null {
  const match = pathname.match(/^\/admin\/api\/customers\/(\d+)$/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

interface ContactRow {
  id: number;
  contact_id: string;
  company_id: string;
  seq: number;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  title: string | null;
  department: string | null;
  email: string | null;
  cellphone: string | null;
  tel: string | null;
  whatsapp: string | null;
  linkedin_url: string | null;
  social_accounts: string | null;
}

async function getCustomer(env: AdminEnv, id: number): Promise<AdminCustomer | null> {
  const result = await env.DB.prepare(
    `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id = ? LIMIT 1`,
  )
    .bind(id)
    .first<AdminCustomer>();
  return result ?? null;
}

async function getCustomerContacts(env: AdminEnv, companyId: string): Promise<ContactRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, contact_id, company_id, seq, first_name, last_name, full_name, title, department, email, cellphone, tel, whatsapp, linkedin_url, social_accounts FROM contacts WHERE company_id = ? ORDER BY seq`,
  )
    .bind(companyId)
    .all<ContactRow>();
  return result.results;
}

async function listCustomers(request: Request, env: AdminEnv): Promise<Response> {
  const url = new URL(request.url);
  const search = (url.searchParams.get("q") ?? "").trim();
  const status = (url.searchParams.get("status") ?? "").trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 100);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
  const where: string[] = [];
  const bindings: Array<string | number> = [];

  if (search) {
    where.push("(company_id LIKE ? OR domain LIKE ? OR company_name LIKE ? OR customer_segment LIKE ? OR product_categories LIKE ? OR country LIKE ? OR remarks LIKE ?)");
    const pattern = `%${search}%`;
    bindings.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern);
  }
  if (status) {
    if (!CUSTOMER_STATUSES.has(status)) return jsonResponse({ detail: "Invalid status" }, 400);
    where.push("status = ?");
    bindings.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT ${CUSTOMER_COLUMNS} FROM customers ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
      .bind(...bindings, limit, offset)
      .all<AdminCustomer>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM customers ${clause}`)
      .bind(...bindings)
      .first<{ total: number }>(),
  ]);
  return jsonResponse({
    items: rows.results,
    total: count?.total ?? 0,
    limit,
    offset,
  });
}

async function updateCustomer(request: Request, env: AdminEnv, id: number): Promise<Response> {
  const existing = await getCustomer(env, id);
  if (!existing) return jsonResponse({ detail: "Customer not found" }, 404);

  let payload: Record<string, unknown>;
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonResponse({ detail: "JSON object required" }, 400);
    }
    payload = body as Record<string, unknown>;
  } catch {
    return jsonResponse({ detail: "Invalid JSON body" }, 400);
  }

  try {
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    if ("domain" in payload) {
      assignments.push("domain = ?");
      values.push(validateDomain(payload.domain));
    }
    if ("status" in payload) {
      if (typeof payload.status !== "string" || !CUSTOMER_STATUSES.has(payload.status)) {
        return jsonResponse({ detail: "Invalid status" }, 400);
      }
      assignments.push("status = ?");
      values.push(payload.status);
    }
    if ("customer_segment" in payload) {
      assignments.push("customer_segment = ?");
      values.push(validateText(payload.customer_segment, "customer_segment", 200));
    }
    if ("personas_and_solutions" in payload) {
      assignments.push("personas_and_solutions = ?");
      values.push(normalizePersonaJson(payload.personas_and_solutions));
    }
    if ("remarks" in payload) {
      assignments.push("remarks = ?");
      values.push(validateText(payload.remarks, "remarks", 10_000));
    }
    if (!assignments.length) return jsonResponse({ detail: "No editable fields supplied" }, 400);

    const updated = await env.DB.prepare(
      `UPDATE customers SET ${assignments.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING ${CUSTOMER_COLUMNS}`,
    )
      .bind(...values, id)
      .first<AdminCustomer>();
    return jsonResponse(updated ?? { detail: "Customer not found" }, updated ? 200 : 404);
  } catch (error) {
    return jsonResponse(
      { detail: error instanceof Error ? error.message : "Invalid customer data" },
      400,
    );
  }
}

/* ── Dynamic provider key management (方案B: D1 api_configs, no deploy needed) ── */

const PANEL_PROVIDERS = [
  "gemini", "groq", "cerebras", "zhipu", "nvidia", "amd", "mistral", "deepseek", "openrouter",
  "tavily", "exa", "brave", "searlo",
] as const;

async function handleProviderKeysApi(request: Request, env: AdminEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // GET /admin/api/keys — list all provider keys + settings
  if (request.method === "GET" && path === "/admin/api/keys") {
    const [keys, settings, cooldowns, history] = await Promise.all([
      env.DB.prepare(
        `SELECT id, provider, label, api_key, rpm_limit, is_active, model, last_error, last_used_at, created_at
         FROM api_configs ORDER BY provider, id`,
      ).all<Record<string, unknown>>(),
      env.DB.prepare(`SELECT provider, default_model, rpm_total, enabled FROM provider_settings ORDER BY provider`)
        .all<Record<string, unknown>>(),
      // Active cooldowns (api_key_health rows written by the runtime when a
      // key returns 429/401/403). key_index holds the health name
      // "<provider>:<keyId>" so it maps directly onto api_configs row ids.
      env.DB.prepare(
        `SELECT provider, key_index, exhausted_until, last_error FROM api_key_health
         WHERE exhausted_until IS NOT NULL AND exhausted_until > datetime('now')
         ORDER BY provider, key_index`,
      ).all<Record<string, unknown>>(),
      // Expired cooldowns stay in the table (rows are upserted, never pruned
      // on expiry) — surface the most recent 20 as a lightweight history log.
      env.DB.prepare(
        `SELECT provider, key_index, exhausted_until, last_error, updated_at FROM api_key_health
         WHERE exhausted_until IS NOT NULL AND exhausted_until <= datetime('now')
         ORDER BY updated_at DESC LIMIT 20`,
      ).all<Record<string, unknown>>(),
    ]);
    // Mask keys: show only a short prefix for identification
    const rows = (keys.results ?? []).map((row) => ({
      ...row,
      api_key: typeof row.api_key === "string" && row.api_key.length > 10
        ? `${row.api_key.slice(0, 6)}…${row.api_key.slice(-4)}`
        : "…",
    }));
    return jsonResponse({ keys: rows, settings: settings.results ?? [], cooldowns: cooldowns.results ?? [], history: history.results ?? [] });
  }

  // POST /admin/api/keys — add a new key
  if (request.method === "POST" && path === "/admin/api/keys") {
    const body = await request.json() as Record<string, unknown>;
    const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
    const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
    if (!PANEL_PROVIDERS.includes(provider as typeof PANEL_PROVIDERS[number])) {
      return jsonResponse({ detail: `provider 必须是: ${PANEL_PROVIDERS.join(", ")}` }, 400);
    }
    if (!apiKey) return jsonResponse({ detail: "api_key 不能为空" }, 400);
    const label = typeof body.label === "string" ? body.label.trim().slice(0, 100) || null : null;
    const model = typeof body.model === "string" ? body.model.trim() || null : null;
    const rpmRaw = Number(body.rpm_limit);
    const rpmLimit = Number.isFinite(rpmRaw) && rpmRaw > 0 ? Math.floor(rpmRaw) : null;
    const result = await env.DB.prepare(
      `INSERT INTO api_configs (provider, label, api_key, rpm_limit, model, is_active) VALUES (?, ?, ?, ?, ?, 1)`,
    ).bind(provider, label, apiKey, rpmLimit, model).run();
    invalidateProviderCache(provider);
    return jsonResponse({ ok: true, id: result.meta?.last_row_id ?? null });
  }

  // GET /admin/api/keys/usage — per-provider monthly usage summary for the
  // 📊 card: month/total calls, active keys, keys used this month, and
  // theoretical monthly capacity from documented free tiers (search engines).
  if (request.method === "GET" && path === "/admin/api/keys/usage") {
    const [active, monthRows, totalRows, cooldowns] = await Promise.all([
      env.DB.prepare(`SELECT provider, COUNT(*) AS n FROM api_configs WHERE is_active = 1 GROUP BY provider`)
        .all<{ provider: string; n: number }>(),
      env.DB.prepare(
        `SELECT provider, SUM(success_count) AS calls, COUNT(DISTINCT key_index) AS keys_used
         FROM api_key_usage WHERE day >= date('now', 'start of month') GROUP BY provider`,
      ).all<{ provider: string; calls: number; keys_used: number }>(),
      env.DB.prepare(`SELECT provider, SUM(success_count) AS calls FROM api_key_usage GROUP BY provider`)
        .all<{ provider: string; calls: number }>(),
      env.DB.prepare(
        `SELECT provider, COUNT(*) AS n FROM api_key_health
         WHERE exhausted_until IS NOT NULL AND exhausted_until > datetime('now') GROUP BY provider`,
      ).all<{ provider: string; n: number }>(),
    ]);
    const activeMap = Object.fromEntries((active.results ?? []).map((r) => [r.provider, r.n]));
    const monthMap = Object.fromEntries((monthRows.results ?? []).map((r) => [r.provider, r]));
    const totalMap = Object.fromEntries((totalRows.results ?? []).map((r) => [r.provider, r.calls]));
    const coolMap = Object.fromEntries((cooldowns.results ?? []).map((r) => [r.provider, r.n]));
    // Documented per-key monthly capacities (search engines only; AI providers
    // depend on model/token mix so no hard capacity is shown for them).
    const monthlyCapacityPerKey: Record<string, number> = {
      tavily: 500,  // 1,000 credits, advanced search = 2 credits
      exa: 2000,    // ~$10 credits at ~$5/1k auto searches
      brave: 2000,  // 2,000 searches/mo
      searlo: 1000, // estimate
    };
    const providers = Array.from(new Set([
      ...Object.keys(activeMap), ...Object.keys(monthMap), ...Object.keys(totalMap),
    ])).sort();
    const usage = providers.map((p) => {
      const activeKeys = activeMap[p] ?? 0;
      const m = monthMap[p];
      const capacity = (monthlyCapacityPerKey[p] ?? 0) * activeKeys;
      return {
        provider: p,
        active_keys: activeKeys,
        cooling_keys: coolMap[p] ?? 0,
        month_calls: m?.calls ?? 0,
        keys_used_this_month: m?.keys_used ?? 0,
        total_calls: totalMap[p] ?? 0,
        monthly_capacity: capacity || null, // null = no documented capacity (AI providers)
      };
    });
    return jsonResponse({ usage });
  }

  // POST /admin/api/keys/bulk — bulk import keys.
  // Template format: one entry per line, "key,label" (label = 备注/账号).
  // Also accepts key<TAB>label, key|label, or bare keys (one per line).
  // Duplicates within the paste AND keys already stored for the provider are skipped.
  if (request.method === "POST" && path === "/admin/api/keys/bulk") {
    const body = await request.json() as Record<string, unknown>;
    const provider = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
    if (!PANEL_PROVIDERS.includes(provider as typeof PANEL_PROVIDERS[number])) {
      return jsonResponse({ detail: `provider 必须是: ${PANEL_PROVIDERS.join(", ")}` }, 400);
    }
    const raw = typeof body.keys === "string" ? body.keys : "";
    const entries = parseBulkKeyEntries(raw);
    if (entries.length === 0) {
      return jsonResponse({ detail: "未解析到任何 Key。模板格式：每行一条 `API Key,备注/账号`" }, 400);
    }
    const labelPrefix = typeof body.label_prefix === "string" ? body.label_prefix.trim().slice(0, 80) : "";
    const model = typeof body.model === "string" ? body.model.trim() || null : null;
    const rpmRaw = Number(body.rpm_limit);
    const rpmLimit = Number.isFinite(rpmRaw) && rpmRaw > 0 ? Math.floor(rpmRaw) : null;

    const existingRows = await env.DB.prepare(`SELECT api_key FROM api_configs WHERE provider = ?`)
      .bind(provider).all<{ api_key: string }>();
    const existing = new Set((existingRows.results ?? []).map((r) => r.api_key));
    let added = 0;
    let skipped = 0;
    for (const entry of entries) {
      if (existing.has(entry.key)) {
        skipped++;
        continue;
      }
      // Line-provided label wins; otherwise prefix + sequence (账号1, 账号2, …)
      const label = entry.label ?? (labelPrefix ? `${labelPrefix}${added + 1}` : null);
      await env.DB.prepare(
        `INSERT INTO api_configs (provider, label, api_key, rpm_limit, model, is_active) VALUES (?, ?, ?, ?, ?, 1)`,
      ).bind(provider, label, entry.key, rpmLimit, model).run();
      added++;
    }
    invalidateProviderCache(provider);
    return jsonResponse({ ok: true, added, skipped });
  }

  // PATCH /admin/api/keys/:id — update label/rpm/model/is_active (NOT the key itself)
  const keyIdMatch = path.match(/^\/admin\/api\/keys\/(\d+)$/);
  if (keyIdMatch) {
    const id = Number(keyIdMatch[1]);
    const existing = await env.DB.prepare(`SELECT provider FROM api_configs WHERE id = ?`).bind(id)
      .first<{ provider: string }>();
    if (!existing) return jsonResponse({ detail: "Key 不存在" }, 404);

    if (request.method === "PATCH") {
      const body = await request.json() as Record<string, unknown>;
      const sets: string[] = ["updated_at = CURRENT_TIMESTAMP"];
      const binds: unknown[] = [];
      if (body.label !== undefined) {
        sets.push("label = ?");
        binds.push(typeof body.label === "string" ? body.label.trim().slice(0, 100) || null : null);
      }
      if (body.rpm_limit !== undefined) {
        const rpm = Number(body.rpm_limit);
        sets.push("rpm_limit = ?");
        binds.push(Number.isFinite(rpm) && rpm > 0 ? Math.floor(rpm) : null);
      }
      if (body.model !== undefined) {
        sets.push("model = ?");
        binds.push(typeof body.model === "string" ? body.model.trim() || null : null);
      }
      if (body.is_active !== undefined) {
        sets.push("is_active = ?");
        binds.push(body.is_active ? 1 : 0);
      }
      if (sets.length > 1) {
        binds.push(id);
        await env.DB.prepare(`UPDATE api_configs SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
        invalidateProviderCache(existing.provider);
      }
      return jsonResponse({ ok: true });
    }

    if (request.method === "DELETE") {
      await env.DB.prepare(`DELETE FROM api_configs WHERE id = ?`).bind(id).run();
      // Also drop any cooldown rows for this key so a re-added key starts fresh
      await env.DB.prepare(
        `DELETE FROM api_key_health WHERE provider = ? AND key_index = ?`,
      ).bind(existing.provider, `${existing.provider}:${id}`).run();
      invalidateProviderCache(existing.provider);
      return jsonResponse({ ok: true });
    }
  }

  // DELETE /admin/api/keys/cooldowns/:provider — manually clear active
  // cooldowns (e.g. after fixing a key or when a quota resets early)
  const cooldownMatch = path.match(/^\/admin\/api\/keys\/cooldowns\/([a-z]+)$/);
  if (cooldownMatch && request.method === "DELETE") {
    const provider = cooldownMatch[1];
    if (!PANEL_PROVIDERS.includes(provider as typeof PANEL_PROVIDERS[number])) {
      return jsonResponse({ detail: "unknown provider" }, 400);
    }
    await env.DB.prepare(`DELETE FROM api_key_health WHERE provider = ?`).bind(provider).run();
    return jsonResponse({ ok: true });
  }

  // GET/PUT /admin/api/keys/settings/:provider — provider-level settings
  const settingsMatch = path.match(/^\/admin\/api\/keys\/settings\/([a-z]+)$/);
  if (settingsMatch) {
    const provider = settingsMatch[1];
    if (!PANEL_PROVIDERS.includes(provider as typeof PANEL_PROVIDERS[number])) {
      return jsonResponse({ detail: "unknown provider" }, 400);
    }
    if (request.method === "PUT") {
      const body = await request.json() as Record<string, unknown>;
      const defaultModel = typeof body.default_model === "string" ? body.default_model.trim() || null : null;
      const rpmRaw = Number(body.rpm_total);
      const rpmTotal = Number.isFinite(rpmRaw) && rpmRaw > 0 ? Math.floor(rpmRaw) : null;
      const enabled = body.enabled === undefined ? 1 : (body.enabled ? 1 : 0);
      await env.DB.prepare(
        `INSERT INTO provider_settings (provider, default_model, rpm_total, enabled, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (provider) DO UPDATE SET
           default_model = excluded.default_model,
           rpm_total = excluded.rpm_total,
           enabled = excluded.enabled,
           updated_at = CURRENT_TIMESTAMP`,
      ).bind(provider, defaultModel, rpmTotal, enabled).run();
      invalidateProviderCache(provider);
      return jsonResponse({ ok: true });
    }
  }

  return jsonResponse({ detail: "Not Found" }, 404);
}

/* ── Worker secret management (方案A: panel writes directly to Cloudflare API) ── */

interface SecretDefinition {
  name: string;
  label: string;
  group: string;
  indexed?: boolean; // *_2 … *_40 suffixes generated automatically
}

// Provider pools share one definition with indexed: true (40 keys each).
// Searlo/Tavily/Exa keep their historical pool sizes.
const SECRET_DEFINITIONS: SecretDefinition[] = [
  { name: "GEMINI_API_KEY", label: "Gemini", group: "AI Provider Keys", indexed: true },
  { name: "GROQ_API_KEY", label: "Groq", group: "AI Provider Keys", indexed: true },
  { name: "CEREBRAS_API_KEY", label: "Cerebras", group: "AI Provider Keys", indexed: true },
  { name: "ZHIPU_API_KEY", label: "Zhipu GLM", group: "AI Provider Keys", indexed: true },
  { name: "NVIDIA_API_KEY", label: "NVIDIA NIM", group: "AI Provider Keys", indexed: true },
  { name: "AMD_API_KEY", label: "AMD Radeon Cloud", group: "AI Provider Keys", indexed: true },
  { name: "MISTRAL_API_KEY", label: "Mistral", group: "AI Provider Keys", indexed: true },
  { name: "DEEPSEEK_API_KEY", label: "DeepSeek", group: "AI Provider Keys", indexed: true },
  { name: "OPENROUTER_API_KEY", label: "OpenRouter", group: "AI Provider Keys", indexed: true },
  { name: "TAVILY_API_KEY", label: "Tavily (搜索)", group: "Search Keys", indexed: true },
  { name: "EXA_API_KEY", label: "Exa (搜索)", group: "Search Keys", indexed: true },
  { name: "BRAVE_API_KEY", label: "Brave (搜索)", group: "Search Keys", indexed: true },
  { name: "SEARLO_API_KEY", label: "Searlo (搜索)", group: "Search Keys", indexed: true },
  { name: "FIRECRAWL_API_KEY", label: "Firecrawl (反爬降级)", group: "Search Keys" },
  { name: "GEMINI_MODEL", label: "Gemini 模型", group: "Model Overrides" },
  { name: "GROQ_MODEL", label: "Groq 模型", group: "Model Overrides" },
  { name: "CEREBRAS_MODEL", label: "Cerebras 模型", group: "Model Overrides" },
  { name: "ZHIPU_MODEL", label: "Zhipu 模型", group: "Model Overrides" },
  { name: "NVIDIA_MODEL", label: "NVIDIA 模型", group: "Model Overrides" },
  { name: "MISTRAL_MODEL", label: "Mistral 模型", group: "Model Overrides" },
  { name: "DEEPSEEK_MODEL", label: "DeepSeek 模型", group: "Model Overrides" },
  { name: "OPENROUTER_MODEL", label: "OpenRouter 模型", group: "Model Overrides" },
  { name: "GEMINI_RPM", label: "Gemini 总RPM", group: "RPM Overrides" },
  { name: "GROQ_RPM", label: "Groq 总RPM", group: "RPM Overrides" },
  { name: "CEREBRAS_RPM", label: "Cerebras 总RPM", group: "RPM Overrides" },
  { name: "ZHIPU_RPM", label: "Zhipu 总RPM", group: "RPM Overrides" },
  { name: "NVIDIA_RPM", label: "NVIDIA 总RPM", group: "RPM Overrides" },
  { name: "MISTRAL_RPM", label: "Mistral 总RPM", group: "RPM Overrides" },
  { name: "DEEPSEEK_RPM", label: "DeepSeek 总RPM", group: "RPM Overrides" },
  { name: "OPENROUTER_RPM", label: "OpenRouter 总RPM", group: "RPM Overrides" },
  { name: "CLOUDFLARE_API_TOKEN", label: "Cloudflare API Token (面板引导)", group: "Panel Config" },
  { name: "CLOUDFLARE_ACCOUNT_ID", label: "Cloudflare Account ID", group: "Panel Config" },
  { name: "WORKER_SCRIPT_NAME", label: "Worker 脚本名 (默认 crm-ai-worker)", group: "Panel Config" },
  { name: "ADMIN_PANEL_TOKEN", label: "面板登录 Token (改后需重新登录)", group: "Panel Config" },
];

const INDEXED_SECRET_MAX = 40;

function secretDefinitionsExpanded(): SecretDefinition[] {
  const expanded: SecretDefinition[] = [];
  for (const def of SECRET_DEFINITIONS) {
    if (!def.indexed) {
      expanded.push(def);
      continue;
    }
    const max = def.name === "TAVILY_API_KEY" || def.name === "EXA_API_KEY" ? 60 : INDEXED_SECRET_MAX;
    expanded.push({ ...def, name: def.name, label: `${def.label} #1` });
    for (let i = 2; i <= max; i++) {
      expanded.push({ name: `${def.name}_${i}`, label: `${def.label} #${i}`, group: def.group });
    }
  }
  return expanded;
}

/**
 * Bootstrap check: the panel can only manage secrets when the Worker itself
 * was granted a Cloudflare API token with Workers Scripts: Edit scope.
 * Set once via `npx wrangler secret put CLOUDFLARE_API_TOKEN` (plus
 * CLOUDFLARE_ACCOUNT_ID); afterwards keys rotate from the panel directly.
 */
function secretApiConfig(env: AdminEnv): { accountTag: string; scriptName: string; apiToken: string } | null {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return null;
  return {
    accountTag: env.CLOUDFLARE_ACCOUNT_ID,
    scriptName: env.WORKER_SCRIPT_NAME || "crm-ai-worker",
    apiToken: env.CLOUDFLARE_API_TOKEN,
  };
}

async function cfPutWorkerSecret(
  config: { accountTag: string; scriptName: string; apiToken: string },
  secretName: string,
  secretValue: string,
): Promise<{ ok: boolean; error?: string }> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.accountTag}/workers/scripts/${config.scriptName}/secrets`;
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: secretName, text: secretValue, type: "secret_text" }),
  });
  if (response.ok) return { ok: true };
  let detail = `HTTP ${response.status}`;
  try {
    const payload = await response.json() as { errors?: Array<{ message?: string }> };
    const first = payload.errors?.[0]?.message;
    if (first) detail = `${detail}: ${first}`;
  } catch { /* keep status-only detail */ }
  return { ok: false, error: detail };
}

async function handleSecretsApi(request: Request, env: AdminEnv): Promise<Response> {
  const url = new URL(request.url);

  // One-time bootstrap: the admin pastes a Cloudflare API token + account ID
  // in the panel; the panel uses THAT token to write the credentials onto the
  // Worker itself. Afterwards all key management happens in-panel with no CLI.
  if (request.method === "POST" && url.pathname === "/admin/api/secrets/bootstrap") {
    const body = await request.json() as { api_token?: unknown; account_id?: unknown };
    const apiToken = typeof body.api_token === "string" ? body.api_token.trim() : "";
    const accountId = typeof body.account_id === "string" ? body.account_id.trim() : "";
    if (!apiToken || !accountId) {
      return jsonResponse({ detail: "api_token 和 account_id 均为必填" }, 400);
    }
    // Validate before saving: the token must at least be able to read scripts
    // in the given account — a wrong-but-saved token would brick the panel.
    const probe = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`,
      { headers: { "Authorization": `Bearer ${apiToken}` } },
    );
    if (!probe.ok) {
      const status = probe.status;
      const hint = status === 403 || status === 401
        ? "Token 无效或缺少 Workers Scripts: Edit 权限"
        : `Cloudflare API 返回 HTTP ${status}`;
      return jsonResponse({ detail: `验证失败：${hint}` }, 400);
    }
    const config = { accountTag: accountId, scriptName: env.WORKER_SCRIPT_NAME || "crm-ai-worker", apiToken };
    const putToken = await cfPutWorkerSecret(config, "CLOUDFLARE_API_TOKEN", apiToken);
    if (!putToken.ok) return jsonResponse({ detail: `保存 CLOUDFLARE_API_TOKEN 失败：${putToken.error}` }, 500);
    const putAccount = await cfPutWorkerSecret(config, "CLOUDFLARE_ACCOUNT_ID", accountId);
    if (!putAccount.ok) return jsonResponse({ detail: `保存 CLOUDFLARE_ACCOUNT_ID 失败：${putAccount.error}` }, 500);
    return jsonResponse({ ok: true, applied: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] });
  }

  const config = secretApiConfig(env);
  if (!config) {
    return jsonResponse({
      detail: "Secret management is not bootstrapped. Submit a Cloudflare API token below, or run: npx wrangler secret put CLOUDFLARE_API_TOKEN",
    }, 503);
  }

  if (request.method === "GET" && url.pathname === "/admin/api/secrets") {
    // Metadata only — secret VALUES are never readable back from Cloudflare.
    return jsonResponse({ definitions: secretDefinitionsExpanded() });
  }

  if (request.method === "POST" && url.pathname === "/admin/api/secrets/update") {
    const body = await request.json() as { updates?: Array<{ name?: unknown; value?: unknown }> };
    const updates = Array.isArray(body.updates) ? body.updates : [];
    if (updates.length === 0) return jsonResponse({ detail: "updates is required" }, 400);
    const validNames = new Set(secretDefinitionsExpanded().map((d) => d.name));
    const applied: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const update of updates) {
      const name = typeof update.name === "string" ? update.name.trim() : "";
      const value = typeof update.value === "string" ? update.value.trim() : "";
      if (!name || !validNames.has(name)) {
        failed.push({ name: name || "(empty)", error: "unknown secret name" });
        continue;
      }
      if (!value) continue; // empty input = leave unchanged
      const result = await cfPutWorkerSecret(config, name, value);
      if (result.ok) applied.push(name);
      else failed.push({ name, error: result.error || "unknown error" });
    }
    return jsonResponse({ applied, failed });
  }

  return jsonResponse({ detail: "Not Found" }, 404);
}

async function handleOutreachApi(request: Request, env: AdminEnv): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname;

    // GET /admin/api/outreach/settings - Get brand settings
    if (path === "/admin/api/outreach/settings" && request.method === "GET") {
      const settings = await getBrandSettings(env);
      return jsonResponse({ settings });
    }

    // PATCH /admin/api/outreach/settings/:brand - Update brand setting
    if (path.startsWith("/admin/api/outreach/settings/") && request.method === "PATCH") {
      const brandName = decodeURIComponent(path.split("/").pop() || "");
      const body = (await request.json()) as Record<string, unknown>;
      const updates: { company_intro?: string; enabled?: boolean; sender_email?: string | null; sender_name?: string | null; signature?: string | null } = {};
      if (typeof body.company_intro === "string") updates.company_intro = body.company_intro;
      if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
      if (typeof body.sender_email === "string") {
        const senderEmail = body.sender_email.trim();
        if (senderEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderEmail)) {
          return jsonResponse({ detail: "sender_email must be a valid email address" }, 400);
        }
        updates.sender_email = senderEmail || null;
      }
      if (typeof body.sender_name === "string") {
        updates.sender_name = body.sender_name.replace(/[\r\n]+/g, " ").trim() || null;
      }
      if (typeof body.signature === "string") {
        if (body.signature.length > 5_000) return jsonResponse({ detail: "signature is too long" }, 400);
        updates.signature = body.signature || null;
      }
      await updateBrandSetting(env, brandName, updates);
      return jsonResponse({ ok: true });
    }

    // ── Brand attachments ──
    // GET /admin/api/outreach/attachments?brand=X - list metadata
    if (path === "/admin/api/outreach/attachments" && request.method === "GET") {
      const brand = url.searchParams.get("brand");
      if (!brand) return jsonResponse({ detail: "brand is required" }, 400);
      const rows = await env.DB.prepare(
        `SELECT id, brand_name, filename, mime_type, size_bytes, created_at
         FROM outreach_attachments WHERE brand_name = ? ORDER BY created_at`,
      ).bind(brand).all();
      return jsonResponse({ attachments: rows.results ?? [] });
    }
    // POST /admin/api/outreach/attachments - upload (JSON: brand, filename, mime_type, content_base64)
    if (path === "/admin/api/outreach/attachments" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        brand?: string; filename?: string; mime_type?: string; content_base64?: string;
      };
      if (typeof body.brand !== "string" || typeof body.filename !== "string" || typeof body.content_base64 !== "string" || !body.brand.trim() || !body.filename.trim() || !body.content_base64.trim()) {
        return jsonResponse({ detail: "brand, filename and content_base64 are required strings" }, 400);
      }
      if (body.brand.length > 100) return jsonResponse({ detail: "brand is too long" }, 400);
      const b64 = body.content_base64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) {
        return jsonResponse({ detail: "附件内容不是有效的 base64" }, 400);
      }
      const sizeBytes = Math.max(0, Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0));
      if (sizeBytes <= 0) return jsonResponse({ detail: "附件不能为空" }, 400);
      // D1 limits each string/row to 2 MB; base64 expands binary data by
      // roughly 4/3, so keep raw attachments below 1.4 MB.
      if (sizeBytes > 1_400_000) return jsonResponse({ detail: "附件不能超过 1.4 MB（D1 存储限制）" }, 400);
      if (body.filename.length > 200 || /[\r\n\x00-\x1F\x7F]/.test(body.filename)) {
        return jsonResponse({ detail: "附件文件名无效" }, 400);
      }
      if (body.mime_type !== undefined && (typeof body.mime_type !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(body.mime_type))) {
        return jsonResponse({ detail: "附件 MIME 类型无效" }, 400);
      }
      const count = await env.DB.prepare(
        "SELECT COUNT(*) AS cnt FROM outreach_attachments WHERE brand_name = ?",
      ).bind(body.brand.trim()).first<{ cnt: number }>();
      if ((count?.cnt ?? 0) >= 5) return jsonResponse({ detail: "每个品牌最多 5 个附件" }, 400);
      await env.DB.prepare(
        `INSERT INTO outreach_attachments (brand_name, filename, mime_type, size_bytes, content_base64)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(body.brand.trim(), body.filename.trim().slice(0, 200), body.mime_type || "application/octet-stream", sizeBytes, b64).run();
      return jsonResponse({ ok: true, size_bytes: sizeBytes });
    }
    // DELETE /admin/api/outreach/attachments/:id
    if (path.startsWith("/admin/api/outreach/attachments/") && request.method === "DELETE") {
      const id = Number(path.split("/").pop());
      if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ detail: "Invalid id" }, 400);
      await env.DB.prepare("DELETE FROM outreach_attachments WHERE id = ?").bind(id).run();
      return jsonResponse({ ok: true });
    }

    // POST /admin/api/outreach/generate - Generate outreach emails
    if (path === "/admin/api/outreach/generate" && request.method === "POST") {
      const body = (await request.json()) as { brand?: string; limit?: number };
      if (typeof body.brand !== "string" || !body.brand.trim()) return jsonResponse({ detail: "brand is required" }, 400);
      const requestedLimit = Number(body.limit ?? 10);
      if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
        return jsonResponse({ detail: "limit must be an integer from 1 to 50" }, 400);
      }
      const result = await generateOutreachEmails(env, body.brand.trim(), requestedLimit);
      return jsonResponse(result);
    }

    // GET /admin/api/outreach/emails - List outreach emails
    if (path === "/admin/api/outreach/emails" && request.method === "GET") {
      const result = await getOutreachEmails(env, {
        brand: url.searchParams.get("brand") || undefined,
        status: url.searchParams.get("status") || undefined,
        limit: Number(url.searchParams.get("limit") || 50),
        offset: Number(url.searchParams.get("offset") || 0),
      });
      return jsonResponse(result);
    }

    // GET /admin/api/outreach/stats - Get outreach statistics
    if (path === "/admin/api/outreach/stats" && request.method === "GET") {
      const stats = await getOutreachStats(env);
      return jsonResponse(stats);
    }

    // GET /admin/api/outreach/quota - Gmail daily send quota
    if (path === "/admin/api/outreach/quota" && request.method === "GET") {
      return jsonResponse(await getQuota(env));
    }

    // POST /admin/api/outreach/send-batch - Send draft emails via Gmail with rate limiting
    if (path === "/admin/api/outreach/send-batch" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { brand?: string; limit?: number };
      const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50);
      const params: unknown[] = [];
      let clause = "WHERE status = 'draft' AND email_to IS NOT NULL AND email_to != ''";
      if (body.brand) {
        clause += " AND brand_name = ?";
        params.push(body.brand);
      }
      const drafts = await env.DB.prepare(
        `SELECT e.id, e.email_to, e.subject, e.body, e.brand_name, s.sender_email, s.sender_name
         FROM outreach_emails e
         LEFT JOIN outreach_settings s ON s.brand_name = e.brand_name
         ${clause} ORDER BY e.id LIMIT ?`,
      ).bind(...params, limit).all<{ id: number; email_to: string; subject: string | null; body: string | null; brand_name: string | null; sender_email: string | null; sender_name: string | null }>();

      const quota = await getQuota(env);
      const delayMs = sendDelayMs(env);
      const results: Array<{ id: number; ok: boolean; error?: string }> = [];
      let sent = 0;
      for (const draft of drafts.results) {
        if (quota.sent_today + sent >= quota.daily_limit) {
          results.push({ id: draft.id, ok: false, error: "今日配额已用完，未发送" });
          continue;
        }
        if (sent > 0) await new Promise((r) => setTimeout(r, delayMs));
        try {
          const r = await sendOutreachEmail(env, draft, {
            fromEmail: draft.sender_email,
            fromName: draft.sender_name,
            brandName: draft.brand_name,
          });
          if (r.ok) sent++;
          results.push({ id: draft.id, ok: r.ok, error: r.error });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          results.push({ id: draft.id, ok: false, error: msg });
          if (e instanceof GmailConfigError) break; // config missing: stop the batch
        }
      }
      const after = await getQuota(env);
      return jsonResponse({
        attempted: drafts.results.length,
        sent,
        failed: results.filter((r) => !r.ok).length,
        quota: after,
        results,
      });
    }

    // PATCH /admin/api/outreach/emails/:id - Update email
    if (path.startsWith("/admin/api/outreach/emails/") && request.method === "PATCH") {
      const id = Number(path.split("/").pop());
      if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ detail: "Invalid id" }, 400);
      const body = (await request.json()) as Record<string, unknown>;
      const updates: { status?: string; subject?: string; body?: string } = {};
      // Status is restricted: real sending goes through send-batch/send-one;
      // 'draft' is only allowed to revert a mistaken manual mark.
      if (body.status === "draft") updates.status = body.status;
      if (typeof body.subject === "string") updates.subject = body.subject;
      if (typeof body.body === "string") updates.body = body.body;
      await updateOutreachEmail(env, id, updates);
      return jsonResponse({ ok: true });
    }

    // POST /admin/api/outreach/emails/:id/send - Send a single draft via Gmail
    if (path.startsWith("/admin/api/outreach/emails/") && path.endsWith("/send") && request.method === "POST") {
      const id = Number(path.split("/")[path.split("/").length - 2]);
      if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ detail: "Invalid id" }, 400);
      const row = await env.DB.prepare(
        "SELECT id, email_to, subject, body, status, brand_name FROM outreach_emails WHERE id = ?",
      ).bind(id).first<{ id: number; email_to: string; subject: string | null; body: string | null; status: string; brand_name: string | null }>();
      if (!row) return jsonResponse({ detail: "Email not found" }, 404);
      if (row.status !== "draft") return jsonResponse({ detail: "只有草稿可以发送" }, 400);
      // Resolve the sending identity from the email's brand (falls back to
      // the global GMAIL_SENDER_EMAIL when the brand has none).
      let fromEmail: string | null = null;
      let fromName: string | null = null;
      if (row.brand_name) {
        const brand = await env.DB.prepare(
          "SELECT sender_email, sender_name FROM outreach_settings WHERE brand_name = ?",
        ).bind(row.brand_name).first<{ sender_email: string | null; sender_name: string | null }>();
        fromEmail = brand?.sender_email ?? null;
        fromName = brand?.sender_name ?? null;
      }
      const result = await sendOutreachEmail(env, row, { fromEmail, fromName, brandName: row.brand_name });
      const quota = await getQuota(env);
      return jsonResponse({ ok: result.ok, error: result.error, gmail_message_id: result.gmail_message_id, from: fromEmail, quota });
    }

    // DELETE /admin/api/outreach/emails/:id - Delete email
    if (path.startsWith("/admin/api/outreach/emails/") && request.method === "DELETE") {
      const id = Number(path.split("/").pop());
      if (!Number.isSafeInteger(id) || id <= 0) return jsonResponse({ detail: "Invalid id" }, 400);
      await deleteOutreachEmail(env, id);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ detail: "Not Found" }, 404);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return jsonResponse({ detail: `Outreach API Error: ${msg}` }, 500);
  }
}

async function handleAdminApi(request: Request, env: AdminEnv): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname === "/admin/api/customers" && request.method === "GET") {
      return await listCustomers(request, env);
    }
    const id = parseCustomerId(url.pathname);
    if (id !== null) {
      if (request.method === "GET") {
        const customer = await getCustomer(env, id);
        if (!customer) return jsonResponse({ detail: "Customer not found" }, 404);
        const contacts = await getCustomerContacts(env, customer.company_id);
        return jsonResponse({ ...customer, contacts });
      }
      if (request.method === "PATCH") return await updateCustomer(request, env, id);
    }
    return jsonResponse({ detail: "Not Found" }, 404);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return jsonResponse({ detail: `API Error: ${msg}` }, 500);
  }
}

export async function handleAdminRequest(
  request: Request,
  env: AdminEnv,
): Promise<Response | null> {
  try {
  const url = new URL(request.url);
  if (url.pathname !== "/admin" && !url.pathname.startsWith("/admin/")) return null;

  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    if (request.method !== "GET") return jsonResponse({ detail: "Method Not Allowed" }, 405);
    return (await isAuthenticated(request, env))
      ? htmlResponse(ADMIN_PANEL_HTML)
      : htmlResponse(ADMIN_LOGIN_HTML);
  }

  if (url.pathname === "/admin/login" && request.method === "POST") {
    if (!env.ADMIN_PANEL_TOKEN) {
      return htmlResponse("<h1>Admin panel is not configured</h1><p>Set ADMIN_PANEL_TOKEN first.</p>", 503);
    }
    const form = await request.formData();
    const token = form.get("token");
    if (typeof token !== "string" || !(await constantTimeSecretMatch(token, env.ADMIN_PANEL_TOKEN))) {
      return htmlResponse(`${ADMIN_LOGIN_HTML}<p class="error">授权失败，请重试。</p>`, 401);
    }
    return new Response(null, {
      status: 303,
      headers: {
        Location: new URL("/admin", request.url).toString(),
        "Set-Cookie": `${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${SESSION_MAX_AGE}; Path=/admin; HttpOnly;${new URL(request.url).protocol === "https:" ? " Secure;" : ""} SameSite=Strict`,
        "Cache-Control": "no-store",
      },
    });
  }

  if (url.pathname === "/admin/logout" && request.method === "POST") {
    return new Response(null, {
      status: 303,
      headers: {
        Location: new URL("/admin", request.url).toString(),
        "Set-Cookie": `${COOKIE_NAME}=; Max-Age=0; Path=/admin; HttpOnly;${new URL(request.url).protocol === "https:" ? " Secure;" : ""} SameSite=Strict`,
      },
    });
  }

  if (url.pathname === "/admin/outreach") {
    if (request.method !== "GET") return jsonResponse({ detail: "Method Not Allowed" }, 405);
    return (await isAuthenticated(request, env))
      ? htmlResponse(OUTREACH_PANEL_HTML)
      : htmlResponse(ADMIN_LOGIN_HTML);
  }

  if (url.pathname === "/admin/secrets") {
    if (request.method !== "GET") return jsonResponse({ detail: "Method Not Allowed" }, 405);
    return (await isAuthenticated(request, env))
      ? htmlResponse(SECRETS_PANEL_HTML)
      : htmlResponse(ADMIN_LOGIN_HTML);
  }

  if (url.pathname === "/admin/keys") {
    if (request.method !== "GET") return jsonResponse({ detail: "Method Not Allowed" }, 405);
    return (await isAuthenticated(request, env))
      ? htmlResponse(KEYS_PANEL_HTML)
      : htmlResponse(ADMIN_LOGIN_HTML);
  }

  if (url.pathname.startsWith("/admin/api/keys")) {
    if (!(await isAuthenticated(request, env))) return authFailure(request);
    return handleProviderKeysApi(request, env);
  }

  if (url.pathname.startsWith("/admin/api/secrets")) {
    if (!(await isAuthenticated(request, env))) return authFailure(request);
    return handleSecretsApi(request, env);
  }

  if (url.pathname.startsWith("/admin/api/outreach")) {
    if (!(await isAuthenticated(request, env))) return authFailure(request);
    return handleOutreachApi(request, env);
  }

  if (url.pathname.startsWith("/admin/api/")) {
    if (!(await isAuthenticated(request, env))) return authFailure(request);
    return handleAdminApi(request, env);
  }

  return new Response("Not Found", { status: 404 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return jsonResponse({ detail: `Internal Error: ${msg}` }, 500);
  }
}

const ADMIN_LOGIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>D1 CRM 管理登录</title><style>body{font-family:system-ui,sans-serif;background:#eef4fa;display:grid;place-items:center;min-height:100vh;margin:0}.card{background:#fff;padding:28px;border-radius:14px;box-shadow:0 8px 30px #123b6820;width:min(420px,calc(100% - 40px))}h1{margin-top:0;color:#123b68}label{display:block;font-weight:600;margin:16px 0 6px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}button{margin-top:18px;background:#1677d2;color:#fff;border:0;border-radius:8px;padding:12px 18px;cursor:pointer;font:inherit}.error{color:#b91c1c}</style></head>
<body><main class="card"><h1>D1 CRM 管理面板</h1><p>请输入 ADMIN_PANEL_TOKEN 登录。</p><form method="post" action="/admin/login"><label for="token">管理 Token</label><input id="token" name="token" type="password" autocomplete="current-password" required><button type="submit">登录</button></form></main></body></html>`;

const ADMIN_PANEL_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>D1 CRM 客户管理</title><style>
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}.top{background:#123b68;color:#fff;padding:18px 26px;display:flex;justify-content:space-between;gap:12px;align-items:center}.top h1{font-size:22px;margin:0}.wrap{max-width:1400px;margin:22px auto;padding:0 18px}.panel{background:#fff;border:1px solid #dce5f0;border-radius:12px;padding:18px;margin-bottom:18px}.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.toolbar input,.toolbar select{font:inherit;padding:10px;border:1px solid #cbd5e1;border-radius:8px}.toolbar input{min-width:240px}.button{background:#1677d2;color:#fff;border:0;border-radius:8px;padding:10px 15px;cursor:pointer;font:inherit}.button.secondary{background:#475569}.button.danger{background:#b91c1c}.button.small{padding:6px 12px;font-size:13px}table{width:100%;border-collapse:collapse;margin-top:14px}th,td{text-align:left;padding:10px;border-bottom:1px solid #e2e8f0;vertical-align:top;font-size:14px}th{background:#f8fafc;white-space:nowrap}td{max-width:300px;overflow-wrap:anywhere}.badge{display:inline-block;border-radius:999px;padding:3px 9px;background:#e2e8f0;font-size:12px}.badge-completed{background:#d1fae5;color:#065f46}.badge-pending{background:#fef3c7;color:#92400e}.badge-failed{background:#fee2e2;color:#991b1b}.badge-processing{background:#dbeafe;color:#1e40af}.notice{margin-top:12px;padding:10px;border-radius:8px;background:#eff6ff}.success{background:#ecfdf5;color:#065f46}.error{background:#fef2f2;color:#991b1b}.hidden{display:none}.pager{display:flex;justify-content:space-between;align-items:center;margin-top:14px;gap:12px}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;justify-content:center;align-items:flex-start;padding:30px 18px;overflow-y:auto}.modal-overlay.active{display:flex}.modal{background:#fff;border-radius:14px;width:min(800px,100%);box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden}.modal-header{background:#123b68;color:#fff;padding:18px 24px;display:flex;justify-content:space-between;align-items:center}.modal-header h2{margin:0;font-size:20px}.modal-body{padding:24px;max-height:70vh;overflow-y:auto}.modal-footer{padding:16px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:10px}
.field-row{display:flex;align-items:stretch;border-bottom:1px solid #e2e8f0;min-height:48px}.field-row:last-child{border-bottom:none}.field-label{width:180px;min-width:180px;padding:12px 16px;background:#f8fafc;font-weight:600;font-size:13px;color:#475569;display:flex;align-items:center;border-right:1px solid #e2e8f0}.field-content{flex:1;padding:12px 16px;display:flex;align-items:center;gap:8px;min-height:48px}.field-value{flex:1;font-size:14px;word-break:break-word;line-height:1.5}.field-value a{color:#1677d2;text-decoration:none}.field-value a:hover{text-decoration:underline}.field-input{flex:1;display:none;gap:8px;align-items:center}.field-input input,.field-input select,.field-input textarea{font:inherit;padding:8px 12px;border:1px solid #cbd5e1;border-radius:6px;width:100%}.field-input textarea{min-height:80px;resize:vertical}.field-input input,.field-input select{max-width:100%}.field-row.editing .field-value{display:none}.field-row.editing .field-input{display:flex}.field-row.readonly .field-label{color:#94a3b8}
.persona-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;margin-bottom:10px}.persona-card h4{margin:0 0 8px;font-size:14px;color:#1e293b}.persona-card ul{margin:0;padding-left:18px;font-size:13px;color:#475569}.solution-card{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px;margin-bottom:10px}.solution-card h4{margin:0 0 6px;font-size:14px;color:#1e40af}.solution-card p{margin:0;font-size:13px;color:#1e3a5f}.section-title{font-size:15px;font-weight:600;color:#123b68;margin:18px 0 10px;padding-bottom:6px;border-bottom:2px solid #123b68}
@media(max-width:700px){.top{align-items:flex-start;flex-direction:column}table{display:block;overflow-x:auto;white-space:nowrap}.field-row{flex-direction:column}.field-label{width:100%;min-width:0;border-right:none;border-bottom:1px solid #e2e8f0}.modal-body{padding:16px}}
</style></head><body><header class="top"><h1>D1 CRM 客户管理面板</h1><div style="display:flex;gap:12px;align-items:center"><a href="/admin/outreach" style="color:#fff;text-decoration:none;background:rgba(255,255,255,.15);padding:8px 16px;border-radius:8px;font-weight:600">📧 开发信管理</a><a href="/admin/secrets" style="color:#fff;text-decoration:none;background:rgba(255,255,255,.15);padding:8px 16px;border-radius:8px;font-weight:600">🔑 AI Key 管理</a><a href="/admin/keys" style="color:#fff;text-decoration:none;background:rgba(255,255,255,.15);padding:8px 16px;border-radius:8px;font-weight:600">⚡ 动态 Key 池</a><form method="post" action="/admin/logout"><button class="button secondary" type="submit">退出登录</button></form></div></header><main class="wrap">
<section class="panel"><h2>客户列表</h2><div class="toolbar"><input id="search" placeholder="公司 ID、网址、细分或备注"><select id="status"><option value="">全部状态</option><option value="pending">pending</option><option value="processing">processing</option><option value="completed">completed</option><option value="failed">failed</option></select><button class="button" id="load">刷新</button><span id="summary"></span></div><div id="listMessage"></div><table><thead><tr><th>客户ID</th><th>公司名称</th><th>网址</th><th>状态</th><th>客户细分</th><th>国家</th><th>联系方式</th><th>操作</th></tr></thead><tbody id="rows"></tbody></table><div class="pager"><button class="button secondary" id="prev">上一页</button><span id="pageInfo"></span><button class="button secondary" id="next">下一页</button></div></section>
</main>
<div class="modal-overlay" id="modal"><div class="modal"><div class="modal-header"><h2 id="modalTitle">客户详情</h2><button class="button secondary small" id="closeModal">✕ 关闭</button></div><div class="modal-body" id="modalBody"></div><div class="modal-footer"><span id="modalMsg" class="notice hidden" style="margin-right:auto"></span><button class="button danger small" id="requeueBtn">设为 pending 重新处理</button><button class="button" id="submitBtn">提交修改</button></div></div></div>
<script>
(function(){
  var state={offset:0,limit:50,total:0,selected:null,dirty:{}};
  var $=function(id){return document.getElementById(id)};
  var esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
  var api=function(p,o){return fetch(p,o||{}).then(function(r){if(r.status===401){location='/admin';throw new Error('登录已过期')}var ct=r.headers.get('content-type')||'';if(ct.indexOf('json')===-1&&ct.indexOf('text/plain')===-1){return r.text().then(function(t){throw new Error('服务器返回非JSON响应 (HTTP '+r.status+'): '+t.slice(0,100))})}return r.json().then(function(d){if(!r.ok)throw new Error(d.detail||'请求失败 ('+r.status+')');return d})})};
  var showMsg=function(id,t,g){var e=$(id);e.textContent=t;e.className='notice '+(g?'success':'error');e.classList.remove('hidden')};
  var badge=function(s){return'<span class="badge badge-'+esc(s)+'">'+esc(s)+'</span>'};
  var load=function(){var p=new URLSearchParams({q:$('search').value,status:$('status').value,limit:String(state.limit),offset:String(state.offset)});api('/admin/api/customers?'+p.toString()).then(function(d){state.total=d.total;$('summary').textContent='共 '+d.total+' 条（显示公司名称、网址、状态、客户细分、国家、联系方式）';$('rows').innerHTML=d.items.map(function(c){var did=c.display_id||'N/A';return'<tr><td>'+esc(did)+'</td><td>'+esc(c.company_name||'-')+'</td><td><a href="'+esc(c.domain)+'" target="_blank">'+esc((c.domain||'').slice(0,35))+'</a></td><td>'+badge(c.status)+'</td><td>'+esc((c.customer_segment||'-').slice(0,35))+'</td><td>'+esc((c.country||'-'))+'</td><td>'+esc((c.email||c.cellphone||'-').slice(0,25))+'</td><td><button class="button" onclick="window.openDetail('+c.id+')">查看详情</button></td></tr>'}).join('')||'<tr><td colspan="8">暂无数据</td></tr>';$('pageInfo').textContent=(state.total?state.offset+1:0)+'-'+Math.min(state.offset+state.limit,state.total)+' / '+state.total;$('prev').disabled=state.offset===0;$('next').disabled=state.offset+state.limit>=state.total}).catch(function(e){showMsg('listMessage',e.message,false)})};
  var fields=[
    {key:'id',label:'数据库 ID',readonly:true},
    {key:'display_id',label:'客户 ID',readonly:true},
    {key:'company_id',label:'内部 UUID',readonly:true},
    {key:'company_name',label:'公司名称',type:'input'},
    {key:'legal_name',label:'法人名称',type:'input'},
    {key:'trading_name',label:'商号',type:'input'},
    {key:'domain',label:'企业网址',type:'input'},
    {key:'normalized_domain',label:'标准化域名',type:'input'},
    {key:'status',label:'状态',type:'select',options:['pending','processing','completed','failed']},
    {key:'first_name',label:'First Name',type:'input'},
    {key:'last_name',label:'Last Name',type:'input'},
    {key:'full_name',label:'全名 (Full Name)',type:'input'},
    {key:'title',label:'职位 (TITLE)',type:'input'},
    {key:'department',label:'部门 (Department)',type:'input'},
    {key:'linkedin_url',label:'LinkedIn URL',type:'input'},
    {key:'street_address',label:'街道地址',type:'input'},
    {key:'zip_city',label:'邮编 & 城市',type:'input'},
    {key:'country',label:'国家 (Country)',type:'input'},
    {key:'country_code',label:'国家代码',type:'input'},
    {key:'region',label:'地区 (Region)',type:'input'},
    {key:'city',label:'城市 (City)',type:'input'},
    {key:'postal_code',label:'邮编 (Postal Code)',type:'input'},
    {key:'tel',label:'电话 (TEL)',type:'input'},
    {key:'email',label:'邮箱 (EMAIL)',type:'input'},
    {key:'cellphone',label:'手机 (Cellphone)',type:'input'},
    {key:'whatsapp',label:'WhatsApp',type:'input'},
    {key:'products_services',label:'产品与服务',type:'textarea'},
    {key:'business_tag',label:'业务标签 (Business Tag)',type:'input'},
    {key:'industry',label:'行业 (Industry)',type:'input'},
    {key:'company_type',label:'公司类型',type:'input'},
    {key:'business_model',label:'商业模式',type:'input'},
    {key:'founded_year',label:'成立年份',type:'input'},
    {key:'employee_range',label:'员工规模',type:'input'},
    {key:'description',label:'公司描述',type:'textarea'},
    {key:'target_markets',label:'目标市场',type:'input'},
    {key:'is_manufacturer',label:'制造商',type:'select',options:['0','1']},
    {key:'is_importer',label:'进口商',type:'select',options:['0','1']},
    {key:'is_distributor',label:'分销商',type:'select',options:['0','1']},
    {key:'is_wholesaler',label:'批发商',type:'select',options:['0','1']},
    {key:'is_retailer',label:'零售商',type:'select',options:['0','1']},
    {key:'is_ecommerce',label:'电商',type:'select',options:['0','1']},
    {key:'is_rental',label:'租赁',type:'select',options:['0','1']},
    {key:'is_oem',label:'OEM',type:'select',options:['0','1']},
    {key:'social_accounts',label:'社交账号 JSON',type:'textarea'},
    {key:'customer_segment',label:'客户细分 (Customer Segment)',type:'input'},
    {key:'product_categories',label:'产品类别 (Product Categories)',type:'input'},
    {key:'company_size',label:'公司规模 (Company Size)',type:'select',options:['Small','Medium','Large','Enterprise']},
    {key:'geographic_coverage',label:'地理覆盖 (Geographic Coverage)',type:'select',options:['Local','National','International']},
    {key:'full_research_text',label:'完整研究文本',type:'textarea'},
    {key:'social_accounts_verified',label:'已验证社交媒体',type:'textarea'},
    {key:'personas_and_solutions',label:'AI 分析结果 JSON',type:'textarea',parseJson:true},
    {key:'remarks',label:'中文备注 (Remarks)',type:'textarea'}
  ];
  var buildModal=function(c){state.dirty={};var h='';
    fields.forEach(function(f){
      var val=c[f.key]||'';var isReadonly=!!f.readonly;var rowClass=isReadonly?'field-row readonly':'field-row';
      h+='<div class="field-row" data-key="'+f.key+'">';
      h+='<div class="field-label">'+esc(f.label)+'</div>';
      h+='<div class="field-content">';
      h+='<div class="field-value" id="fv_'+f.key+'">';
      if(f.key==='id'||f.key==='company_id'){h+=esc(val)}
      else if(f.key==='domain'){h+='<a href="'+esc(val)+'" target="_blank">'+esc(val)+'</a>'}
      else if(f.key==='status'){h+=badge(val)}
      else if(f.key==='linkedin_url'&&val){h+='<a href="'+esc(val)+'" target="_blank">'+esc(val)+'</a>'}
      else if(f.key==='is_manufacturer'||f.key==='is_importer'||f.key==='is_distributor'||f.key==='is_wholesaler'||f.key==='is_retailer'||f.key==='is_ecommerce'||f.key==='is_rental'||f.key==='is_oem'){h+=(val==1||val==='1'?'✅ 是':'❌ 否')}
      else if(f.key==='social_accounts'&&val){var sa=null;try{sa=JSON.parse(val)}catch(e){}
        if(sa&&sa.length>0){sa.forEach(function(a){h+='<div style="margin-bottom:4px">🔗 '+esc(a.platform||'')+': '+(a.username?'@'+esc(a.username):'')+(a.url?' <a href="'+esc(a.url)+'" target="_blank">'+esc(a.url)+'</a>':'')+'</div>'})}else{h+='<em style="color:#94a3b8">暂无社交账号</em>'}}
      else if(f.key==='personas_and_solutions'&&val){var parsed=null;try{parsed=JSON.parse(val)}catch(e){}
        if(parsed){var pl=parsed.personas||[];var sl=parsed.solutions||[];
          if(pl.length>0){h+='<div class="section-title">👤 客户画像</div>';pl.forEach(function(p){h+='<div class="persona-card"><h4>'+esc(p.name||'未知角色')+'</h4><ul>';(p.needs||[]).forEach(function(n){h+='<li>'+esc(n)+'</li>'});h+='</ul></div>'})}
          if(sl.length>0){h+='<div class="section-title">💡 解决方案</div>';sl.forEach(function(s){h+='<div class="solution-card"><h4>'+esc(s.name||'')+'</h4><p>'+esc(s.value||'')+'</p></div>'})}
          if(pl.length===0&&sl.length===0){h+='<em style="color:#94a3b8">暂无数据</em>'}}else{h+='<pre style="white-space:pre-wrap;font-size:12px">'+esc(val)+'</pre>'}}
      else if(f.key==='remarks'){h+='<div style="white-space:pre-wrap;line-height:1.6">'+(esc(val)||'<em style="color:#94a3b8">暂无备注</em>')+'</div>'}
      else{h+=esc(val)||'<em style="color:#94a3b8">-</em>'}
      h+='</div>';
      if(!isReadonly){h+='<div class="field-input" id="fi_'+f.key+'">';
        if(f.type==='select'){h+='<select id="inp_'+f.key+'">';f.options.forEach(function(o){h+='<option value="'+esc(o)+'"'+(val===o?' selected':'')+'>'+esc(o)+'</option>'});h+='</select>'}
        else if(f.type==='textarea'){h+='<textarea id="inp_'+f.key+'" rows="6">'+esc(val)+'</textarea>'}
        else{h+='<input id="inp_'+f.key+'" value="'+esc(val)+'">'}
        h+='</div>';
        h+='<button class="button secondary small edit-btn" data-key="'+f.key+'">修改</button>'}
      h+='</div></div>'});
    return h};
  var renderContacts=function(contacts){if(!contacts||contacts.length===0)return'<div style="color:#94a3b8;padding:12px">暂无联系人数据</div>';var h='<div class="section-title">👥 联系人列表 ('+contacts.length+'人)</div>';contacts.forEach(function(ct,idx){h+='<div class="persona-card" style="border-left:3px solid #1677d2">';h+='<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">';h+='<h4 style="margin:0">'+esc(ct.contact_id||'')+' — '+esc((ct.first_name||'')+' '+(ct.last_name||''))+'</h4>';h+='<span class="badge">#'+esc(String(ct.seq))+'</span></div>';
      h+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;font-size:13px">';
      var pairs=[['职位',ct.title],['全名',ct.full_name],['部门',ct.department],['邮箱',ct.email],['手机',ct.cellphone],['电话',ct.tel],['WhatsApp',ct.whatsapp],['LinkedIn',ct.linkedin_url]];
      pairs.forEach(function(p){if(p[1])h+='<div><strong>'+esc(p[0])+':</strong> '+esc(p[1])+'</div>'});
      if(ct.social_accounts){try{var sa=JSON.parse(ct.social_accounts);if(sa.length>0){h+='<div style="grid-column:1/-1"><strong>社交账号:</strong> ';sa.forEach(function(a){h+=esc(a.platform)+': '+(a.username?'@'+esc(a.username):'')+' '});h+='</div>'}}catch(e){}}
      h+='</div></div>'});return h};
  var renderVerifiedSocial=function(sv){if(!sv)return'';var social=null;try{social=JSON.parse(sv)}catch(e){}if(!social||!social.length)return'';var h='<div class="section-title">📱 已验证社交媒体</div><div style="display:flex;flex-wrap:wrap;gap:8px">';social.forEach(function(s){var icon=s.platform==='LinkedIn'?'🔗':s.platform==='Facebook'?'📘':s.platform==='Instagram'?'📷':s.platform==='Twitter'?'🐦':s.platform==='YouTube'?'📺':s.platform==='TikTok'?'🎵':'🌐';var statusColor=s.verified?'#059669':'#dc2626';var statusText=s.verified?'已验证':'未验证';h+='<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:8px"><span style="font-size:18px">'+icon+'</span><div><div style="font-weight:600;font-size:13px">'+esc(s.platform)+'</div><a href="'+esc(s.url)+'" target="_blank" style="font-size:12px;color:#1677d2;word-break:break-all">'+esc(s.url)+'</a></div><span style="font-size:11px;color:'+statusColor+';font-weight:600">'+statusText+'</span></div>'});h+='</div>';return h};
  window.openDetail=function(id){api('/admin/api/customers/'+id).then(function(c){state.selected=id;state.dirty={};$('modalTitle').textContent='客户详情 — '+esc(c.company_name||c.domain||'');var body=buildModal(c);body+=renderVerifiedSocial(c.social_accounts_verified);body+='<div class="section-title">👥 联系人列表</div>';body+='<div id="contactsArea"></div>';$('modalBody').innerHTML=body;var ca=document.getElementById('contactsArea');if(ca)ca.innerHTML=renderContacts(c.contacts);$('modalMsg').classList.add('hidden');$('modal').classList.add('active');document.body.style.overflow='hidden';
      document.querySelectorAll('.edit-btn').forEach(function(btn){btn.onclick=function(){var key=btn.getAttribute('data-key');var row=btn.closest('.field-row');row.classList.add('editing');state.dirty[key]=true;var inp=document.getElementById('inp_'+key);if(inp&&inp.focus)inp.focus()}})}).catch(function(e){showMsg('listMessage',e.message,false)})};
  var closeModal=function(){$('modal').classList.remove('active');document.body.style.overflow='';state.selected=null;state.dirty={}};
  $('closeModal').onclick=closeModal;
  $('modal').onclick=function(e){if(e.target===$('modal'))closeModal()};
  $('submitBtn').onclick=function(){if(state.selected===null)return;var payload={};Object.keys(state.dirty).forEach(function(k){if(!state.dirty[k])return;var inp=document.getElementById('inp_'+k);if(!inp)return;payload[k]=inp.value});if(Object.keys(payload).length===0){showMsg('modalMsg','没有修改内容',false);return}
    api('/admin/api/customers/'+state.selected,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).then(function(){showMsg('modalMsg','保存成功',true);return api('/admin/api/customers/'+state.selected)}).then(function(c){$('modalBody').innerHTML=buildModal(c);state.dirty={};document.querySelectorAll('.edit-btn').forEach(function(btn){btn.onclick=function(){var key=btn.getAttribute('data-key');var row=btn.closest('.field-row');row.classList.add('editing');state.dirty[key]=true;var inp=document.getElementById('inp_'+key);if(inp&&inp.focus)inp.focus()}});load()}).catch(function(e){showMsg('modalMsg',e.message,false)})};
  $('requeueBtn').onclick=function(){if(state.selected===null)return;api('/admin/api/customers/'+state.selected,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'pending'})}).then(function(){showMsg('modalMsg','已设为 pending',true);load()}).catch(function(e){showMsg('modalMsg',e.message,false)})};
  $('load').onclick=function(){state.offset=0;load()};$('search').onkeydown=function(e){if(e.key==='Enter'){state.offset=0;load()}};$('status').onchange=function(){state.offset=0;load()};$('prev').onclick=function(){if(state.offset>0){state.offset=Math.max(0,state.offset-state.limit);load()}};$('next').onclick=function(){if(state.offset+state.limit<state.total){state.offset+=state.limit;load()}};
  load();
})();
</script></body></html>`;

const OUTREACH_PANEL_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>开发信管理 - Outreach</title><style>
:root{font-family:system-ui,-apple-system,sans-serif;color:#172033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}.top{background:#0f766e;color:#fff;padding:18px 26px;display:flex;justify-content:space-between;align-items:center;gap:12px}.top h1{font-size:22px;margin:0}.wrap{max-width:1400px;margin:22px auto;padding:0 18px}.tabs{display:flex;gap:0;margin-bottom:18px;border-bottom:2px solid #d1d5db}.tab{padding:12px 24px;cursor:pointer;font-weight:600;color:#6b7280;border-bottom:3px solid transparent;transition:.2s}.tab.active{color:#0f766e;border-bottom-color:#0f766e}.tab:hover{color:#0f766e}.panel{background:#fff;border:1px solid #d1d5db;border-radius:12px;padding:20px;margin-bottom:18px}.section-title{font-size:17px;font-weight:700;color:#0f766e;margin:0 0 14px;padding-bottom:8px;border-bottom:2px solid #0f766e}
.brand-card{background:#f0fdfa;border:1px solid #99f6e4;border-radius:12px;padding:20px;margin-bottom:16px}.brand-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.brand-name{font-size:20px;font-weight:700;color:#0f766e}.brand-category{font-size:13px;color:#6b7280;background:#e0f2fe;padding:4px 10px;border-radius:20px}
.toggle{position:relative;display:inline-block;width:50px;height:26px}.toggle input{opacity:0;width:0;height:0}.slider{position:absolute;cursor:pointer;inset:0;background:#cbd5e1;border-radius:26px;transition:.3s}.slider:before{content:'';position:absolute;height:20px;width:20px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.3s}input:checked+.slider{background:#0f766e}input:checked+.slider:before{transform:translateX(24px)}
.intro-textarea{width:100%;min-height:120px;padding:12px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;resize:vertical;margin-top:8px}
.btn{padding:10px 20px;border:0;border-radius:8px;cursor:pointer;font:inherit;font-weight:600;transition:.2s}.btn-primary{background:#0f766e;color:#fff}.btn-primary:hover{background:#115e59}.btn-secondary{background:#6b7280;color:#fff}.btn-secondary:hover{background:#4b5563}.btn-danger{background:#dc2626;color:#fff}.btn-danger:hover{background:#b91c1c}.btn-sm{padding:6px 14px;font-size:13px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:18px}.stat-card{background:#f0fdfa;border:1px solid #99f6e4;border-radius:10px;padding:16px;text-align:center}.stat-value{font-size:28px;font-weight:700;color:#0f766e}.stat-label{font-size:13px;color:#6b7280;margin-top:4px}
.email-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:12px}.email-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.email-subject{font-weight:700;font-size:15px;color:#111827}.email-meta{font-size:12px;color:#6b7280;margin-bottom:8px}.email-body{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px;white-space:pre-wrap;font-size:13px;line-height:1.6;color:#374151}
.badge{display:inline-block;border-radius:20px;padding:3px 10px;font-size:12px;font-weight:600}.badge-draft{background:#fef3c7;color:#92400e}.badge-sent{background:#d1fae5;color:#065f46}
.toast{position:fixed;top:20px;right:20px;padding:14px 20px;border-radius:10px;color:#fff;font-weight:600;z-index:9999;display:none}.toast.success{background:#059669}.toast.error{background:#dc2626}
@media(max-width:700px){.top{flex-direction:column}.stats{grid-template-columns:1fr 1fr}.email-header{flex-direction:column;align-items:flex-start;gap:6px}}
</style></head><body>
<header class="top"><h1>📧 开发信管理</h1><div style="display:flex;gap:10px;align-items:center"><a href="/admin" style="color:#fff;text-decoration:none;font-weight:600">← 返回客户管理</a><form method="post" action="/admin/logout"><button class="btn btn-sm" style="background:rgba(255,255,255,.2);color:#fff" type="submit">退出</button></form></div></header>
<main class="wrap">
<div class="tabs"><div class="tab active" data-tab="settings">⚙️ 品牌设置</div><div class="tab" data-tab="generate">🤖 生成开发信</div><div class="tab" data-tab="emails">📬 开发信列表</div></div>
<div id="tab-settings" class="tab-content">
<div class="section-title">品牌配置</div><div id="brandsArea"></div>
</div>
<div id="tab-generate" class="tab-content" style="display:none">
<div class="section-title">生成开发信</div>
<div class="panel"><p>选择品牌，AI将根据数据库中匹配的客户信息自动生成个性化开发信。</p>
<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:12px">
<select id="genBrand" style="padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit;min-width:200px"></select>
<select id="genLimit" style="padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit"><option value="5">5封</option><option value="10" selected>10封</option><option value="20">20封</option><option value="50">50封</option></select>
<button class="btn btn-primary" id="genBtn">🚀 开始生成</button>
</div><div id="genMsg" style="margin-top:12px"></div></div>
</div>
<div id="tab-emails" class="tab-content" style="display:none">
<div class="stats" id="statsArea"></div>
<div class="panel"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
<select id="filterBrand" style="padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit"><option value="">全部品牌</option><option value="Afarer">Afarer (SUPs)</option><option value="Aquafarer">Aquafarer (Inflatable)</option><option value="Neptunor">Neptunor (RIB)</option></select>
<select id="filterStatus" style="padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit"><option value="">全部状态</option><option value="draft">草稿</option><option value="sent">已发送</option></select>
<button class="btn btn-secondary btn-sm" id="refreshEmails">刷新</button>
<span id="quotaInfo" style="font-size:13px;color:#475569;margin-left:auto">📧 Gmail 配额加载中…</span>
<button class="btn btn-primary btn-sm" id="sendBatchBtn">📤 批量发送草稿</button>
</div><div id="emailsArea"></div>
<div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px"><button class="btn btn-secondary btn-sm" id="emailPrev">上一页</button><span id="emailPageInfo"></span><button class="btn btn-secondary btn-sm" id="emailNext">下一页</button></div>
</div>
</div>
</main>
<div class="toast" id="toast"></div>
<script>
(function(){
var toastTimeout;
function showToast(msg,isOk){var t=document.getElementById('toast');t.textContent=msg;t.className='toast '+(isOk?'success':'error');t.style.display='block';clearTimeout(toastTimeout);toastTimeout=setTimeout(function(){t.style.display='none'},4000)}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function api(p,o){return fetch(p,o||{}).then(function(r){if(r.status===401){location='/admin/outreach';throw new Error('登录过期')}var ct=r.headers.get('content-type')||'';if(ct.indexOf('json')===-1){return r.text().then(function(t){throw new Error('非JSON响应: '+t.slice(0,100))})}return r.json().then(function(d){if(!r.ok)throw new Error(d.detail||'请求失败');return d})})}

// Tab switching
document.querySelectorAll('.tab').forEach(function(tab){tab.onclick=function(){document.querySelectorAll('.tab').forEach(function(t){t.classList.remove('active')});document.querySelectorAll('.tab-content').forEach(function(c){c.style.display='none'});tab.classList.add('active');document.getElementById('tab-'+tab.dataset.tab).style.display='block';if(tab.dataset.tab==='settings')loadBrands();if(tab.dataset.tab==='emails'){loadStats();loadEmails();loadQuota()}}});

// Brand settings
function loadBrands(){
  api('/admin/api/outreach/settings').then(function(d){
    var h='';
    d.settings.forEach(function(b){
      h+='<div class="brand-card"><div class="brand-header"><div><span class="brand-name">'+esc(b.brand_name)+'</span> <span class="brand-category">'+esc(b.product_category)+'</span></div><label class="toggle"><input type="checkbox" '+(b.enabled?'checked':'')+' data-brand="'+esc(b.brand_name)+'" class="enable-toggle"><span class="slider"></span></label></div>'+
        '<label style="font-weight:600;font-size:13px;color:#475569">发件身份（From 邮箱 / 显示名）</label><div style="display:flex;gap:8px;margin-top:4px"><input class="sender-email" data-brand="'+esc(b.brand_name)+'" placeholder="sender@yourdomain.com" value="'+esc(b.sender_email||'')+'" style="flex:1;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px"><input class="sender-name" data-brand="'+esc(b.brand_name)+'" placeholder="Toby | Afarer Team" value="'+esc(b.sender_name||'')+'" style="flex:1;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px"></div>'+
        '<label style="font-weight:600;font-size:13px;color:#475569;display:block;margin-top:10px">邮件签名（原样附加在正文末尾）</label><textarea class="signature-textarea" data-brand="'+esc(b.brand_name)+'" style="width:100%;min-height:70px;margin-top:4px;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;font-family:monospace">'+esc(b.signature||'')+'</textarea>'+
        '<label style="font-weight:600;font-size:13px;color:#475569;display:block;margin-top:10px">邮件附件（最多 5 个，每个 ≤1.4MB，发送时自动附带）</label><div class="att-list" data-brand="'+esc(b.brand_name)+'" style="margin-top:4px;font-size:13px;color:#334155">加载中…</div><div style="display:flex;gap:8px;margin-top:6px;align-items:center"><input type="file" class="att-file" data-brand="'+esc(b.brand_name)+'" style="font-size:13px"><button class="btn btn-sm btn-primary att-upload" data-brand="'+esc(b.brand_name)+'">⬆ 上传附件</button></div>'+
        '<label style="font-weight:600;font-size:13px;color:#475569;display:block;margin-top:10px">公司简介</label><textarea class="intro-textarea" data-brand="'+esc(b.brand_name)+'">'+esc(b.company_intro)+'</textarea><div style="margin-top:10px;text-align:right"><button class="btn btn-primary btn-sm save-brand" data-brand="'+esc(b.brand_name)+'">💾 保存配置</button></div></div>';
    });
    document.getElementById('brandsArea').innerHTML=h||'<p>暂无品牌配置</p>';
    document.querySelectorAll('.brand-card').forEach(function(card){
      var brand=card.querySelector('.enable-toggle').dataset.brand;
      loadAttachments(brand);
    });
    document.querySelectorAll('.enable-toggle').forEach(function(el){
      el.onchange=function(){
        var brand=el.dataset.brand;
        var enabled=el.checked;
        api('/admin/api/outreach/settings/'+encodeURIComponent(brand),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:enabled})})
          .then(function(){showToast(brand+(enabled?' 已启用':' 已禁用'),true)})
          .catch(function(e){showToast(e.message,false);el.checked=!enabled});
      };
    });
    document.querySelectorAll('.att-upload').forEach(function(el){
      el.onclick=function(){
        var brand=el.dataset.brand;
        var input=document.querySelector('.att-file[data-brand="'+brand+'"]');
        if(!input.files||!input.files[0]){showToast('请选择文件',false);return}
        var file=input.files[0];
        if(file.size>1400000){showToast('文件超过 1.4MB（D1 存储限制）',false);return}
        var btn=el;btn.disabled=true;btn.textContent='⏳ 上传中…';
        var reader=new FileReader();
        reader.onload=function(){
          var b64=reader.result.split(',')[1];
          api('/admin/api/outreach/attachments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({brand:brand,filename:file.name,mime_type:file.type||'application/octet-stream',content_base64:b64})})
            .then(function(){showToast('附件已上传',true);loadAttachments(brand)})
            .catch(function(e){showToast(e.message,false)})
            .finally(function(){btn.disabled=false;btn.textContent='⬆ 上传附件';input.value=''});
        };
        reader.readAsDataURL(file);
      };
    });
    document.querySelectorAll('.save-brand').forEach(function(el){
      el.onclick=function(){
        var brand=el.dataset.brand;
        var ta=document.querySelector('.intro-textarea[data-brand="'+brand+'"]');
        var se=document.querySelector('.sender-email[data-brand="'+brand+'"]');
        var sn=document.querySelector('.sender-name[data-brand="'+brand+'"]');
        var sg=document.querySelector('.signature-textarea[data-brand="'+brand+'"]');
        api('/admin/api/outreach/settings/'+encodeURIComponent(brand),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({company_intro:ta.value,sender_email:se.value,sender_name:sn.value,signature:sg.value})})
          .then(function(){showToast(brand+' 配置已保存（签名已更新）',true)})
          .catch(function(e){showToast(e.message,false)});
      };
    });
  }).catch(function(e){
    document.getElementById('brandsArea').innerHTML='<p style="color:red">'+esc(e.message)+'</p>';
  });
}

function loadAttachments(brand){var box=document.querySelector('.att-list[data-brand="'+brand+'"]');if(!box)return;api('/admin/api/outreach/attachments?brand='+encodeURIComponent(brand)).then(function(d){if(!d.attachments.length){box.innerHTML='<span style="color:#6b7280">暂无附件</span>';return}box.innerHTML=d.attachments.map(function(a){return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0"><span>📄 '+esc(a.filename)+' ('+Math.round(a.size_bytes/1024)+' KB)</span><button class="btn btn-sm btn-danger att-del" data-id="'+a.id+'" data-brand="'+esc(brand)+'">删除</button></div>'}).join('');box.querySelectorAll('.att-del').forEach(function(btn){btn.onclick=function(){api('/admin/api/outreach/attachments/'+btn.dataset.id,{method:'DELETE'}).then(function(){showToast('附件已删除',true);loadAttachments(btn.dataset.brand)}).catch(function(e){showToast(e.message,false)})}})}).catch(function(){box.innerHTML='<span style="color:#6b7280">附件加载失败</span>'})}

// Generate
api('/admin/api/outreach/settings').then(function(d){var sel=document.getElementById('genBrand');sel.innerHTML='';d.settings.forEach(function(b){if(b.enabled){var opt=document.createElement('option');opt.value=b.brand_name;opt.textContent=b.brand_name+' ('+b.product_category+')';sel.appendChild(opt)}});if(!sel.options.length){sel.innerHTML='<option value="">-- 请先启用品牌 --</option>'}});
document.getElementById('genBtn').onclick=function(){var brand=document.getElementById('genBrand').value;var limit=Number(document.getElementById('genLimit').value);if(!brand){showToast('请选择品牌',false);return}var btn=document.getElementById('genBtn');btn.disabled=true;btn.textContent='⏳ 生成中...';showMsg('genMsg','正在为 '+brand+' 生成开发信，请稍候...',false);
api('/admin/api/outreach/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({brand:brand,limit:limit})}).then(function(r){showMsg('genMsg','✅ 成功生成 '+r.generated+' 封开发信'+(r.errors.length?'，'+r.errors.length+' 条失败':''),true);showToast('生成完成: '+r.generated+'封',true)}).catch(function(e){showMsg('genMsg','❌ '+e.message,false);showToast(e.message,false)}).finally(function(){btn.disabled=false;btn.textContent='🚀 开始生成'})};
function showMsg(id,t,g){var e=document.getElementById(id);if(!e)return;e.textContent=t;e.className='notice '+(g?'success':'error');e.style.display='block'}

// Email list
var emailState={offset:0,limit:20,total:0};
function loadStats(){api('/admin/api/outreach/stats').then(function(s){var h='<div class="stat-card"><div class="stat-value">'+s.total+'</div><div class="stat-label">总计</div></div><div class="stat-card"><div class="stat-value">'+s.draft+'</div><div class="stat-label">草稿</div></div><div class="stat-card"><div class="stat-value">'+s.sent+'</div><div class="stat-label">已发送</div></div>';s.by_brand.forEach(function(b){h+='<div class="stat-card"><div class="stat-value">'+b.count+'</div><div class="stat-label">'+esc(b.brand_name)+'</div></div>'});document.getElementById('statsArea').innerHTML=h}).catch(function(){})}
function loadEmails(){
  var brand=document.getElementById('filterBrand').value;
  var status=document.getElementById('filterStatus').value;
  var p=new URLSearchParams({limit:String(emailState.limit),offset:String(emailState.offset)});
  if(brand)p.set('brand',brand);
  if(status)p.set('status',status);
  api('/admin/api/outreach/emails?'+p.toString()).then(function(d){
    emailState.total=d.total;
    var h='';
    d.items.forEach(function(e){
      h+='<div class="email-card"><div class="email-header"><span class="email-subject">'+esc(e.subject||'(无主题)')+'</span><div><span class="badge badge-'+esc(e.status)+'">'+(e.status==='sent'?'已发送':'草稿')+'</span> <button class="btn btn-sm btn-danger del-email" data-id="'+e.id+'">删除</button>'+(e.status==='draft'?' <button class="btn btn-sm btn-primary send-one" data-id="'+e.id+'">📧 发送</button>':'')+'</div></div><div class="email-meta">'+esc(e.brand_name||'')+' → '+esc(e.company_name||'')+' ('+esc(e.display_id||'')+') | 收件人: '+esc(e.email_to||'未知')+' | '+esc(e.created_at||'')+'</div><div class="email-body">'+esc(e.body||'')+'</div></div>';
    });
    if(!d.items.length)h='<p style="color:#6b7280;text-align:center;padding:20px">暂无开发信</p>';
    emailState.total=d.total;
    document.getElementById('emailsArea').innerHTML=h;
    document.getElementById('emailPageInfo').textContent=(d.total?emailState.offset+1:0)+'-'+Math.min(emailState.offset+emailState.limit,d.total)+' / '+d.total;
    document.getElementById('emailPrev').disabled=emailState.offset===0;
    document.getElementById('emailNext').disabled=emailState.offset+emailState.limit>=d.total;
    document.querySelectorAll('.del-email').forEach(function(b){
      b.onclick=function(){
        if(!confirm('确定删除？'))return;
        api('/admin/api/outreach/emails/'+b.dataset.id,{method:'DELETE'})
          .then(function(){showToast('已删除',true);loadEmails();loadStats()})
          .catch(function(e){showToast(e.message,false)});
      };
    });
    document.querySelectorAll('.send-one').forEach(function(b){
      b.onclick=function(){
        if(b.disabled)return;
        b.disabled=true;b.textContent='⏳…';
        api('/admin/api/outreach/emails/'+b.dataset.id+'/send',{method:'POST'})
          .then(function(d){
            if(d.ok){showToast('已通过 Gmail 发送（今日 '+d.quota.sent_today+'/'+d.quota.daily_limit+'）',true)}
            else{showToast('发送失败：'+(d.error||'未知错误'),false)}
            loadQuota();loadStats();loadEmails();
          })
          .catch(function(e){showToast(e.message,false);b.disabled=false;b.textContent='📧 发送'});
      };
    });
  }).catch(function(e){
    document.getElementById('emailsArea').innerHTML='<p style="color:red">'+esc(e.message)+'</p>';
  });
}
document.getElementById('refreshEmails').onclick=function(){emailState.offset=0;loadEmails()};

function loadQuota(){api('/admin/api/outreach/quota').then(function(q){document.getElementById('quotaInfo').textContent='📧 Gmail 今日 '+q.sent_today+'/'+q.daily_limit+' 剩余 '+q.remaining}).catch(function(){document.getElementById('quotaInfo').textContent='📧 Gmail 未配置'})}

var sending=false;
document.getElementById('sendBatchBtn').onclick=function(){
if(sending)return;
var brand=document.getElementById('filterBrand').value;
var n=prompt('本次批量发送数量（1-50，受每日配额限制）：','10');
if(n===null)return;
sending=true;
var btn=this;btn.textContent='⏳ 发送中…';
showToast('开始批量发送，每封间隔几秒，请勿关闭页面',true);
api('/admin/api/outreach/send-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({brand:brand||undefined,limit:Number(n)||10})}).then(function(d){
var fails=d.results.filter(function(r){return !r.ok});
showToast('发送完成：成功 '+d.sent+' 封，失败 '+d.failed+' 封（今日 '+d.quota.sent_today+'/'+d.quota.daily_limit+'）',d.failed===0);
if(fails.length){console.log('发送失败明细',fails);alert('前3条失败原因：\\n'+fails.slice(0,3).map(function(f){return '#'+f.id+': '+f.error}).join('\\n'))}
}).catch(function(e){showToast(e.message,false)}).finally(function(){sending=false;btn.textContent='📤 批量发送草稿';loadQuota();loadEmails();loadStats()})};
document.getElementById('filterBrand').onchange=function(){emailState.offset=0;loadEmails()};
document.getElementById('filterStatus').onchange=function(){emailState.offset=0;loadEmails()};
document.getElementById('emailPrev').onclick=function(){if(emailState.offset>0){emailState.offset=Math.max(0,emailState.offset-emailState.limit);loadEmails()}};
document.getElementById('emailNext').onclick=function(){if(emailState.offset+emailState.limit<emailState.total){emailState.offset+=emailState.limit;loadEmails()}};

// Init
loadBrands();
})();
</script></body></html>`;

/* ── Dynamic key-pool panel (方案B: D1 api_configs CRUD) ── */
const KEYS_PANEL_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>动态 Key 池 - CRM</title><style>
body{font-family:system-ui,sans-serif;margin:0;background:#f3f5f9;color:#1f2430}
.top{background:#1f2430;color:#fff;padding:14px 24px;display:flex;justify-content:space-between;align-items:center}
.top h1{font-size:18px;margin:0}
.top a{color:#fff;text-decoration:none;background:rgba(255,255,255,.15);padding:8px 14px;border-radius:8px;font-weight:600;font-size:14px}
.wrap{max-width:960px;margin:24px auto;padding:0 16px}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:20px;margin-bottom:20px}
h2{font-size:16px;margin:0 0 12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.field label{font-size:12px;color:#5a6270;display:block;margin-bottom:3px}
.field input,.field select{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #ccd2dd;border-radius:6px;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f0f2f7;padding:8px;text-align:left;font-size:12px;color:#5a6270}
td{padding:8px;border-bottom:1px solid #eef1f6}
tr.inactive td{opacity:.5}
.cdtag{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:10px;background:#fef3c7;color:#92400e;font-size:12px}
.btn{border:0;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px;font-weight:600}
.btn.on{background:#3f9d63;color:#fff}.btn.off{background:#8b93a3;color:#fff}.btn.del{background:#fde8e8;color:#b23b3b}
#toast{position:fixed;top:18px;right:18px;background:#1f2430;color:#fff;padding:10px 16px;border-radius:8px;font-size:14px;display:none;max-width:420px;z-index:9}
#toast.err{background:#b23b3b}
.hint{font-size:12px;color:#7a8291;margin-top:6px}
</style></head><body>
<header class="top"><h1>⚡ 动态 Key 池（D1 即时生效，无需部署）</h1><a href="/admin">← 返回客户管理</a></header>
<div class="wrap">
<div class="card"><h2>➕ 添加 Key</h2>
  <div class="grid">
    <div class="field"><label>平台</label><select id="nkProvider">
      <option value="gemini">Gemini</option><option value="groq">Groq</option><option value="cerebras">Cerebras</option>
      <option value="zhipu">Zhipu GLM</option><option value="nvidia">NVIDIA NIM</option><option value="amd">AMD Radeon</option><option value="mistral">Mistral</option>
      <option value="deepseek">DeepSeek</option><option value="openrouter">OpenRouter</option>
      <option value="tavily">Tavily 搜索</option><option value="exa">Exa 搜索</option><option value="brave">Brave 搜索</option><option value="searlo">Searlo 搜索</option>
    </select></div>
    <div class="field"><label>备注</label><input id="nkLabel" placeholder="如: 账号2"></div>
    <div class="field"><label>API Key</label><input id="nkKey" autocomplete="off"></div>
    <div class="field"><label>单Key RPM (留空=默认)</label><input id="nkRpm" type="number" min="1"></div>
    <div class="field"><label>模型覆盖 (留空=默认)</label><input id="nkModel" placeholder="如 llama-3.3-70b"></div>
  </div>
  <p><button class="btn on" id="addKey" style="padding:9px 22px">添加 Key</button></p>
  <p class="hint">Key 池按 D1 优先解析：此处添加的 Key 立即生效（30 秒内全节点刷新）；env Secrets 仅作为引导后备。</p>
</div>
<div class="card"><h2>📦 批量导入（适合 Tavily/Exa 等大量 Key）</h2>
  <div class="grid">
    <div class="field"><label>平台</label><select id="bulkProvider">
      <option value="tavily">Tavily 搜索</option><option value="exa">Exa 搜索</option><option value="brave">Brave 搜索</option><option value="searlo">Searlo 搜索</option>
      <option value="gemini">Gemini</option><option value="groq">Groq</option><option value="cerebras">Cerebras</option>
      <option value="zhipu">Zhipu GLM</option><option value="nvidia">NVIDIA NIM</option><option value="amd">AMD Radeon</option><option value="mistral">Mistral</option>
      <option value="deepseek">DeepSeek</option><option value="openrouter">OpenRouter</option>
    </select></div>
    <div class="field"><label>备注前缀（自动编号）</label><input id="bulkLabel" placeholder="如: 账号 → 账号1、账号2…"></div>
    <div class="field"><label>统一模型覆盖 (留空=默认)</label><input id="bulkModel" placeholder="仅 AI 平台需要"></div>
    <div class="field"><label>统一单Key RPM (留空=默认)</label><input id="bulkRpm" type="number" min="1"></div>
  </div>
  <div class="field"><label>导入模板（每行一条：<b>API Key,备注/账号</b>；也支持 Tab 或 | 分隔，纯 Key 也可以）</label>
    <textarea id="bulkKeys" rows="8" autocomplete="off" spellcheck="false" style="width:100%;font-family:monospace;font-size:13px" placeholder="tvly-xxxxxxxx,账号1
tvly-yyyyyyyy,账号2
tvly-zzzzzzzz,账号3"></textarea>
    <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <span style="font-size:12px;color:#6b7280">填充模板：</span>
      <button class="btn tpl" data-tpl="tavily" type="button">Tavily</button>
      <button class="btn tpl" data-tpl="exa" type="button">Exa</button>
      <button class="btn tpl" data-tpl="brave" type="button">Brave</button>
      <button class="btn tpl" data-tpl="generic" type="button">通用</button>
      <span style="font-size:12px;color:#6b7280">（覆盖 textarea 内容；分隔符可用英文逗号、Tab 或 | ）</span>
    </div>
  </div>
  <p><button class="btn on" id="bulkImport" style="padding:9px 22px">批量导入</button></p>
</div>
<div class="card"><h2>🗝 已配置 Keys</h2><div style="overflow-x:auto"><table id="keysTable"><thead><tr><th>平台</th><th>备注</th><th>Key</th><th>RPM</th><th>模型</th><th>状态</th><th>最近错误</th><th>操作</th></tr></thead><tbody></tbody></table></div></div>
<div class="card"><h2>📊 本月用量（成功调用数，按自然月）<span style="font-size:11px;color:#94a3b8;font-weight:400"> v2026-09-09b</span></h2><div id="usageBox"><p style="color:#6b7280;margin:4px 0">加载中…</p></div></div>
<div class="card"><h2>🧊 冷却中的 Key（429/限流自动暂停）</h2><div id="cooldownBox"></div></div>
<div class="card"><h2>📜 冷却历史（最近 20 条）</h2><div id="historyBox"></div></div>
<div class="card"><h2>⚙️ 平台设置（默认模型 / 总RPM / 启用）</h2><div id="settingsBox"></div></div>
</div>
<div id="toast"></div>
<script>
(function(){
var toastEl=document.getElementById('toast');
function toast(msg,err){toastEl.textContent=msg;toastEl.className=err?'err':'';toastEl.style.display='block';setTimeout(function(){toastEl.style.display='none'},4000)}
function api(p,o){return fetch(p,o||{}).then(function(r){if(r.status===401){location='/admin';throw new Error('登录过期')}return r.json().then(function(d){if(!r.ok)throw new Error(d.detail||'请求失败');return d})})}
var PROVIDER_NAMES={gemini:'Gemini',groq:'Groq',cerebras:'Cerebras',zhipu:'Zhipu',nvidia:'NVIDIA',amd:'AMD',mistral:'Mistral',deepseek:'DeepSeek',openrouter:'OpenRouter',tavily:'Tavily',exa:'Exa',brave:'Brave',searlo:'Searlo'};
function loadKeys(){
  api('/admin/api/keys').then(function(d){
    var tb=document.querySelector('#keysTable tbody');tb.innerHTML='';
    var cdMap={};
    (d.cooldowns||[]).forEach(function(c){
      var m=/^([a-z]+):(\d+)$/.exec(c.key_index||'');
      if(m&&m[1]===c.provider)cdMap[Number(m[2])]=c;
    });
    d.keys.forEach(function(k){
      var tr=document.createElement('tr');if(!k.is_active)tr.className='inactive';
      var cd=cdMap[k.id];
      var status=k.is_active?'启用':'停用';
      if(cd){var mins=Math.max(1,Math.round((new Date(cd.exhausted_until.replace(' ','T')+'Z')-Date.now())/60000));status+='<span class="cdtag">冷却中 ~'+mins+'分钟</span>';}
      tr.innerHTML='<td>'+PROVIDER_NAMES[k.provider]+'</td><td>'+(k.label||'-')+'</td><td><code>'+k.api_key+'</code></td><td>'+(k.rpm_limit||'默认')+'</td><td>'+(k.model||'-')+'</td><td>'+status+'</td><td>'+(k.last_error||'-')+'</td>';
      var td=document.createElement('td');
      var tog=document.createElement('button');tog.className='btn '+(k.is_active?'off':'on');tog.textContent=k.is_active?'停用':'启用';
      tog.onclick=function(){api('/admin/api/keys/'+k.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({is_active:!k.is_active})}).then(loadKeys).catch(function(e){toast(e.message,true)})};
      var del=document.createElement('button');del.className='btn del';del.textContent='删除';del.style.marginLeft='6px';
      del.onclick=function(){if(!confirm('确认删除该 Key？'))return;api('/admin/api/keys/'+k.id,{method:'DELETE'}).then(loadKeys).catch(function(e){toast(e.message,true)})};
      td.appendChild(tog);td.appendChild(del);tr.appendChild(td);tb.appendChild(tr);
    });
    api('/admin/api/keys/usage').then(function(u){
      var box=document.getElementById('usageBox');
      var list=u.usage||[];
      if(list.length===0){box.innerHTML='<p style="color:#6b7280;margin:4px 0">本月暂无调用记录</p>';return;}
      var h='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr>'+
        '<th style="text-align:left;padding:4px 8px">平台</th><th style="text-align:right;padding:4px 8px">本月</th><th style="text-align:right;padding:4px 8px">累计</th><th style="text-align:right;padding:4px 8px">活动Key</th><th style="text-align:right;padding:4px 8px">本月用过</th><th style="text-align:right;padding:4px 8px">月容量(估算)</th><th style="text-align:right;padding:4px 8px">消耗</th></tr></thead><tbody>';
      list.forEach(function(r){
        var pct=r.monthly_capacity?Math.min(100,Math.round(r.month_calls/r.monthly_capacity*100)):null;
        var bar=pct===null?'<span style="color:#9ca3af">—</span>':'<div style="background:#e5e7eb;border-radius:6px;height:10px;width:110px;position:relative"><div style="background:'+(pct>80?'#dc2626':pct>50?'#f59e0b':'#16a34a')+';border-radius:6px;height:10px;width:'+pct+'%"></div></div><span style="font-size:11px;color:#6b7280">'+pct+'%</span>';
        h+='<tr style="border-top:1px solid #f1f5f9"><td style="padding:4px 8px">'+PROVIDER_NAMES[r.provider]+'</td>'+
          '<td style="text-align:right;padding:4px 8px">'+r.month_calls+'</td><td style="text-align:right;padding:4px 8px">'+r.total_calls+'</td>'+
          '<td style="text-align:right;padding:4px 8px">'+r.active_keys+(r.cooling_keys?(' <span style="color:#dc2626;font-size:11px">(🧊'+r.cooling_keys+')</span>'):'')+'</td>'+
          '<td style="text-align:right;padding:4px 8px">'+r.keys_used_this_month+'</td>'+
          '<td style="text-align:right;padding:4px 8px">'+(r.monthly_capacity?r.monthly_capacity:'—')+'</td>'+
          '<td style="padding:4px 8px">'+bar+'</td></tr>';
      });
      h+='</tbody></table></div><p style="font-size:12px;color:#6b7280;margin:6px 0 0">月容量按免费层估算：Tavily 500次深度搜索/Key、Exa ~2000次/Key、Brave 2000次/Key；AI 平台无固定容量（取决于 token 混合）。</p>';
      box.innerHTML=h;
    }).catch(function(){document.getElementById('usageBox').innerHTML='<p style="color:#6b7280;margin:4px 0">用量数据不可用</p>'});
    var cdBox=document.getElementById('cooldownBox');
    var cdList=d.cooldowns||[];
    if(cdList.length===0){cdBox.innerHTML='<p style="color:#16a34a;margin:4px 0">✓ 所有 Key 状态正常，无冷却中</p>';}
    else{
      cdBox.innerHTML='';
      cdList.forEach(function(c){
        var row=document.createElement('div');row.style.cssText='display:flex;gap:10px;align-items:center;margin:4px 0';
        var mins=Math.max(1,Math.round((new Date(c.exhausted_until.replace(' ','T')+'Z')-Date.now())/60000));
        row.innerHTML='<span style="min-width:90px">'+PROVIDER_NAMES[c.provider]+'</span><code style="min-width:130px">'+(c.key_index||'')+'</code><span style="color:#dc2626">'+(c.last_error||'限流')+'</span><span>剩余 ~'+mins+' 分钟</span>';
        var clr=document.createElement('button');clr.className='btn on';clr.textContent='清除';
        clr.onclick=function(){api('/admin/api/keys/cooldowns/'+c.provider,{method:'DELETE'}).then(loadKeys).catch(function(e){toast(e.message,true)})};
        row.appendChild(clr);cdBox.appendChild(row);
      });
    }
    var histBox=document.getElementById('historyBox');
    var histList=d.history||[];
    if(histList.length===0){histBox.innerHTML='<p style="color:#6b7280;margin:4px 0">暂无历史记录</p>';}
    else{
      histBox.innerHTML='';
      histList.forEach(function(c){
        var row=document.createElement('div');row.style.cssText='display:flex;gap:10px;align-items:center;margin:4px 0;color:#6b7280;font-size:13px';
        var until='';
        try{until=new Date(c.exhausted_until.replace(' ','T')+'Z').toLocaleString();}catch(e){until=c.exhausted_until||'';}
        row.innerHTML='<span style="min-width:90px">'+PROVIDER_NAMES[c.provider]+'</span><code style="min-width:130px">'+(c.key_index||'')+'</code><span style="color:#dc2626">'+(c.last_error||'限流')+'</span><span>冷却至 '+until+'</span>';
        histBox.appendChild(row);
      });
    }
    var sb=document.getElementById('settingsBox');sb.innerHTML='';
    var sMap={};(d.settings||[]).forEach(function(s){sMap[s.provider]=s});
    Object.keys(PROVIDER_NAMES).forEach(function(p){
      var s=sMap[p]||{};
      var row=document.createElement('div');row.style.cssText='display:flex;gap:10px;align-items:end;margin-bottom:8px;flex-wrap:wrap';
      row.innerHTML='<div class="field"><label>'+PROVIDER_NAMES[p]+' 默认模型</label><input id="m_'+p+'" value="'+(s.default_model||'')+'" style="width:200px"></div>'+
        '<div class="field"><label>总RPM (留空=按Key数推算)</label><input id="r_'+p+'" type="number" min="1" value="'+(s.rpm_total||'')+'" style="width:160px"></div>';
      var en=document.createElement('div');en.className='field';en.innerHTML='<label>启用</label>';
      var cb=document.createElement('input');cb.type='checkbox';cb.id='e_'+p;cb.checked=s.enabled===undefined?true:!!s.enabled;en.appendChild(cb);row.appendChild(en);
      var btn=document.createElement('button');btn.className='btn on';btn.textContent='保存';
      btn.onclick=function(){api('/admin/api/keys/settings/'+p,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({default_model:document.getElementById('m_'+p).value,rpm_total:document.getElementById('r_'+p).value||null,enabled:cb.checked})}).then(function(){toast(PROVIDER_NAMES[p]+' 设置已保存')}).catch(function(e){toast(e.message,true)})};
      row.appendChild(btn);sb.appendChild(row);
    });
  }).catch(function(e){toast(e.message,true)});
}
var TPL={
  tavily:'tvly-你的APIKey1,账号1\\ntvly-你的APIKey2,账号2\\ntvly-你的APIKey3,账号3',
  exa:'exa-你的APIKey1,账号1\\nexa-你的APIKey2,账号2\\nexa-你的APIKey3,账号3',
  brave:'Brave-APIKey1,账号1\\nBrave-APIKey2,账号2\\nBrave-APIKey3,账号3',
  generic:'API-Key-1,账号1\\nAPI-Key-2,账号2\\nAPI-Key-3,账号3'
};
document.querySelectorAll('.btn.tpl').forEach(function(b){
  b.onclick=function(){document.getElementById('bulkKeys').value=TPL[b.getAttribute('data-tpl')]||'';document.getElementById('bulkKeys').focus()};
});
document.getElementById('bulkImport').onclick=function(){
  var btn=this;btn.disabled=true;
  var txt=document.getElementById('bulkKeys').value;
  if(!txt.trim()){toast('请先粘贴 Key 列表（可点击上方模板按钮填充格式）',true);btn.disabled=false;return;}
  if(txt.indexOf('你的APIKey')!==-1){toast('模板占位符未替换：请把 你的APIKey1 换成真实 Key 再导入',true);btn.disabled=false;return;}
  toast('正在导入…');
  api('/admin/api/keys/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:document.getElementById('bulkProvider').value,label_prefix:document.getElementById('bulkLabel').value,model:document.getElementById('bulkModel').value,rpm_limit:document.getElementById('bulkRpm').value||null,keys:txt})})
  .then(function(r){toast('批量导入完成：新增 '+r.added+' 个'+(r.skipped?('，跳过重复 '+r.skipped+' 个'):''));document.getElementById('bulkKeys').value='';loadKeys()})
  .catch(function(e){toast(e.message,true)})
  .finally(function(){btn.disabled=false});
};
document.getElementById('addKey').onclick=function(){
  var btn=this;btn.disabled=true;
  api('/admin/api/keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:document.getElementById('nkProvider').value,label:document.getElementById('nkLabel').value,api_key:document.getElementById('nkKey').value,rpm_limit:document.getElementById('nkRpm').value||null,model:document.getElementById('nkModel').value})})
  .then(function(){toast('Key 已添加并生效');['nkLabel','nkKey','nkRpm','nkModel'].forEach(function(i){document.getElementById(i).value=''});loadKeys()})
  .catch(function(e){toast(e.message,true)})
  .finally(function(){btn.disabled=false});
};
loadKeys();
// Auto-refresh every 30s so cooldown timers tick down live. Skipped while a
// form field has focus (typing a new key) and while the tab is hidden.
var _focusCount=0;
document.addEventListener('focusin',function(e){if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA')_focusCount++});
document.addEventListener('focusout',function(e){if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA')_focusCount=Math.max(0,_focusCount-1)});
setInterval(function(){if(_focusCount===0&&!document.hidden)loadKeys()},30000);
})();
</script></body></html>`;

/* ── AI Key / secrets management panel (方案A: 直写 Cloudflare API) ── */
const SECRETS_PANEL_HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Key 管理 - CRM</title><style>
body{font-family:system-ui,sans-serif;margin:0;background:#f3f5f9;color:#1f2430}
.top{background:#1f2430;color:#fff;padding:14px 24px;display:flex;justify-content:space-between;align-items:center}
.top h1{font-size:18px;margin:0}
.top a{color:#fff;text-decoration:none;background:rgba(255,255,255,.15);padding:8px 14px;border-radius:8px;font-weight:600;font-size:14px}
.wrap{max-width:860px;margin:24px auto;padding:0 16px}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:20px;margin-bottom:20px}
.notice{background:#fff8e1;border:1px solid #f0d264;border-radius:8px;padding:10px 14px;font-size:14px;margin-bottom:16px}
.group{margin-bottom:24px}
.group h2{font-size:16px;border-bottom:2px solid #e8ebf1;padding-bottom:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
.field label{font-size:12px;color:#5a6270;display:block;margin-bottom:3px}
.field input{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #ccd2dd;border-radius:6px;font-size:13px}
.field input:focus{outline:2px solid #4f7cf0;border-color:#4f7cf0}
.bar{display:flex;gap:10px;align-items:center;position:sticky;bottom:12px;background:#1f2430;padding:12px 16px;border-radius:10px}
.bar button{background:#4f7cf0;color:#fff;border:0;padding:9px 22px;border-radius:8px;font-weight:600;cursor:pointer}
.bar button:disabled{opacity:.6;cursor:wait}
.bar span{color:#cfd6e4;font-size:13px}
#toast{position:fixed;top:18px;right:18px;background:#1f2430;color:#fff;padding:10px 16px;border-radius:8px;font-size:14px;display:none;max-width:420px}
#toast.err{background:#b23b3b}.ok{border-color:#3f9d63!important}.err{border-color:#b23b3b!important}
details{margin:6px 0}summary{cursor:pointer;font-weight:600;font-size:13px;color:#3b4456}
</style></head><body>
<header class="top"><h1>🔑 AI Key 管理（直写 Cloudflare Secrets）</h1><a href="/admin">← 返回客户管理</a></header>
<div class="wrap">
<div class="notice" id="bootNotice">加载中…</div>
<div id="content"></div>
<div class="bar"><button id="saveAll">💾 保存全部修改</button><span>留空的字段不会改动；保存后秒级生效，无需重新部署。</span></div>
</div>
<div id="toast"></div>
<script>
(function(){
var toastEl=document.getElementById('toast');
function toast(msg,err){toastEl.textContent=msg;toastEl.className=err?'err':'';toastEl.style.display='block';setTimeout(function(){toastEl.style.display='none'},5000)}
function api(p,o){return fetch(p,o||{}).then(function(r){if(r.status===401){location='/admin';throw new Error('登录过期')}return r.json().then(function(d){if(!r.ok)throw new Error(d.detail||'请求失败');return d})})}
var dirty={};
function inputId(n){return 'f_'+n}
function renderBootstrapForm(msg){
  var notice=document.getElementById('bootNotice');
  notice.innerHTML='<b>尚未引导：</b>'+(msg||'')+'<br>粘贴一个仅有 <code>Workers Scripts: Edit</code> 权限的 Cloudflare API Token 与 Account ID，面板会用它写入自身凭据，此后即可在页面内管理全部 Key。';
  notice.style.display='block';
  var card=document.createElement('div');card.className='card';
  card.innerHTML='<h2>🔑 Cloudflare API Token 引导</h2>'+
    '<div class="grid">'+
    '<div class="field"><label>API Token (https://dash.cloudflare.com/profile/api-tokens)</label><input type="password" id="bootToken" autocomplete="off"></div>'+
    '<div class="field"><label>Account ID (域名概览页右侧)</label><input type="text" id="bootAccount" autocomplete="off"></div>'+
    '</div><p><button id="bootSave" style="background:#4f7cf0;color:#fff;border:0;padding:9px 22px;border-radius:8px;font-weight:600;cursor:pointer">验证并保存</button> <span id="bootMsg" style="font-size:13px;color:#5a6270"></span></p>';
  document.getElementById('content').appendChild(card);
  document.getElementById('bootSave').onclick=function(){
    var btn=this;btn.disabled=true;btn.textContent='验证中…';
    api('/admin/api/secrets/bootstrap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({api_token:document.getElementById('bootToken').value.trim(),account_id:document.getElementById('bootAccount').value.trim()})})
    .then(function(){toast('引导成功，正在加载 Key 列表…');setTimeout(function(){location.reload()},800)})
    .catch(function(e){document.getElementById('bootMsg').textContent=e.message;btn.disabled=false;btn.textContent='验证并保存'})
  };
}
api('/admin/api/secrets').then(function(data){
  document.getElementById('bootNotice').style.display='none';
  var root=document.getElementById('content');
  var groups={};
  data.definitions.forEach(function(d){(groups[d.group]=groups[d.group]||[]).push(d)});
  Object.keys(groups).forEach(function(g){
    var sec=document.createElement('div');sec.className='card group';
    var h=document.createElement('h2');h.textContent=g+'（'+groups[g].length+' 项）';sec.appendChild(h);
    var grid=document.createElement('div');grid.className='grid';
    groups[g].forEach(function(d){
      var f=document.createElement('div');f.className='field';
      var l=document.createElement('label');l.textContent=d.label+' ('+d.name+')';
      var inp=document.createElement('input');inp.type='password';inp.id=inputId(d.name);inp.name=d.name;
      inp.placeholder='未修改';inp.autocomplete='off';
      inp.addEventListener('input',function(){dirty[d.name]=inp.value;inp.classList.add('ok')});
      f.appendChild(l);f.appendChild(inp);grid.appendChild(f);
    });
    sec.appendChild(grid);root.appendChild(sec);
  });
}).catch(function(e){
  renderBootstrapForm(e.message);
});
document.getElementById('saveAll').onclick=function(){
  var btn=this;var updates=Object.keys(dirty).filter(function(k){return dirty[k]&&dirty[k].trim()}).map(function(k){return {name:k,value:dirty[k].trim()}});
  if(!updates.length){toast('没有需要保存的修改',true);return}
  btn.disabled=true;btn.textContent='保存中…';
  api('/admin/api/secrets/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({updates:updates})})
  .then(function(r){
    if(r.failed&&r.failed.length){toast('成功 '+r.applied.length+' 项；失败: '+r.failed.map(function(f){return f.name+' ('+f.error+')'}).join(', '),true)}
    else{toast('已保存并生效: '+r.applied.join(', '));Object.keys(dirty).forEach(function(k){var el=document.getElementById(inputId(k));if(el){el.value='';el.classList.remove('ok')}});dirty={}}
  })
  .catch(function(e){toast(e.message,true)})
  .finally(function(){btn.disabled=false;btn.textContent='💾 保存全部修改'})
};
})();
</script></body></html>`;
