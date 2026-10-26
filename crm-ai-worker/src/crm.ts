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
  /** Set the day the first deal was won — the company is a paying customer. */
  customer_since: string | null;
  /** 触达质量闭环：公司级禁止联系（含域名级发送前拦截）。 */
  do_not_contact: number;
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
  /** 触达质量闭环：unknown/valid/invalid（退信自动标 invalid）。 */
  email_status: string;
  email_verified_at: string | null;
  /** 客户退订的时间；写入后发送前统一检查将拦截。 */
  unsubscribed_at: string | null;
  /** 手动或退订自动标记的禁止联系开关。 */
  do_not_contact: number;
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
  /** Structured loss reason — only meaningful while stage === 'lost'. */
  lost_reason: string | null;
  /** Day the deal entered the 'won' stage (YYYY-MM-DD, powers the chart). */
  won_at: string | null;
  /** Fractional kanban order within a stage (drag & drop). */
  position: number | null;
  /** Set when the deal left the kanban without being deleted. */
  archived_at: string | null;
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
/** 触达质量闭环：邮箱状态机（退信自动标 invalid，发送前拦截）。 */
const EMAIL_STATUSES = ["unknown", "valid", "invalid"] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC today as YYYY-MM-DD — the one date format the CRM layer accepts. */
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

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
  if ("do_not_contact" in body) {
    const dnc = optBool(body.do_not_contact, "do_not_contact");
    if (dnc === null) throw new HttpError(400, "do_not_contact 需要布尔值");
    sets.push(`do_not_contact = ?${sets.length + 2}`);
    binds.push(dnc ? 1 : 0);
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

/* ── Contact merge（重复联系人去重，Atomic CRM 风格） ───────────────────── */

async function mergeContacts(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
): Promise<Response> {
  const body = await readJsonBody(request);
  const targetId = reqString(body.target_contact_id, "target_contact_id", 64);
  const sourceId = reqString(body.source_contact_id, "source_contact_id", 64);
  if (targetId === sourceId) throw new HttpError(400, "目标与来源不能是同一个联系人");

  const target = await env.DB.prepare("SELECT * FROM crm_contacts WHERE id = ?1")
    .bind(targetId)
    .first<CrmContactRow>();
  if (!target) throw new HttpError(404, "目标联系人不存在");
  const source = await env.DB.prepare("SELECT * FROM crm_contacts WHERE id = ?1")
    .bind(sourceId)
    .first<CrmContactRow>();
  if (!source) throw new HttpError(404, "来源联系人不存在");

  const crossCompany = source.company_id !== target.company_id;
  const summary = `合并重复联系人: 「${source.full_name}」并入「${target.full_name}」${crossCompany ? `（原属公司 ${source.company_id}）` : ""}`;

  // ONE D1 batch (合并.txt): the target only takes what it is missing —
  // its own non-null fields always win (COALESCE), is_primary escalates but
  // never demotes (MAX) — then the timeline row and the source delete.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE crm_contacts SET
         job_title = COALESCE(job_title, ?2),
         email = COALESCE(email, ?3),
         whatsapp_or_phone = COALESCE(whatsapp_or_phone, ?4),
         linkedin_url = COALESCE(linkedin_url, ?5),
         is_primary = MAX(is_primary, ?6)
       WHERE id = ?1`,
    ).bind(
      targetId,
      source.job_title,
      source.email,
      source.whatsapp_or_phone,
      source.linkedin_url,
      source.is_primary,
    ),
    env.DB.prepare(
      `INSERT INTO crm_activities (id, company_id, type, summary)
       VALUES (?1, ?2, 'note', ?3)`,
    ).bind(crypto.randomUUID(), target.company_id, summary),
    env.DB.prepare("DELETE FROM crm_contacts WHERE id = ?1").bind(sourceId),
  ]);

  await auditAdminAction(env, request, auth, "MERGE_CRM_CONTACT", "crm_contact", targetId, {
    target_contact_id: targetId,
    source_contact_id: sourceId,
    cross_company: crossCompany,
  });
  const contact = await env.DB.prepare("SELECT * FROM crm_contacts WHERE id = ?1")
    .bind(targetId)
    .first<CrmContactRow>();
  return jsonResponse({ contact });
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
  if ("do_not_contact" in body) {
    const dnc = optBool(body.do_not_contact, "do_not_contact");
    if (dnc === null) throw new HttpError(400, "do_not_contact 需要布尔值");
    if (dnc) {
      sets.push("do_not_contact = 1");
    } else {
      // 管理员明确解除禁联 = 同时清除退订状态（否则发送前检查仍会拦截）。
      sets.push("do_not_contact = 0", "unsubscribed_at = NULL");
    }
  }
  if ("email_status" in body) {
    const status = oneOf(body.email_status, EMAIL_STATUSES, "email_status");
    sets.push(`email_status = ?${sets.length + 2}`);
    binds.push(status);
    sets.push(`email_verified_at = ?${sets.length + 2}`);
    binds.push(status === "unknown" ? null : new Date().toISOString());
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

async function listDeals(env: AdminEnv, url: URL): Promise<Response> {
  const archived = url.searchParams.get("archived") === "1";
  const where = archived ? "d.archived_at IS NOT NULL" : "d.archived_at IS NULL";
  const rows = await env.DB.prepare(
    `SELECT d.*, c.name AS company_name
     FROM crm_deals d JOIN crm_companies c ON c.id = d.company_id
     WHERE ${where}
     ORDER BY d.position ASC, d.created_at ASC LIMIT 500`,
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
  const lostReason = optString(body.lost_reason, "lost_reason", 200);
  if (lostReason && stage !== "lost") {
    throw new HttpError(400, "只有输单商机才能填写输单原因");
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO crm_deals (id, company_id, title, stage, amount, incoterms, expected_close_date, lost_reason, won_at, position)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
       (SELECT IFNULL(MAX(d.position), 0) + 1 FROM crm_deals d WHERE d.stage = ?4))`,
  )
    .bind(
      id,
      companyId,
      reqString(body.title, "title", 200),
      stage,
      optAmount(body.amount),
      optString(body.incoterms, "incoterms", 50),
      optDate(body.expected_close_date, "expected_close_date"),
      lostReason,
      stage === "won" ? todayStr() : null,
    )
    .run();
  // A deal born in a terminal stage is already an outcome — record it the
  // same way a stage move would (timeline + customer flip on won).
  if (stage === "won") {
    await markCompanyCustomer(env, companyId);
    await env.DB.prepare(
      `INSERT INTO crm_activities (id, company_id, deal_id, type, summary)
       VALUES (?1, ?2, ?3, 'note', ?4)`,
    )
      .bind(crypto.randomUUID(), companyId, id, "商机直接以赢单创建 🎉，公司转正式客户")
      .run();
  } else if (stage === "lost") {
    await env.DB.prepare(
      `INSERT INTO crm_activities (id, company_id, deal_id, type, summary)
       VALUES (?1, ?2, ?3, 'note', ?4)`,
    )
      .bind(
        crypto.randomUUID(),
        companyId,
        id,
        `商机以输单创建${lostReason ? `（原因: ${lostReason}）` : ""}`,
      )
      .run();
  }
  await auditAdminAction(env, request, auth, "CREATE_CRM_DEAL", "crm_deal", id, {
    company_id: companyId,
  });
  const deal = await env.DB.prepare("SELECT * FROM crm_deals WHERE id = ?1")
    .bind(id)
    .first<CrmDealRow>();
  return jsonResponse({ deal }, 201);
}

/** Won side effect (OpenCRM-style): the company becomes a paying customer on
 * the day of its FIRST win — never overwritten by later wins, never touching
 * a date an operator set deliberately. */
async function markCompanyCustomer(env: AdminEnv, companyId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE crm_companies
     SET customer_since = ?1, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?2 AND customer_since IS NULL`,
  )
    .bind(todayStr(), companyId)
    .run();
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
  // Placeholder numbering follows binds.length (NOT sets.length): some sets
  // are literal (`lost_reason = NULL`) and would otherwise skew ?N — a value
  // would bind to the wrong parameter and silently NULL a column.
  if ("title" in body) {
    sets.push(`title = ?${binds.length + 2}`);
    binds.push(reqString(body.title, "title", 200));
  }
  let newStage: string | null = null;
  if ("stage" in body) {
    const stage = oneOf(body.stage, DEAL_STAGES, "stage");
    if (stage !== existing.stage) stageChangedTo = stage;
    newStage = stage;
    sets.push(`stage = ?${binds.length + 2}`);
    binds.push(stage);
  }
  const finalStage = newStage ?? existing.stage;
  let lostReason: string | null = null;
  if ("lost_reason" in body) {
    lostReason = optString(body.lost_reason, "lost_reason", 200);
    if (lostReason && finalStage !== "lost") {
      throw new HttpError(400, "只有输单商机才能填写输单原因");
    }
    sets.push(`lost_reason = ?${binds.length + 2}`);
    binds.push(lostReason);
  }
  // Reopened deals must not keep a stale loss reason — the reason describes
  // the loss, and a deal back in the pipeline is no longer lost. (An explicit
  // lost_reason together with a non-lost stage is rejected above.)
  if (stageChangedTo && stageChangedTo !== "lost") sets.push("lost_reason = NULL");
  if (stageChangedTo === "won") {
    sets.push(`won_at = ?${binds.length + 2}`);
    binds.push(todayStr());
  }
  if ("amount" in body) {
    sets.push(`amount = ?${binds.length + 2}`);
    binds.push(optAmount(body.amount));
  }
  if ("incoterms" in body) {
    sets.push(`incoterms = ?${binds.length + 2}`);
    binds.push(optString(body.incoterms, "incoterms", 50));
  }
  if ("expected_close_date" in body) {
    sets.push(`expected_close_date = ?${binds.length + 2}`);
    binds.push(optDate(body.expected_close_date, "expected_close_date"));
  }
  if ("position" in body) {
    const pos = Number(body.position);
    if (!Number.isFinite(pos) || pos < 0) throw new HttpError(400, "position 必须是非负数字");
    sets.push(`position = ?${binds.length + 2}`);
    binds.push(pos);
  }
  const archived = optBool(body.archived, "archived");
  if (archived === true) {
    sets.push(`archived_at = ?${binds.length + 2}`);
    binds.push(todayStr());
  } else if (archived === false) {
    sets.push("archived_at = NULL");
  }
  if (!sets.length) throw new HttpError(400, "没有可更新字段");
  sets.push("updated_at = CURRENT_TIMESTAMP");
  await env.DB.prepare(`UPDATE crm_deals SET ${sets.join(", ")} WHERE id = ?1`)
    .bind(id, ...binds)
    .run();

  // Stage moves are timeline events — the panel timeline and the audit trail
  // should tell the same story.
  if (stageChangedTo) {
    let summary: string;
    if (stageChangedTo === "won") {
      summary = `商机「${existing.title}」赢单 🎉（${existing.stage} → won），公司转正式客户`;
    } else if (stageChangedTo === "lost") {
      const reason = lostReason ?? null;
      summary = `商机「${existing.title}」输单（${existing.stage} → lost）${reason ? `，原因: ${reason}` : ""}`;
    } else {
      summary = `商机「${existing.title}」阶段推进: ${existing.stage} → ${stageChangedTo}`;
    }
    await env.DB.prepare(
      `INSERT INTO crm_activities (id, company_id, deal_id, type, summary)
       VALUES (?1, ?2, ?3, 'note', ?4)`,
    )
      .bind(crypto.randomUUID(), existing.company_id, id, summary)
      .run();
    if (stageChangedTo === "won") await markCompanyCustomer(env, existing.company_id);
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
  const sets: string[] = [];
  const binds: unknown[] = [];
  const isCompleted = optBool(body.is_completed, "is_completed");
  if (isCompleted !== null) {
    sets.push(`is_completed = ?${sets.length + 2}`);
    binds.push(isCompleted ? 1 : 0);
  }
  if ("due_date" in body) {
    // Reschedule (panel「→明天」snooze). Dates only make sense on open loop
    // items — a note/call row must stay a pure timeline entry.
    if (existing.type !== "task") throw new HttpError(400, "due_date 只能用于任务");
    sets.push(`due_date = ?${sets.length + 2}`);
    binds.push(optDate(body.due_date, "due_date"));
  }
  if (!sets.length) throw new HttpError(400, "没有可更新字段");
  await env.DB.prepare(`UPDATE crm_activities SET ${sets.join(", ")} WHERE id = ?1`)
    .bind(id, ...binds)
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

/* ── Aggregate stats（面板统计卡 + 成交走势图） ─────────────────────────── */

interface CrmStatsRow {
  companies_total: number;
  customers_won: number;
  open_deals: number;
  pipeline_amount: number;
  /** Weighted forecast: open deals discounted by stage
   * (inquiry 10% / sample_quoted 30% / pi_sent 50% / deposit_paid 80%). */
  forecast_amount: number;
  open_tasks: number;
  overdue_tasks: number;
}

async function crmStats(env: AdminEnv): Promise<Response> {
  const stats = await env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM crm_companies) AS companies_total,
      (SELECT COUNT(*) FROM crm_companies WHERE customer_since IS NOT NULL) AS customers_won,
      (SELECT COUNT(*) FROM crm_deals WHERE stage NOT IN ('won','lost') AND archived_at IS NULL) AS open_deals,
      (SELECT IFNULL(SUM(amount), 0) FROM crm_deals WHERE stage NOT IN ('won','lost') AND archived_at IS NULL) AS pipeline_amount,
      (SELECT IFNULL(SUM(amount * CASE stage WHEN 'inquiry' THEN 0.1 WHEN 'sample_quoted' THEN 0.3 WHEN 'pi_sent' THEN 0.5 ELSE 0.8 END), 0)
        FROM crm_deals WHERE stage NOT IN ('won','lost') AND archived_at IS NULL) AS forecast_amount,
      (SELECT COUNT(*) FROM crm_activities WHERE type = 'task' AND is_completed = 0) AS open_tasks,
      (SELECT COUNT(*) FROM crm_activities WHERE type = 'task' AND is_completed = 0
        AND due_date IS NOT NULL AND due_date < date('now')) AS overdue_tasks`,
  ).first<CrmStatsRow>();
  const won = await env.DB.prepare(
    `SELECT strftime('%Y-%m', won_at) AS month, IFNULL(SUM(amount), 0) AS total
     FROM crm_deals
     WHERE stage = 'won' AND won_at IS NOT NULL AND won_at >= date('now', '-5 months', 'start of month')
     GROUP BY month ORDER BY month`,
  ).all<{ month: string; total: number }>();
  return jsonResponse({ stats: stats ?? null, won_monthly: won.results, funnel: await crmFunnel(env) });
}

/* P1-8 客户开发漏斗：公司 → 联系人 → 触达 → 回复 → 商机 → 赢单。
 * 口径说明（避免「发送 ≠ 送达」的常见混淆）：触达 = gmail_send_log 里
 * status='sent' 的发信次数（attempt 数，非送达数）；回复 = 时间线
 * email_received 活动数；商机/赢单 = 未归档 crm_deals。全部 fail-open：
 * gmail_send_log 缺失时返回 null，其余指标照常。 */
export interface CrmFunnelRow {
  companies: number;
  contacts: number;
  emails_sent: number;
  replies: number;
  deals: number;
  won: number;
  reply_rate: number;
}

async function crmFunnel(env: AdminEnv): Promise<CrmFunnelRow | null> {
  try {
    const emailsSent = (await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM gmail_send_log WHERE status = 'sent'",
    ).first<{ n: number }>())?.n ?? 0;
    const funnel = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM crm_companies) AS companies,
        (SELECT COUNT(*) FROM crm_contacts) AS contacts,
        (SELECT COUNT(*) FROM crm_activities WHERE type = 'email_received') AS replies,
        (SELECT COUNT(*) FROM crm_deals WHERE archived_at IS NULL AND stage NOT IN ('lost')) AS deals,
        (SELECT COUNT(*) FROM crm_deals WHERE archived_at IS NULL AND stage = 'won') AS won`,
    ).first<{ companies: number; contacts: number; replies: number; deals: number; won: number }>();
    if (!funnel) return null;
    const replyRate = emailsSent > 0 ? Math.round((funnel.replies / emailsSent) * 1000) / 10 : 0;
    return {
      companies: funnel.companies,
      contacts: funnel.contacts,
      emails_sent: emailsSent,
      replies: funnel.replies,
      deals: funnel.deals,
      won: funnel.won,
      reply_rate: replyRate,
    };
  } catch {
    return null;
  }
}

/* ── CSV import（公司/联系人/商机，中英表头，自动去重） ─────────────────── */

/** RFC4180-ish CSV parser: quoted cells, "" escapes, CR/LF/CRLF all fine.
 * The BOM that Excel/Notepad prepend to UTF-8 exports is stripped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  // Blank lines (trailing newline etc.) are noise, not data.
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const IMPORT_ENTITIES = ["companies", "contacts", "deals"] as const;
type ImportEntity = (typeof IMPORT_ENTITIES)[number];

/** Column aliases per entity — English and Chinese headers both accepted. */
const IMPORT_HEADERS: Record<ImportEntity, Record<string, string>> = {
  companies: {
    name: "name", 名称: "name", 公司名称: "name", 公司: "name",
    domain: "domain", 域名: "domain",
    country: "country", 国家: "country",
    industry: "industry", 行业: "industry",
    tier: "tier", 分级: "tier",
    chinese_remarks: "chinese_remarks", 备注: "chinese_remarks", 中文备注: "chinese_remarks",
  },
  contacts: {
    company: "company", 公司: "company", 公司名称: "company", company_name: "company",
    full_name: "full_name", 姓名: "full_name", 联系人: "full_name",
    job_title: "job_title", 职务: "job_title", title: "job_title",
    email: "email", 邮箱: "email",
    whatsapp_or_phone: "whatsapp_or_phone", 电话: "whatsapp_or_phone", phone: "whatsapp_or_phone",
    whatsapp: "whatsapp_or_phone", 手机: "whatsapp_or_phone",
    linkedin_url: "linkedin_url", linkedin: "linkedin_url",
    is_primary: "is_primary", 主联: "is_primary",
  },
  deals: {
    company: "company", 公司: "company", 公司名称: "company", company_name: "company",
    title: "title", 名称: "title", 商机名称: "title", 商机: "title",
    stage: "stage", 阶段: "stage",
    amount: "amount", 金额: "amount",
    incoterms: "incoterms", 条款: "incoterms", 贸易条款: "incoterms",
    expected_close_date: "expected_close_date", 预计成交: "expected_close_date",
    预计成交日: "expected_close_date",
    lost_reason: "lost_reason", 输单原因: "lost_reason",
  },
};

interface ImportCompanyCache {
  byName: Map<string, string>; // lowercased name → id
  byDomain: Map<string, string>; // lowercased domain → id
}

async function loadCompanyCache(env: AdminEnv): Promise<ImportCompanyCache> {
  const rows = await env.DB.prepare(
    "SELECT id, name, domain FROM crm_companies LIMIT 20000",
  ).all<{ id: string; name: string; domain: string | null }>();
  const cache: ImportCompanyCache = { byName: new Map(), byDomain: new Map() };
  for (const r of rows.results) {
    cache.byName.set(r.name.toLowerCase(), r.id);
    if (r.domain) cache.byDomain.set(r.domain.toLowerCase(), r.id);
  }
  return cache;
}

interface ImportResult {
  created: number;
  skipped: number;
  errors: string[];
}

const IMPORT_ROW_LIMIT = 1000;

async function importCrmCsv(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
): Promise<Response> {
  const body = await readJsonBody(request);
  const entity = oneOf(body.entity, IMPORT_ENTITIES, "entity");
  const csv = reqString(body.csv, "csv", 400_000);
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new HttpError(400, "CSV 至少需要表头 + 一行数据");
  if (rows.length - 1 > IMPORT_ROW_LIMIT) {
    throw new HttpError(400, `CSV 最多 ${IMPORT_ROW_LIMIT} 行数据`);
  }

  const aliases = IMPORT_HEADERS[entity];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const keyByIndex = header.map((h) => aliases[h] ?? null);
  const keys = new Set(keyByIndex.filter((k): k is string => k !== null));
  const requireKey = (key: string, label: string) => {
    if (!keys.has(key)) {
      throw new HttpError(400, `缺少必需列「${label}」，可用表头: ${Object.keys(aliases).join(" / ")}`);
    }
  };
  if (entity === "companies") requireKey("name", "名称");
  else if (entity === "contacts") {
    requireKey("full_name", "姓名");
    requireKey("company", "公司");
  } else {
    requireKey("title", "名称");
    requireKey("company", "公司");
  }

  const result: ImportResult = { created: 0, skipped: 0, errors: [] };
  type CrmStatement = ReturnType<AdminEnv["DB"]["prepare"]>;
  const statements: CrmStatement[] = [];
  let companiesCreated = 0;
  const companies = await loadCompanyCache(env);

  const resolveCompany = (
    rec: Record<string, string>,
    rowIndex: number,
  ): { id: string } | { error: string } => {
    const name = (rec.company ?? "").trim();
    const domain = (rec.domain ?? "").trim().toLowerCase();
    if (!name && !domain) return { error: `第 ${rowIndex} 行: 缺少公司名称/域名` };
    if (domain && companies.byDomain.has(domain)) return { id: companies.byDomain.get(domain)! };
    if (name && companies.byName.has(name.toLowerCase())) return { id: companies.byName.get(name.toLowerCase())! };
    // Auto-create the company (OpenCRM import behavior): contacts/deals rows
    // name a company that does not exist yet — create it so the row imports.
    const id = crypto.randomUUID();
    const companyName = name || domain;
    if (name) companies.byName.set(name.toLowerCase(), id);
    if (domain) companies.byDomain.set(domain, id);
    statements.push(
      env.DB.prepare(
        `INSERT INTO crm_companies (id, name, domain, industry, country, tier, lead_status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'new')`,
      ).bind(
        id,
        companyName,
        domain || null,
        (rec.industry ?? "").trim() || null,
        (rec.country ?? "").trim() || null,
        "unqualified",
      ),
    );
    companiesCreated++;
    return { id };
  };

  if (entity === "companies") {
    for (let i = 1; i < rows.length; i++) {
      const rec: Record<string, string> = {};
      for (let c = 0; c < keyByIndex.length; c++) {
        if (keyByIndex[c]) rec[keyByIndex[c]!] = rows[i][c] ?? "";
      }
      const rowIndex = i + 1;
      const name = (rec.name ?? "").trim();
      const domain = (rec.domain ?? "").trim().toLowerCase();
      if (!name) {
        result.errors.push(`第 ${rowIndex} 行: 缺少公司名称`);
        continue;
      }
      if (companies.byName.has(name.toLowerCase()) || (domain && companies.byDomain.has(domain))) {
        result.skipped++;
        continue;
      }
      const tierRaw = (rec.tier ?? "").trim();
      const tier = (TIERS as readonly string[]).includes(tierRaw) ? tierRaw : "unqualified";
      const id = crypto.randomUUID();
      companies.byName.set(name.toLowerCase(), id);
      if (domain) companies.byDomain.set(domain, id);
      statements.push(
        env.DB.prepare(
          `INSERT INTO crm_companies (id, name, domain, industry, country, tier, lead_status, chinese_remarks)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'new', ?7)`,
        ).bind(
          id,
          name,
          domain || null,
          (rec.industry ?? "").trim() || null,
          (rec.country ?? "").trim() || null,
          tier,
          (rec.chinese_remarks ?? "").trim() || null,
        ),
      );
      result.created++;
    }
  } else if (entity === "contacts") {
    // Dedupe key: same company + same email (when present).
    const existing = await env.DB.prepare(
      "SELECT company_id, LOWER(IFNULL(email, '')) AS lemail FROM crm_contacts LIMIT 50000",
    ).all<{ company_id: string; lemail: string }>();
    const seen = new Set(existing.results.map((r) => `${r.company_id}|${r.lemail}`));
    for (let i = 1; i < rows.length; i++) {
      const rec: Record<string, string> = {};
      for (let c = 0; c < keyByIndex.length; c++) {
        if (keyByIndex[c]) rec[keyByIndex[c]!] = rows[i][c] ?? "";
      }
      const rowIndex = i + 1;
      const fullName = (rec.full_name ?? "").trim();
      if (!fullName) {
        result.errors.push(`第 ${rowIndex} 行: 缺少联系人姓名`);
        continue;
      }
      const resolved = resolveCompany(rec, rowIndex);
      if ("error" in resolved) {
        result.errors.push(resolved.error);
        continue;
      }
      const email = (rec.email ?? "").trim().toLowerCase();
      if (email && seen.has(`${resolved.id}|${email}`)) {
        result.skipped++;
        continue;
      }
      if (email) seen.add(`${resolved.id}|${email}`);
      const isPrimary = ["1", "true", "是", "y", "yes"].includes((rec.is_primary ?? "").trim().toLowerCase())
        ? 1
        : 0;
      statements.push(
        env.DB.prepare(
          `INSERT INTO crm_contacts (id, company_id, full_name, job_title, email, whatsapp_or_phone, linkedin_url, is_primary)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        ).bind(
          crypto.randomUUID(),
          resolved.id,
          fullName,
          (rec.job_title ?? "").trim() || null,
          (rec.email ?? "").trim() || null,
          (rec.whatsapp_or_phone ?? "").trim() || null,
          (rec.linkedin_url ?? "").trim() || null,
          isPrimary,
        ),
      );
      result.created++;
    }
  } else {
    // deals: per-stage position counters keep the imported kanban ordered.
    const maxPos = new Map<string, number>();
    const posRows = await env.DB.prepare(
      "SELECT stage, MAX(position) AS m FROM crm_deals GROUP BY stage",
    ).all<{ stage: string; m: number | null }>();
    for (const r of posRows.results) maxPos.set(r.stage, r.m ?? 0);
    for (let i = 1; i < rows.length; i++) {
      const rec: Record<string, string> = {};
      for (let c = 0; c < keyByIndex.length; c++) {
        if (keyByIndex[c]) rec[keyByIndex[c]!] = rows[i][c] ?? "";
      }
      const rowIndex = i + 1;
      const title = (rec.title ?? "").trim();
      if (!title) {
        result.errors.push(`第 ${rowIndex} 行: 缺少商机名称`);
        continue;
      }
      const resolved = resolveCompany(rec, rowIndex);
      if ("error" in resolved) {
        result.errors.push(resolved.error);
        continue;
      }
      const stageRaw = (rec.stage ?? "").trim();
      const stage = (DEAL_STAGES as readonly string[]).includes(stageRaw) ? stageRaw : "inquiry";
      const amountRaw = (rec.amount ?? "").trim();
      const amountNum = Number(amountRaw.replace(/[$,\s]/g, ""));
      const amount = amountRaw && Number.isFinite(amountNum) ? amountNum : null;
      const dateRaw = (rec.expected_close_date ?? "").trim();
      const closeDate = DATE_RE.test(dateRaw) ? dateRaw : null;
      const lostReason = stage === "lost" ? (rec.lost_reason ?? "").trim() || null : null;
      const pos = (maxPos.get(stage) ?? 0) + 1;
      maxPos.set(stage, pos);
      const dealId = crypto.randomUUID();
      const statementsDeal = [
        env.DB.prepare(
          `INSERT INTO crm_deals (id, company_id, title, stage, amount, incoterms, expected_close_date, lost_reason, won_at, position)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        ).bind(
          dealId,
          resolved.id,
          title,
          stage,
          amount,
          (rec.incoterms ?? "").trim() || null,
          closeDate,
          lostReason,
          stage === "won" ? todayStr() : null,
          pos,
        ),
      ];
      if (stage === "won") {
        statementsDeal.push(
          env.DB.prepare(
            `UPDATE crm_companies SET customer_since = ?1, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?2 AND customer_since IS NULL`,
          ).bind(todayStr(), resolved.id),
        );
      }
      statements.push(...statementsDeal);
      result.created++;
    }
  }

  // One chunked batch per 50 statements — a single mega-batch would exceed
  // D1's per-call statement budget on large imports.
  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }

  await auditAdminAction(env, request, auth, "CRM_CSV_IMPORT", `crm_${entity}`, null, {
    rows: rows.length - 1,
    created: result.created,
    skipped: result.skipped,
    errors: result.errors.length,
  });
  return jsonResponse({
    created: result.created,
    companies_created: companiesCreated,
    skipped: result.skipped,
    error_total: result.errors.length,
    errors: result.errors.slice(0, 20),
  });
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

    if (resource === "stats") {
      if (method === "GET") return await crmStats(env);
    } else if (resource === "import") {
      if (method === "POST") return await importCrmCsv(request, env, auth);
    } else if (resource === "companies") {
      if (!id && method === "GET") return await listCompanies(url, env);
      if (!id && method === "POST") return await createCompany(request, env, auth);
      if (id === "promote" && method === "POST") return await promoteLead(request, env, auth);
      if (id === "merge" && method === "POST") return await mergeCompanies(request, env, auth);
      if (id && method === "GET") return await getCompany(env, id);
      if (id && method === "PATCH") return await updateCompany(request, env, auth, id);
      if (id && method === "DELETE") return await deleteCompany(request, env, auth, id);
    } else if (resource === "contacts") {
      if (id === "merge" && method === "POST") return await mergeContacts(request, env, auth);
      if (!id && method === "POST") return await createContact(request, env, auth);
      if (id && method === "PATCH") return await updateContact(request, env, id);
      if (id && method === "DELETE") return await deleteContact(env, id);
    } else if (resource === "deals") {
      if (!id && method === "GET") return await listDeals(env, url);
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
