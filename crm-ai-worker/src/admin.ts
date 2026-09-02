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

export interface AdminEnv extends GmailEnv {
  DB: D1Database;
  ADMIN_PANEL_TOKEN?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GROQ_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
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
      const updates: { company_intro?: string; enabled?: boolean } = {};
      if (typeof body.company_intro === "string") updates.company_intro = body.company_intro;
      if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
      await updateBrandSetting(env, brandName, updates);
      return jsonResponse({ ok: true });
    }

    // POST /admin/api/outreach/generate - Generate outreach emails
    if (path === "/admin/api/outreach/generate" && request.method === "POST") {
      const body = (await request.json()) as { brand?: string; limit?: number };
      if (!body.brand) return jsonResponse({ detail: "brand is required" }, 400);
      const result = await generateOutreachEmails(env, body.brand, body.limit || 10);
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
        `SELECT id, email_to, subject, body FROM outreach_emails ${clause} ORDER BY id LIMIT ?`,
      ).bind(...params, limit).all<{ id: number; email_to: string; subject: string | null; body: string | null }>();

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
          const r = await sendOutreachEmail(env, draft);
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
        "SELECT id, email_to, subject, body, status FROM outreach_emails WHERE id = ?",
      ).bind(id).first<{ id: number; email_to: string; subject: string | null; body: string | null; status: string }>();
      if (!row) return jsonResponse({ detail: "Email not found" }, 404);
      if (row.status !== "draft") return jsonResponse({ detail: "只有草稿可以发送" }, 400);
      const result = await sendOutreachEmail(env, row);
      const quota = await getQuota(env);
      return jsonResponse({ ok: result.ok, error: result.error, gmail_message_id: result.gmail_message_id, quota });
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
</style></head><body><header class="top"><h1>D1 CRM 客户管理面板</h1><div style="display:flex;gap:12px;align-items:center"><a href="/admin/outreach" style="color:#fff;text-decoration:none;background:rgba(255,255,255,.15);padding:8px 16px;border-radius:8px;font-weight:600">📧 开发信管理</a><form method="post" action="/admin/logout"><button class="button secondary" type="submit">退出登录</button></form></div></header><main class="wrap">
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
function loadBrands(){api('/admin/api/outreach/settings').then(function(d){var h='';d.settings.forEach(function(b){h+='<div class="brand-card"><div class="brand-header"><div><span class="brand-name">'+esc(b.brand_name)+'</span> <span class="brand-category">'+esc(b.product_category)+'</span></div><label class="toggle"><input type="checkbox" '+(b.enabled?'checked':'')+' data-brand="'+esc(b.brand_name)+'" class="enable-toggle"><span class="slider"></span></label></div><label style="font-weight:600;font-size:13px;color:#475569">公司简介</label><textarea class="intro-textarea" data-brand="'+esc(b.brand_name)+'">'+esc(b.company_intro)+'</textarea><div style="margin-top:10px;text-align:right"><button class="btn btn-primary btn-sm save-intro" data-brand="'+esc(b.brand_name)+'">💾 保存简介</button></div></div>'});document.getElementById('brandsArea').innerHTML=h||'<p>暂无品牌配置</p>';document.querySelectorAll('.enable-toggle').forEach(function(el){el.onchange=function(){var brand=el.dataset.brand;var enabled=el.checked;api('/admin/api/outreach/settings/'+encodeURIComponent(brand),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:enabled})}).then(function(){showToast(brand+(enabled?' 已启用':' 已禁用'),true)}).catch(function(e){showToast(e.message,false);el.checked=!enabled)}});document.querySelectorAll('.save-intro').forEach(function(el){el.onclick=function(){var brand=el.dataset.brand;var ta=document.querySelector('.intro-textarea[data-brand="'+brand+'"]');api('/admin/api/outreach/settings/'+encodeURIComponent(brand),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({company_intro:ta.value})}).then(function(){showToast(brand+' 简介已保存',true)}).catch(function(e){showToast(e.message,false)}}})}).catch(function(e){document.getElementById('brandsArea').innerHTML='<p style="color:red">'+esc(e.message)+'</p>'})}

// Generate
api('/admin/api/outreach/settings').then(function(d){var sel=document.getElementById('genBrand');sel.innerHTML='';d.settings.forEach(function(b){if(b.enabled){var opt=document.createElement('option');opt.value=b.brand_name;opt.textContent=b.brand_name+' ('+b.product_category+')';sel.appendChild(opt)}});if(!sel.options.length){sel.innerHTML='<option value="">-- 请先启用品牌 --</option>'}});
document.getElementById('genBtn').onclick=function(){var brand=document.getElementById('genBrand').value;var limit=Number(document.getElementById('genLimit').value);if(!brand){showToast('请选择品牌',false);return}var btn=document.getElementById('genBtn');btn.disabled=true;btn.textContent='⏳ 生成中...';showMsg('genMsg','正在为 '+brand+' 生成开发信，请稍候...',false);
api('/admin/api/outreach/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({brand:brand,limit:limit})}).then(function(r){showMsg('genMsg','✅ 成功生成 '+r.generated+' 封开发信'+(r.errors.length?'，'+r.errors.length+' 条失败':''),true);showToast('生成完成: '+r.generated+'封',true)}).catch(function(e){showMsg('genMsg','❌ '+e.message,false);showToast(e.message,false)}).finally(function(){btn.disabled=false;btn.textContent='🚀 开始生成'})};
function showMsg(id,t,g){var e=document.getElementById(id);if(!e)return;e.textContent=t;e.className='notice '+(g?'success':'error');e.style.display='block'}

// Email list
var emailState={offset:0,limit:20,total:0};
function loadStats(){api('/admin/api/outreach/stats').then(function(s){var h='<div class="stat-card"><div class="stat-value">'+s.total+'</div><div class="stat-label">总计</div></div><div class="stat-card"><div class="stat-value">'+s.draft+'</div><div class="stat-label">草稿</div></div><div class="stat-card"><div class="stat-value">'+s.sent+'</div><div class="stat-label">已发送</div></div>';s.by_brand.forEach(function(b){h+='<div class="stat-card"><div class="stat-value">'+b.count+'</div><div class="stat-label">'+esc(b.brand_name)+'</div></div>'});document.getElementById('statsArea').innerHTML=h}).catch(function(){})}
function loadEmails(){var brand=document.getElementById('filterBrand').value;var status=document.getElementById('filterStatus').value;var p=new URLSearchParams({limit:String(emailState.limit),offset:String(emailState.offset)});if(brand)p.set('brand',brand);if(status)p.set('status',status);
api('/admin/api/outreach/emails?'+p.toString()).then(function(d){emailState.total=d.total;var h='';d.items.forEach(function(e){h+='<div class="email-card"><div class="email-header"><span class="email-subject">'+esc(e.subject||'(无主题)')+'</span><div><span class="badge badge-'+esc(e.status)+'">'+(e.status==='sent'?'已发送':'草稿')+'</span> <button class="btn btn-sm btn-danger del-email" data-id="'+e.id+'">删除</button>'+(e.status==='draft'?' <button class="btn btn-sm btn-primary send-one" data-id="'+e.id+'">📧 发送</button>':'')+'</div></div><div class="email-meta">'+esc(e.brand_name||'')+' → '+esc(e.company_name||'')+' ('+esc(e.display_id||'')+') | 收件人: '+esc(e.email_to||'未知')+' | '+esc(e.created_at||'')+'</div><div class="email-body">'+esc(e.body||'')+'</div></div>'});if(!d.items.length)h='<p style="color:#6b7280;text-align:center;padding:20px">暂无开发信</p>';
emailState.total=d.total;document.getElementById('emailsArea').innerHTML=h;document.getElementById('emailPageInfo').textContent=(d.total?emailState.offset+1:0)+'-'+Math.min(emailState.offset+emailState.limit,d.total)+' / '+d.total;
document.getElementById('emailPrev').disabled=emailState.offset===0;document.getElementById('emailNext').disabled=emailState.offset+emailState.limit>=d.total;
document.querySelectorAll('.del-email').forEach(function(b){b.onclick=function(){if(!confirm('确定删除？'))return;api('/admin/api/outreach/emails/'+b.dataset.id,{method:'DELETE'}).then(function(){showToast('已删除',true);loadEmails();loadStats()}).catch(function(e){showToast(e.message,false)}}});
document.querySelectorAll('.send-one').forEach(function(b){b.onclick=function(){
if(b.disabled)return;b.disabled=true;b.textContent='⏳…';
api('/admin/api/outreach/emails/'+b.dataset.id+'/send',{method:'POST'}).then(function(d){
if(d.ok){showToast('已通过 Gmail 发送（今日 '+d.quota.sent_today+'/'+d.quota.daily_limit+'）',true)}
else{showToast('发送失败：'+(d.error||'未知错误'),false)}
loadQuota();loadStats();loadEmails()}).catch(function(e){showToast(e.message,false);b.disabled=false;b.textContent='📧 发送'}}})}).catch(function(e){document.getElementById('emailsArea').innerHTML='<p style="color:red">'+esc(e.message)+'</p>'})}

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
if(fails.length){console.log('发送失败明细',fails);alert('前3条失败原因：\n'+fails.slice(0,3).map(function(f){return '#'+f.id+': '+f.error}).join('\n'))}
}).catch(function(e){showToast(e.message,false)}).finally(function(){sending=false;btn.textContent='📤 批量发送草稿';loadQuota();loadEmails();loadStats()})};
document.getElementById('filterBrand').onchange=function(){emailState.offset=0;loadEmails()};
document.getElementById('filterStatus').onchange=function(){emailState.offset=0;loadEmails()};
document.getElementById('emailPrev').onclick=function(){if(emailState.offset>0){emailState.offset=Math.max(0,emailState.offset-emailState.limit);loadEmails()}};
document.getElementById('emailNext').onclick=function(){if(emailState.offset+emailState.limit<emailState.total){emailState.offset+=emailState.limit;loadEmails()}};

// Init
loadBrands();
})();
</script></body></html>`;
