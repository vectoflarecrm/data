// CRM sales layer (CRM/合并.txt — open-crm D1 model as the base).
//
// The research pipeline (customers/contacts) stays untouched; this module is
// the SALES view of the same D1 database:
//   - crm_companies    sales-side company (promoted leads keep "c_<id>")
//   - crm_contacts     decision makers per company
//   - crm_deals        opportunity kanban (inquiry → … → won/lost)
//   - crm_activities   unified timeline + open tasks (type='task')
//
// Everything is reachable only through the central /admin/api gate in
// handleAdminRequest (auth + requiredPermission in src/auth/rbac.ts map
// /admin/api/crm/* onto customers.read / customers.write).
//
// 合并.txt merge rules, enforced here:
//   1. a merge is ONE D1 batch (single transaction) — never partial;
//   2. the pre-merge source id is preserved (merged_from_ids + remark line);
//   3. contacts/deals/activities all migrate to the target company;
//   4. a "company_merged" activity row documents the merge in the timeline.

import {
  auditAdminAction,
  jsonResponse,
  readJsonBody,
  type AdminAuthContext,
  type AdminEnv,
} from "./admin";
import { safeLog } from "./security/safe-log";

export interface CrmCompanyRow {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  country: string | null;
  tier: string;
  lead_status: string;
  merged_from_ids: string | null;
  chinese_remarks: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrmCompanyListRow extends CrmCompanyRow {
  open_deals: number;
  open_tasks: number;
}

export interface CrmContactRow {
  id: string;
  company_id: string;
  full_name: string;
  job_title: string | null;
  email: string | null;
  whatsapp_or_phone: string | null;
  linkedin_url: string | null;
  is_primary: number;
  created_at: string;
}

export interface CrmDealRow {
  id: string;
  company_id: string;
  title: string;
  stage: string;
  amount: number | null;
  incoterms: string | null;
  expected_close_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrmActivityRow {
  id: string;
  company_id: string;
  deal_id: string | null;
  type: string;
  summary: string;
  due_date: string | null;
  is_completed: number;
  created_at: string;
}

/** Kanban stage machine (合并.txt sales flow). */
export const DEAL_STAGES = [
  "inquiry",
  "sample_quoted",
  "pi_sent",
  "deposit_paid",
  "won",
  "lost",
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

const TIERS = ["A", "B", "C", "VIP", "unqualified"] as const;
const LEAD_STATUSES = [
  "new",
  "enriched",
  "contacted",
  "qualified",
  "disqualified",
] as const;
/** Caller-facing activity types. Internal log rows (manual_note default,
 * lead_promoted, company_merged) are produced by the server itself. */
const ACTIVITY_TYPES = ["note", "task", "call", "meeting"] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/* ── Validation helpers ─────────────────────────────────────────────────── */

function reqString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} 不能为空`);
  }
  if (value.length > max) {
    throw new HttpError(400, `${field} 过长（最多 ${max} 字符）`);
  }
  return value.trim();
}

function optString(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return reqString(value, field, max);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new HttpError(400, `${field} 无效，允许值: ${allowed.join("/")}`);
  }
  return value as T;
}

function optAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "amount 必须是非负数字");
  return n;
}

function optDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const s = reqString(value, field, 32);
  if (!DATE_RE.test(s)) throw new HttpError(400, `${field} 需要 YYYY-MM-DD 格式`);
  return s;
}

function optBool(value: unknown, field: string): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return value === 1;
  throw new HttpError(400, `${field} 需要布尔值`);
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) return fallback;
  return Math.min(n, max);
}

async function requireCompany(env: AdminEnv, id: string): Promise<CrmCompanyRow> {
  const row = await env.DB.prepare("SELECT * FROM crm_companies WHERE id = ?1")
    .bind(id)
    .first<CrmCompanyRow>();
  if (!row) throw new HttpError(404, "客户公司不存在");
  return row;
}

/* ── Companies ──────────────────────────────────────────────────────────── */

async function listCompanies(url: URL, env: AdminEnv): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  const tier = url.searchParams.get("tier") ?? "";
  const leadStatus = url.searchParams.get("lead_status") ?? "";
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const where = `WHERE (?1 = '' OR name LIKE '%' || ?1 || '%' OR IFNULL(domain, '') LIKE '%' || ?1 || '%'
      OR IFNULL(chinese_remarks, '') LIKE '%' || ?1 || '%')
    AND (?2 = '' OR tier = ?2) AND (?3 = '' OR lead_status = ?3)`;

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM crm_companies ${where}`)
    .bind(q, tier, leadStatus)
    .first<{ n: number }>();
  const rows = await env.DB.prepare(
    `SELECT c.*,
       (SELECT COUNT(*) FROM crm_deals d WHERE d.company_id = c.id AND d.stage NOT IN ('won', 'lost')) AS open_deals,
       (SELECT COUNT(*) FROM crm_activities a WHERE a.company_id = c.id AND a.type = 'task' AND a.is_completed = 0) AS open_tasks
     FROM crm_companies c ${where}
     ORDER BY c.updated_at DESC LIMIT ?4 OFFSET ?5`,
  )
    .bind(q, tier, leadStatus, limit, offset)
    .all<CrmCompanyListRow>();
  return jsonResponse({ companies: rows.results, total: totalRow?.n ?? 0 });
}

async function createCompany(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
): Promise<Response> {
  const body = await readJsonBody(request);
  const name = reqString(body.name, "name", 200);
  const domain = optString(body.domain, "domain", 200);
  if (domain) {
    const clash = await env.DB.prepare("SELECT id FROM crm_companies WHERE domain = ?1")
      .bind(domain)
      .first<{ id: string }>();
    if (clash) throw new HttpError(409, `该域名已存在（公司 ${clash.id}），请改用合并`);
  }
  const id = crypto.randomUUID();
  const tier = body.tier === undefined ? "unqualified" : oneOf(body.tier, TIERS, "tier");
  const leadStatus =
    body.lead_status === undefined ? "new" : oneOf(body.lead_status, LEAD_STATUSES, "lead_status");
  await env.DB.prepare(
    `INSERT INTO crm_companies (id, name, domain, industry, country, tier, lead_status, chinese_remarks)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      id,
      name,
      domain,
      optString(body.industry, "industry", 100),
      optString(body.country, "country", 100),
      tier,
      leadStatus,
      optString(body.chinese_remarks, "chinese_remarks", 4000),
    )
    .run();
  await auditAdminAction(env, request, auth, "CREATE_CRM_COMPANY", "crm_company", id, {
    name,
  });
  const company = await requireCompany(env, id);
  return jsonResponse({ company }, 201);
}

async function getCompany(env: AdminEnv, id: string): Promise<Response> {
  const company = await requireCompany(env, id);
  const contacts = await env.DB.prepare(
    "SELECT * FROM crm_contacts WHERE company_id = ?1 ORDER BY is_primary DESC, created_at ASC",
  )
    .bind(id)
    .all<CrmContactRow>();
  const deals = await env.DB.prepare(
    "SELECT * FROM crm_deals WHERE company_id = ?1 ORDER BY updated_at DESC",
  )
    .bind(id)
    .all<CrmDealRow>();
  const activities = await env.DB.prepare(
    "SELECT * FROM crm_activities WHERE company_id = ?1 ORDER BY created_at DESC LIMIT 200",
  )
    .bind(id)
    .all<CrmActivityRow>();
  return jsonResponse({
    company,
    contacts: contacts.results,
    deals: deals.results,
    activities: activities.results,
  });
}

async function updateCompany(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
  id: string,
): Promise<Response> {
  await requireCompany(env, id);
  const body = await readJsonBody(request);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if ("name" in body) sets.push(`name = ?${sets.length + 2}`), binds.push(reqString(body.name, "name", 200));
  if ("domain" in body) {
    const domain = optString(body.domain, "domain", 200);
    if (domain) {
      const clash = await env.DB.prepare(
        "SELECT id FROM crm_companies WHERE domain = ?1 AND id != ?2",
      )
        .bind(domain, id)
        .first<{ id: string }>();
      if (clash) throw new HttpError(409, `该域名已被公司 ${clash.id} 占用，请改用合并`);
    }
    sets.push(`domain = ?${sets.length + 2}`);
    binds.push(domain);
  }
  if ("industry" in body) {
    sets.push(`industry = ?${sets.length + 2}`);
    binds.push(optString(body.industry, "industry", 100));
  }
  if ("country" in body) {
    sets.push(`country = ?${sets.length + 2}`);
    binds.push(optString(body.country, "country", 100));
  }
  if ("tier" in body) {
    sets.push(`tier = ?${sets.length + 2}`);
    binds.push(oneOf(body.tier, TIERS, "tier"));
  }
  if ("lead_status" in body) {
    sets.push(`lead_status = ?${sets.length + 2}`);
    binds.push(oneOf(body.lead_status, LEAD_STATUSES, "lead_status"));
  }
  if ("chinese_remarks" in body) {
    sets.push(`chinese_remarks = ?${sets.length + 2}`);
    binds.push(optString(body.chinese_remarks, "chinese_remarks", 8000));
  }
  if (!sets.length) throw new HttpError(400, "没有可更新字段");
  sets.push("updated_at = CURRENT_TIMESTAMP");
  await env.DB.prepare(`UPDATE crm_companies SET ${sets.join(", ")} WHERE id = ?1`)
    .bind(id, ...binds)
    .run();
  await auditAdminAction(env, request, auth, "UPDATE_CRM_COMPANY", "crm_company", id, null);
  const company = await requireCompany(env, id);
  return jsonResponse({ company });
}

async function deleteCompany(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
  id: string,
): Promise<Response> {
  const company = await requireCompany(env, id);
  await env.DB.prepare("DELETE FROM crm_companies WHERE id = ?1").bind(id).run();
  await auditAdminAction(env, request, auth, "DELETE_CRM_COMPANY", "crm_company", id, {
    name: company.name,
  });
  return jsonResponse({ ok: true });
}

/* ── Lead → Company promotion（一条 SQL，无同步步骤） ───────────────────── */

interface PromoteCustomerRow {
  id: number;
  company_id: string;
  company_name: string | null;
  domain: string | null;
  industry: string | null;
  country: string | null;
  lead_score: number | null;
  email: string | null;
}

function tierFromScore(score: number | null): string {
  if (score === null) return "unqualified";
  if (score >= 80) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  return "unqualified";
}

async function promoteLead(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
): Promise<Response> {
  const body = await readJsonBody(request);
  const customerId = Number(body.customer_id);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    throw new HttpError(400, "customer_id 需要正整数");
  }
  const cust = await env.DB.prepare(
    "SELECT id, company_id, company_name, domain, industry, country, lead_score, email FROM customers WHERE id = ?1",
  )
    .bind(customerId)
    .first<PromoteCustomerRow>();
  if (!cust) throw new HttpError(404, `管线线索不存在（customers#${customerId}）`);

  const crmId = `c_${cust.id}`;
  const existing = await env.DB.prepare("SELECT * FROM crm_companies WHERE id = ?1")
    .bind(crmId)
    .first<CrmCompanyRow>();
  if (existing) return jsonResponse({ company: existing, already_promoted: true });

  // A manually created company may already own this domain — better a clear
  // 409 than an accidental duplicate (the operator should merge instead).
  if (cust.domain) {
    const clash = await env.DB.prepare("SELECT id FROM crm_companies WHERE domain = ?1")
      .bind(cust.domain)
      .first<{ id: string }>();
    if (clash) {
      throw new HttpError(409, `域名 ${cust.domain} 已存在（公司 ${clash.id}），请改用合并`);
    }
  }

  const tier = tierFromScore(cust.lead_score);
  await env.DB.prepare(
    `INSERT INTO crm_companies (id, name, domain, industry, country, tier, lead_status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'enriched')`,
  )
    .bind(
      crmId,
      (cust.company_name ?? cust.company_id ?? `客户#${cust.id}`).trim(),
      cust.domain,
      cust.industry,
      cust.country,
      tier,
    )
    .run();

  // Contacts: copy every named/reachable pipeline contact (seq=1 is primary).
  // full_name is NOT NULL — fall back through first/last name to a seq label.
  await env.DB.prepare(
    `INSERT INTO crm_contacts (id, company_id, full_name, job_title, email, whatsapp_or_phone, linkedin_url, is_primary)
     SELECT 'ct_' || ct.id, ?1,
       COALESCE(NULLIF(TRIM(COALESCE(NULLIF(ct.full_name, ''), TRIM(COALESCE(ct.first_name, '') || ' ' || COALESCE(ct.last_name, '')))), ''), '联系人-' || ct.seq),
       ct.title, ct.email,
       COALESCE(NULLIF(ct.whatsapp, ''), NULLIF(ct.cellphone, ''), NULLIF(ct.tel, '')),
       ct.linkedin_url,
       CASE WHEN ct.seq = 1 THEN 1 ELSE 0 END
     FROM contacts ct
     WHERE ct.company_id = ?2
       AND (ct.email IS NOT NULL OR ct.full_name IS NOT NULL OR ct.first_name IS NOT NULL OR ct.last_name IS NOT NULL)`,
  )
    .bind(crmId, cust.company_id)
    .run();

  // Fallback: no pipeline contacts but the customer row has an import-time
  // email — keep at least one reachable channel on the company.
  const copied = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM crm_contacts WHERE company_id = ?1",
  )
    .bind(crmId)
    .first<{ n: number }>();
  if ((copied?.n ?? 0) === 0 && cust.email) {
    await env.DB.prepare(
      `INSERT INTO crm_contacts (id, company_id, full_name, email, is_primary)
       VALUES (?1, ?2, ?3, ?4, 1)`,
    )
      .bind(`${crmId}-e`, crmId, cust.email.split("@")[0] || cust.email, cust.email)
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO crm_activities (id, company_id, type, summary)
     VALUES (?1, ?2, 'lead_promoted', ?3)`,
  )
    .bind(
      crypto.randomUUID(),
      crmId,
      `从研究管线提升为客户公司（customers#${cust.id}，lead_score=${cust.lead_score ?? "无"}，分级 ${tier}）`,
    )
    .run();

  await auditAdminAction(env, request, auth, "PROMOTE_LEAD", "crm_company", crmId, {
    customer_id: cust.id,
  });
  const company = await requireCompany(env, crmId);
  return jsonResponse({ company, already_promoted: false }, 201);
}

/* ── Company merge（合并.txt: 单事务 + 溯源） ───────────────────────────── */

async function mergeCompanies(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
): Promise<Response> {
  const body = await readJsonBody(request);
  const targetId = reqString(body.target_company_id, "target_company_id", 64);
  const sourceId = reqString(body.source_company_id, "source_company_id", 64);
  if (targetId === sourceId) throw new HttpError(400, "目标与来源不能是同一家公司");

  const target = await requireCompany(env, targetId);
  const source = await requireCompany(env, sourceId);

  // Inherit the source domain only when the target has none AND no third
  // company holds it (UNIQUE would abort the whole batch otherwise).
  const inheritDomain =
    source.domain !== null &&
    target.domain === null &&
    !(await env.DB.prepare(
      "SELECT id FROM crm_companies WHERE domain = ?1 AND id != ?2",
    )
      .bind(source.domain, source.id)
      .first<{ id: string }>());

  const remarkLine = `[合并] ${new Date().toISOString().slice(0, 10)} 并入重复公司 ${source.name}（ID: ${source.id}）`;
  const newRemarks = `${target.chinese_remarks ? target.chinese_remarks + "\n" : ""}${remarkLine}`;
  const newMerged = `${target.merged_from_ids ? target.merged_from_ids + "," : ""}${source.id}`;

  // ONE D1 batch = one transaction: the merge either fully happens or not at
  // all (合并.txt rule). Order matters — children migrate before the source
  // delete; the FK cascade is the backstop, not the mechanism.
  const statements = [
    env.DB.prepare("UPDATE crm_contacts SET company_id = ?1 WHERE company_id = ?2")
      .bind(targetId, sourceId),
    env.DB.prepare(
      "UPDATE crm_deals SET company_id = ?1, updated_at = CURRENT_TIMESTAMP WHERE company_id = ?2",
    ).bind(targetId, sourceId),
    env.DB.prepare("UPDATE crm_activities SET company_id = ?1 WHERE company_id = ?2").bind(
      targetId,
      sourceId,
    ),
    env.DB.prepare(
      `UPDATE crm_companies
       SET chinese_remarks = ?1, merged_from_ids = ?2, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?3`,
    ).bind(newRemarks, newMerged, targetId),
    env.DB.prepare(
      `INSERT INTO crm_activities (id, company_id, type, summary)
       VALUES (?1, ?2, 'company_merged', ?3)`,
    ).bind(
      crypto.randomUUID(),
      targetId,
      `合并重复公司 ${source.name}（ID: ${source.id}），联系人/商机/动态已全部并入`,
    ),
    env.DB.prepare("DELETE FROM crm_companies WHERE id = ?1").bind(sourceId),
  ];
  if (inheritDomain) {
    statements.unshift(
      env.DB.prepare("UPDATE crm_companies SET domain = ?1 WHERE id = ?2").bind(
        source.domain,
        targetId,
      ),
    );
  }
  await env.DB.batch(statements);

  await auditAdminAction(env, request, auth, "MERGE_CRM_COMPANY", "crm_company", targetId, {
    target_company_id: targetId,
    source_company_id: sourceId,
  });
  const company = await requireCompany(env, targetId);
  return jsonResponse({ company });
}

/* ── Contacts ───────────────────────────────────────────────────────────── */

async function createContact(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
): Promise<Response> {
  const body = await readJsonBody(request);
  const companyId = reqString(body.company_id, "company_id", 64);
  await requireCompany(env, companyId);
  const isPrimary = optBool(body.is_primary, "is_primary") ?? false;
  if (isPrimary) {
    await env.DB.prepare("UPDATE crm_contacts SET is_primary = 0 WHERE company_id = ?1")
      .bind(companyId)
      .run();
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO crm_contacts (id, company_id, full_name, job_title, email, whatsapp_or_phone, linkedin_url, is_primary)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      id,
      companyId,
      reqString(body.full_name, "full_name", 200),
      optString(body.job_title, "job_title", 100),
      optString(body.email, "email", 200),
      optString(body.whatsapp_or_phone, "whatsapp_or_phone", 100),
      optString(body.linkedin_url, "linkedin_url", 300),
      isPrimary ? 1 : 0,
    )
    .run();
  await auditAdminAction(env, request, auth, "CREATE_CRM_CONTACT", "crm_contact", id, {
    company_id: companyId,
  });
  const contact = await env.DB.prepare("SELECT * FROM crm_contacts WHERE id = ?1")
    .bind(id)
    .first<CrmContactRow>();
  return jsonResponse({ contact }, 201);
}

async function updateContact(request: Request, env: AdminEnv, id: string): Promise<Response> {
  const existing = await env.DB.prepare("SELECT * FROM crm_contacts WHERE id = ?1")
    .bind(id)
    .first<CrmContactRow>();
  if (!existing) throw new HttpError(404, "联系人不存在");
  const body = await readJsonBody(request);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if ("full_name" in body) {
    sets.push(`full_name = ?${sets.length + 2}`);
    binds.push(reqString(body.full_name, "full_name", 200));
  }
  if ("job_title" in body) {
    sets.push(`job_title = ?${sets.length + 2}`);
    binds.push(optString(body.job_title, "job_title", 100));
  }
  if ("email" in body) {
    sets.push(`email = ?${sets.length + 2}`);
    binds.push(optString(body.email, "email", 200));
  }
  if ("whatsapp_or_phone" in body) {
    sets.push(`whatsapp_or_phone = ?${sets.length + 2}`);
    binds.push(optString(body.whatsapp_or_phone, "whatsapp_or_phone", 100));
  }
  if ("linkedin_url" in body) {
    sets.push(`linkedin_url = ?${sets.length + 2}`);
    binds.push(optString(body.linkedin_url, "linkedin_url", 300));
  }
  const isPrimary = optBool(body.is_primary, "is_primary");
  if (isPrimary === true) {
    await env.DB.prepare("UPDATE crm_contacts SET is_primary = 0 WHERE company_id = ?1")
      .bind(existing.company_id)
      .run();
    sets.push("is_primary = 1");
  } else if (isPrimary === false) {
    sets.push("is_primary = 0");
  }
  if (!sets.length) throw new HttpError(400, "没有可更新字段");
  await env.DB.prepare(`UPDATE crm_contacts SET ${sets.join(", ")} WHERE id = ?1`)
    .bind(id, ...binds)
    .run();
  const contact = await env.DB.prepare("SELECT * FROM crm_contacts WHERE id = ?1")
    .bind(id)
    .first<CrmContactRow>();
  return jsonResponse({ contact });
}

async function deleteContact(env: AdminEnv, id: string): Promise<Response> {
  const existing = await env.DB.prepare("SELECT id FROM crm_contacts WHERE id = ?1")
    .bind(id)
    .first<{ id: string }>();
  if (!existing) throw new HttpError(404, "联系人不存在");
  await env.DB.prepare("DELETE FROM crm_contacts WHERE id = ?1").bind(id).run();
  return jsonResponse({ ok: true });
}

/* ── Deals ──────────────────────────────────────────────────────────────── */

async function listDeals(env: AdminEnv): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT d.*, c.name AS company_name
     FROM crm_deals d JOIN crm_companies c ON c.id = d.company_id
     ORDER BY d.updated_at DESC LIMIT 500`,
  ).all<CrmDealRow & { company_name: string }>();
  return jsonResponse({ deals: rows.results });
}

async function createDeal(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
): Promise<Response> {
  const body = await readJsonBody(request);
  const companyId = reqString(body.company_id, "company_id", 64);
  await requireCompany(env, companyId);
  const stage = body.stage === undefined ? "inquiry" : oneOf(body.stage, DEAL_STAGES, "stage");
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO crm_deals (id, company_id, title, stage, amount, incoterms, expected_close_date)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      id,
      companyId,
      reqString(body.title, "title", 200),
      stage,
      optAmount(body.amount),
      optString(body.incoterms, "incoterms", 50),
      optDate(body.expected_close_date, "expected_close_date"),
    )
    .run();
  await auditAdminAction(env, request, auth, "CREATE_CRM_DEAL", "crm_deal", id, {
    company_id: companyId,
  });
  const deal = await env.DB.prepare("SELECT * FROM crm_deals WHERE id = ?1")
    .bind(id)
    .first<CrmDealRow>();
  return jsonResponse({ deal }, 201);
}

async function updateDeal(request: Request, env: AdminEnv, id: string): Promise<Response> {
  const existing = await env.DB.prepare("SELECT * FROM crm_deals WHERE id = ?1")
    .bind(id)
    .first<CrmDealRow>();
  if (!existing) throw new HttpError(404, "商机不存在");
  const body = await readJsonBody(request);

  let stageChangedTo: string | null = null;
  const sets: string[] = [];
  const binds: unknown[] = [];
  if ("title" in body) {
    sets.push(`title = ?${sets.length + 2}`);
    binds.push(reqString(body.title, "title", 200));
  }
  if ("stage" in body) {
    const stage = oneOf(body.stage, DEAL_STAGES, "stage");
    if (stage !== existing.stage) stageChangedTo = stage;
    sets.push(`stage = ?${sets.length + 2}`);
    binds.push(stage);
  }
  if ("amount" in body) {
    sets.push(`amount = ?${sets.length + 2}`);
    binds.push(optAmount(body.amount));
  }
  if ("incoterms" in body) {
    sets.push(`incoterms = ?${sets.length + 2}`);
    binds.push(optString(body.incoterms, "incoterms", 50));
  }
  if ("expected_close_date" in body) {
    sets.push(`expected_close_date = ?${sets.length + 2}`);
    binds.push(optDate(body.expected_close_date, "expected_close_date"));
  }
  if (!sets.length) throw new HttpError(400, "没有可更新字段");
  sets.push("updated_at = CURRENT_TIMESTAMP");
  await env.DB.prepare(`UPDATE crm_deals SET ${sets.join(", ")} WHERE id = ?1`)
    .bind(id, ...binds)
    .run();

  // Stage moves are timeline events — the panel timeline and the audit trail
  // should tell the same story.
  if (stageChangedTo) {
    await env.DB.prepare(
      `INSERT INTO crm_activities (id, company_id, deal_id, type, summary)
       VALUES (?1, ?2, ?3, 'note', ?4)`,
    )
      .bind(
        crypto.randomUUID(),
        existing.company_id,
        id,
        `商机「${existing.title}」阶段推进: ${existing.stage} → ${stageChangedTo}`,
      )
      .run();
  }
  const deal = await env.DB.prepare("SELECT * FROM crm_deals WHERE id = ?1")
    .bind(id)
    .first<CrmDealRow>();
  return jsonResponse({ deal });
}

async function deleteDeal(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
  id: string,
): Promise<Response> {
  const existing = await env.DB.prepare("SELECT * FROM crm_deals WHERE id = ?1")
    .bind(id)
    .first<CrmDealRow>();
  if (!existing) throw new HttpError(404, "商机不存在");
  await env.DB.prepare("DELETE FROM crm_deals WHERE id = ?1").bind(id).run();
  await auditAdminAction(env, request, auth, "DELETE_CRM_DEAL", "crm_deal", id, {
    company_id: existing.company_id,
    title: existing.title,
  });
  return jsonResponse({ ok: true });
}

/* ── Activities (timeline + tasks) ──────────────────────────────────────── */

async function listOpenTasks(env: AdminEnv, url: URL): Promise<Response> {
  const companyId = (url.searchParams.get("company_id") ?? "").trim();
  const rows = await env.DB.prepare(
    `SELECT a.*, c.name AS company_name
     FROM crm_activities a JOIN crm_companies c ON c.id = a.company_id
     WHERE a.type = 'task' AND a.is_completed = 0 AND (?1 = '' OR a.company_id = ?1)
     ORDER BY COALESCE(a.due_date, a.created_at) ASC LIMIT 200`,
  )
    .bind(companyId)
    .all<CrmActivityRow & { company_name: string }>();
  return jsonResponse({ activities: rows.results });
}

async function createActivity(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
): Promise<Response> {
  const body = await readJsonBody(request);
  const companyId = reqString(body.company_id, "company_id", 64);
  await requireCompany(env, companyId);
  const type = oneOf(body.type, ACTIVITY_TYPES, "type");
  const dealId = optString(body.deal_id, "deal_id", 64);
  const summary = reqString(body.summary, "summary", 1000);
  const dueDate = optDate(body.due_date, "due_date");
  if (type !== "task" && dueDate) {
    throw new HttpError(400, "due_date 只能用于 type='task'");
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO crm_activities (id, company_id, deal_id, type, summary, due_date)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(
      id,
      companyId,
      dealId,
      // 'note' is the caller-facing name of the internal 'manual_note' log row.
      type === "note" ? "manual_note" : type,
      summary,
      dueDate,
    )
    .run();
  await auditAdminAction(env, request, auth, "CREATE_CRM_ACTIVITY", "crm_activity", id, {
    company_id: companyId,
    type,
  });
  const activity = await env.DB.prepare("SELECT * FROM crm_activities WHERE id = ?1")
    .bind(id)
    .first<CrmActivityRow>();
  return jsonResponse({ activity }, 201);
}

async function updateActivity(request: Request, env: AdminEnv, id: string): Promise<Response> {
  const existing = await env.DB.prepare("SELECT * FROM crm_activities WHERE id = ?1")
    .bind(id)
    .first<CrmActivityRow>();
  if (!existing) throw new HttpError(404, "动态不存在");
  const body = await readJsonBody(request);
  const isCompleted = optBool(body.is_completed, "is_completed");
  if (isCompleted === null) throw new HttpError(400, "没有可更新字段");
  await env.DB.prepare("UPDATE crm_activities SET is_completed = ?1 WHERE id = ?2")
    .bind(isCompleted ? 1 : 0, id)
    .run();
  const activity = await env.DB.prepare("SELECT * FROM crm_activities WHERE id = ?1")
    .bind(id)
    .first<CrmActivityRow>();
  return jsonResponse({ activity });
}

async function deleteActivity(env: AdminEnv, id: string): Promise<Response> {
  const existing = await env.DB.prepare("SELECT id FROM crm_activities WHERE id = ?1")
    .bind(id)
    .first<{ id: string }>();
  if (!existing) throw new HttpError(404, "动态不存在");
  await env.DB.prepare("DELETE FROM crm_activities WHERE id = ?1").bind(id).run();
  return jsonResponse({ ok: true });
}

/* ── Router ─────────────────────────────────────────────────────────────── */

export async function handleCrmApi(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // admin/api/crm/<res>[/<id>]
    const resource = parts[3] ?? "";
    const id = parts[4] ?? "";
    const method = request.method;

    if (resource === "companies") {
      if (!id && method === "GET") return await listCompanies(url, env);
      if (!id && method === "POST") return await createCompany(request, env, auth);
      if (id === "promote" && method === "POST") return await promoteLead(request, env, auth);
      if (id === "merge" && method === "POST") return await mergeCompanies(request, env, auth);
      if (id && method === "GET") return await getCompany(env, id);
      if (id && method === "PATCH") return await updateCompany(request, env, auth, id);
      if (id && method === "DELETE") return await deleteCompany(request, env, auth, id);
    } else if (resource === "contacts") {
      if (!id && method === "POST") return await createContact(request, env, auth);
      if (id && method === "PATCH") return await updateContact(request, env, id);
      if (id && method === "DELETE") return await deleteContact(env, id);
    } else if (resource === "deals") {
      if (!id && method === "GET") return await listDeals(env);
      if (!id && method === "POST") return await createDeal(request, env, auth);
      if (id && method === "PATCH") return await updateDeal(request, env, id);
      if (id && method === "DELETE") return await deleteDeal(request, env, auth, id);
    } else if (resource === "activities") {
      if (!id && method === "GET") return await listOpenTasks(env, url);
      if (!id && method === "POST") return await createActivity(request, env, auth);
      if (id && method === "PATCH") return await updateActivity(request, env, id);
      if (id && method === "DELETE") return await deleteActivity(env, id);
    }
    return jsonResponse({ detail: "Not Found" }, 404);
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonResponse({ detail: error.message }, error.status);
    }
    safeLog("error", "[crm:handleCrmApi] unexpected error", error);
    return jsonResponse({ detail: "服务器内部错误，请查看 Worker 日志" }, 500);
  }
}
