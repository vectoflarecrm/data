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
import {
  createSequenceInDb,
  deleteSequenceInDb,
  enrollInSequence,
  listEnrollmentsFor,
  listSequencesWithCounts,
  setEnrollmentStatusInDb,
  setSequenceEnabledInDb,
} from "./sequences";
import {
  listDomainChecks,
  recheckCompanyDomainInDb,
  recheckContactEmailInDb,
  type DomainCheckResult,
} from "./email-verify";
import { inferProcurementRole, PROCUREMENT_ROLES, type ProcurementRole } from "./contact-roles";
import {
  checkCompanySignals,
  listSignalOverview,
  updateSignalWatch,
  type SignalCheckReport,
} from "./signal-monitor";
import { COMPANY_SOURCES, getAttribution } from "./crm-attribution";
import { buildIcsFeed, getTaskCalendar } from "./crm-calendar";
import {
  IMPORT_ENTITIES,
  REQUIRED_KEYS,
  type ImportEntity,
  cleanDomainValue,
  decodeBase64,
  detectEntity,
  excelSerialToIsoDate,
  hasContactName,
  isExcelErrorValue,
  matchColumns,
  normalizeStageValue,
  parseXlsx,
} from "./crm-excel-import";

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
  /** 0038 ⑤ 来源归因：promoted/manual/csv_import/merge/referral/other/unknown。 */
  source: string;
  /** 0041 公司扩展属性：地址 / 外部编号 / 经销代理品牌（Excel 导入补全）。 */
  address: string | null;
  external_id: string | null;
  dealer_brands: string | null;
  /** 0042 公司信息对齐 /admin 客户字段：法定/交易名称、地址组、公司级电话/WhatsApp。 */
  legal_name: string | null;
  trading_name: string | null;
  zip_city: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country_code: string | null;
  tel: string | null;
  whatsapp: string | null;
  /** 0042 业务属性：产品与服务 / 业务标签 / 公司类型 / 商业模式 / 规模与市场。 */
  products_services: string | null;
  business_tag: string | null;
  company_type: string | null;
  business_model: string | null;
  founded_year: string | null;
  employee_range: string | null;
  description: string | null;
  target_markets: string | null;
  customer_segment: string | null;
  product_categories: string | null;
  company_size: string | null;
  geographic_coverage: string | null;
  /** 0042 业务角色布尔标签（制造商/进口商/分销商/批发商/零售商/电商/租赁/OEM）。 */
  is_manufacturer: number;
  is_importer: number;
  is_distributor: number;
  is_wholesaler: number;
  is_retailer: number;
  is_ecommerce: number;
  is_rental: number;
  is_oem: number;
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
  /** 遗留单列（0042 前的合并列；已回填进 whatsapp，停写保留供老代码读取）。 */
  whatsapp_or_phone: string | null;
  /** 0042 电话三列拆分（同 /admin 联系人格式）：固话 / 手机 / WhatsApp。 */
  tel: string | null;
  cellphone: string | null;
  whatsapp: string | null;
  linkedin_url: string | null;
  is_primary: number;
  /** 触达质量闭环：unknown/valid/invalid（退信自动标 invalid）。 */
  email_status: string;
  email_verified_at: string | null;
  /** 客户退订的时间；写入后发送前统一检查将拦截。 */
  unsubscribed_at: string | null;
  /** 手动或退订自动标记的禁止联系开关。 */
  do_not_contact: number;
  /** 0037 邮箱/域名检测结论（pending/valid/free_email/disposable/no_mx/dead_domain）。 */
  email_check_status: string;
  /** ⑦ 多角色图谱：owner/procurement/finance/channel/operations/sales/other/unknown。 */
  procurement_role: string;
  /** 角色判定依据（命中关键词或人工说明）。 */
  role_evidence: string | null;
  role_updated_at: string | null;
  created_at: string;
}

/** ⑦ 图谱边：crm_deal_contacts 行（商机 ↔ 联系人）。 */
export interface DealContactEdge {
  deal_id: string;
  contact_id: string;
  role_in_deal: string | null;
  added_at: string;
  full_name: string;
  job_title: string | null;
  procurement_role: string;
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
  /** 0038 ⑧ 任务日历：任务负责人（用户名，NULL = 未分配）。 */
  owner: string | null;
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

/** 0042 公司信息对齐 /admin 客户字段：可编辑文本字段与长度上限
 * （[字段名, 最大长度]，updateCompany PATCH / 导入共用语义）。 */
const COMPANY_TEXT_FIELDS: ReadonlyArray<readonly [string, number]> = [
  ["legal_name", 200],
  ["trading_name", 200],
  ["zip_city", 100],
  ["city", 100],
  ["region", 100],
  ["postal_code", 100],
  ["country_code", 100],
  ["tel", 100],
  ["whatsapp", 100],
  ["products_services", 2000],
  ["business_tag", 200],
  ["company_type", 200],
  ["business_model", 200],
  ["founded_year", 20],
  ["employee_range", 100],
  ["description", 2000],
  ["target_markets", 500],
  ["customer_segment", 200],
  ["product_categories", 500],
  ["company_size", 100],
  ["geographic_coverage", 500],
];

/** 0042 业务角色布尔标签（业务类型勾选框，0/1）。 */
const COMPANY_ROLE_FLAGS = [
  "is_manufacturer",
  "is_importer",
  "is_distributor",
  "is_wholesaler",
  "is_retailer",
  "is_ecommerce",
  "is_rental",
  "is_oem",
] as const;

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
    `INSERT INTO crm_companies (id, name, domain, industry, country, tier, lead_status, chinese_remarks, source)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'manual')`,
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
  // 0042 公司信息对齐 /admin 客户字段：创建时允许携带 0041/0042 扩展字段。
  const extraSets: string[] = [];
  const extraBinds: unknown[] = [];
  for (const [field, maxLength] of [
    ...[
      ["address", 500],
      ["external_id", 100],
      ["dealer_brands", 500],
    ] as ReadonlyArray<readonly [string, number]>,
    ...COMPANY_TEXT_FIELDS,
  ]) {
    if (field in body) {
      extraSets.push(`${field} = ?${extraSets.length + 1}`);
      extraBinds.push(optString(body[field], field, maxLength));
    }
  }
  for (const flag of COMPANY_ROLE_FLAGS) {
    if (flag in body) {
      const value = optBool(body[flag], flag);
      if (value === null) throw new HttpError(400, `${flag} 需要布尔值`);
      extraSets.push(`${flag} = ?${extraSets.length + 1}`);
      extraBinds.push(value ? 1 : 0);
    }
  }
  if (extraSets.length) {
    await env.DB.prepare(
      `UPDATE crm_companies SET ${extraSets.join(", ")} WHERE id = ?${extraSets.length + 1}`,
    )
      .bind(...extraBinds, id)
      .run();
  }
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
  // ⑦ 图谱边：这家公司各商机关联的联系人（crm_deal_contacts）。
  const dealContacts = await env.DB.prepare(
    `SELECT dc.deal_id, dc.contact_id, dc.role_in_deal, dc.added_at,
            ct.full_name, ct.job_title, ct.procurement_role
     FROM crm_deal_contacts dc
     JOIN crm_contacts ct ON ct.id = dc.contact_id
     JOIN crm_deals d ON d.id = dc.deal_id
     WHERE d.company_id = ?1
     ORDER BY dc.added_at ASC`,
  )
    .bind(id)
    .all<DealContactEdge>();
  const edges = new Map<string, DealContactEdge[]>();
  for (const edge of dealContacts.results) {
    const list = edges.get(edge.deal_id) ?? [];
    list.push(edge);
    edges.set(edge.deal_id, list);
  }
  const dealsWithContacts = deals.results.map((d) => ({ ...d, contacts: edges.get(d.id) ?? [] }));
  // ⑥ 持续意向监测：这家公司最近的有效信号（过期信号不再展示）。
  const signals = await env.DB.prepare(
    `SELECT * FROM crm_signal_checks
     WHERE company_id = ?1 AND expires_at > datetime('now')
     ORDER BY detected_at DESC LIMIT 20`,
  )
    .bind(id)
    .all();
  return jsonResponse({
    company,
    contacts: contacts.results,
    deals: dealsWithContacts,
    activities: activities.results,
    signals: signals.results,
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
    // 邮箱检测（0036）：域名新增/修改 → 重新进入检测队列。
    sets.push("domain_email_status = 'pending'");
  }
  if ("industry" in body) {
    sets.push(`industry = ?${sets.length + 2}`);
    binds.push(optString(body.industry, "industry", 100));
  }
  if ("country" in body) {
    sets.push(`country = ?${sets.length + 2}`);
    binds.push(optString(body.country, "country", 100));
  }
  // 0041 Excel 导入的公司扩展属性：详情页可直接修改导入内容。
  if ("address" in body) {
    sets.push(`address = ?${sets.length + 2}`);
    binds.push(optString(body.address, "address", 500));
  }
  if ("external_id" in body) {
    sets.push(`external_id = ?${sets.length + 2}`);
    binds.push(optString(body.external_id, "external_id", 100));
  }
  if ("dealer_brands" in body) {
    sets.push(`dealer_brands = ?${sets.length + 2}`);
    binds.push(optString(body.dealer_brands, "dealer_brands", 500));
  }
  // 0042 公司信息对齐 /admin 客户字段：详情页分区表单全部可编辑。
  for (const [field, maxLength] of COMPANY_TEXT_FIELDS) {
    if (field in body) {
      sets.push(`${field} = ?${sets.length + 2}`);
      binds.push(optString(body[field], field, maxLength));
    }
  }
  for (const flag of COMPANY_ROLE_FLAGS) {
    if (flag in body) {
      const value = optBool(body[flag], flag);
      if (value === null) throw new HttpError(400, `${flag} 需要布尔值`);
      sets.push(`${flag} = ?${sets.length + 2}`);
      binds.push(value ? 1 : 0);
    }
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
  // ⑤ 来源归因（0038）：允许人工修正获客来源（如把 unknown 改成 referral）。
  if ("source" in body) {
    sets.push(`source = ?${sets.length + 2}`);
    binds.push(oneOf(body.source, COMPANY_SOURCES, "source"));
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
    `INSERT INTO crm_companies (id, name, domain, industry, country, tier, lead_status, source)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'enriched', 'promoted')`,
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
  // 0042 电话三列直拷（tel/cellphone/whatsapp 各自独立），遗留单列
  // whatsapp_or_phone 继续按旧 COALESCE 填充（兼容老代码读取）。
  await env.DB.prepare(
    `INSERT INTO crm_contacts (id, company_id, full_name, job_title, email, whatsapp_or_phone, tel, cellphone, whatsapp, linkedin_url, is_primary)
     SELECT 'ct_' || ct.id, ?1,
       COALESCE(NULLIF(TRIM(COALESCE(NULLIF(ct.full_name, ''), TRIM(COALESCE(ct.first_name, '') || ' ' || COALESCE(ct.last_name, '')))), ''), '联系人-' || ct.seq),
       ct.title, ct.email,
       COALESCE(NULLIF(ct.whatsapp, ''), NULLIF(ct.cellphone, ''), NULLIF(ct.tel, '')),
       NULLIF(ct.tel, ''), NULLIF(ct.cellphone, ''), NULLIF(ct.whatsapp, ''),
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

  // 数据保全：来源公司的非空字段在目标为空时回填（行业/国家/0041 扩展列/
  // 0042 admin 对齐列），中文备注以 [并入备注] 追加保留 —— 来源行随后删除，
  // 不保全即丢失。
  const carrySets: string[] = [];
  const carryBinds: unknown[] = [];
  const carryFields: Array<[string, unknown, unknown]> = [
    ["industry", source.industry, target.industry],
    ["country", source.country, target.country],
    ["address", source.address, target.address],
    ["external_id", source.external_id, target.external_id],
    ["dealer_brands", source.dealer_brands, target.dealer_brands],
    // 0042 公司信息对齐 /admin 客户字段：字符串列「目标为空才回填」。
    ["legal_name", source.legal_name, target.legal_name],
    ["trading_name", source.trading_name, target.trading_name],
    ["zip_city", source.zip_city, target.zip_city],
    ["city", source.city, target.city],
    ["region", source.region, target.region],
    ["postal_code", source.postal_code, target.postal_code],
    ["country_code", source.country_code, target.country_code],
    ["tel", source.tel, target.tel],
    ["whatsapp", source.whatsapp, target.whatsapp],
    ["products_services", source.products_services, target.products_services],
    ["business_tag", source.business_tag, target.business_tag],
    ["company_type", source.company_type, target.company_type],
    ["business_model", source.business_model, target.business_model],
    ["founded_year", source.founded_year, target.founded_year],
    ["employee_range", source.employee_range, target.employee_range],
    ["description", source.description, target.description],
    ["target_markets", source.target_markets, target.target_markets],
    ["customer_segment", source.customer_segment, target.customer_segment],
    ["product_categories", source.product_categories, target.product_categories],
    ["company_size", source.company_size, target.company_size],
    ["geographic_coverage", source.geographic_coverage, target.geographic_coverage],
  ];
  for (const [field, rawSource, rawTarget] of carryFields) {
    const sv = String(rawSource ?? "").trim();
    const tv = String(rawTarget ?? "").trim();
    if (sv && !tv) {
      carrySets.push(`${String(field)} = ?${carryBinds.length + 3}`);
      carryBinds.push(sv);
    }
  }
  // 0042 业务角色布尔标签：数值特判（字符串机制对 "0" 无效）——
  // 来源勾选且目标未勾选 → 置 1（只升不降，与「目标已有不被覆盖」一致）。
  const carryFlags: Array<[string, number, number]> = [
    ["is_manufacturer", source.is_manufacturer, target.is_manufacturer],
    ["is_importer", source.is_importer, target.is_importer],
    ["is_distributor", source.is_distributor, target.is_distributor],
    ["is_wholesaler", source.is_wholesaler, target.is_wholesaler],
    ["is_retailer", source.is_retailer, target.is_retailer],
    ["is_ecommerce", source.is_ecommerce, target.is_ecommerce],
    ["is_rental", source.is_rental, target.is_rental],
    ["is_oem", source.is_oem, target.is_oem],
  ];
  for (const [field, sv, tv] of carryFlags) {
    if (sv === 1 && tv !== 1) {
      carrySets.push(`${String(field)} = 1`);
    }
  }

  const remarkLine = `[合并] ${new Date().toISOString().slice(0, 10)} 并入重复公司 ${source.name}（ID: ${source.id}）`;
  const sourceRemarkLine = source.chinese_remarks
    ? `\n[并入备注] ${source.name}: ${source.chinese_remarks}`
    : "";
  const newRemarks = `${target.chinese_remarks ? target.chinese_remarks + "\n" : ""}${remarkLine}${sourceRemarkLine}`;
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
       SET chinese_remarks = ?1, merged_from_ids = ?2${carrySets.length ? ", " + carrySets.join(", ") : ""},
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?${carryBinds.length + 3}`,
    ).bind(newRemarks, newMerged, ...carryBinds, targetId),
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
    // 域名继承必须排在 DELETE 来源之后：domain 是 UNIQUE 列，来源行还
    // 占着该域名时先写目标会撞唯一约束、整批中止（生产 500 事故）。
    statements.push(
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

/* ── 疑似重复公司检测（≥2 项近似 或 名称强匹配） ────────────────────────────
 * 规则（用户定义）：以下各项中至少 2 项近似相同才列为候选比对：
 *   ① 公司名称   ② 地址   ③ 电话   ④ 网址(域名)   ⑤ 公司邮箱后缀
 *   ⑥ WhatsApp   ⑦ Cellphone   ⑧ 联系人重合（同邮箱/同电话/同姓名，
 *     作为额外信号补入计项池）
 * ③⑥⑦ 分别存于 crm_contacts 的 tel/cellphone/whatsapp（0042 拆列）及
 * 遗留列 whatsapp_or_phone → 联系人各列归一化后合为 1 项「电话/WhatsApp」
 * 信号。名称强匹配（归一化后相同 / 整词包含）可单独
 * 入选（BOATS R US ⊂ Boats R Us Corp 这类一行建两档的常见形态）。
 * domain 是 UNIQUE 列，两家不可能同域 →「网址」按核心标签包含近似判
 * 定。邮箱后缀排除 gmail/yahoo 等免费域。结果只做人工比对候选，是否
 * 合并由人在比对页决定。 */
interface DupPair {
  a_id: string;
  a_name: string;
  b_id: string;
  b_name: string;
  reasons: string[];
}

const CO_NAME_STOPWORDS = new Set([
  "the", "and", "of", "de", "del", "la", "el", "los", "las", "inc", "llc", "corp",
  "corporation", "co", "company", "ltd",
]);
/* 免费邮箱域不做「公司邮箱后缀」信号 —— 两个陌生人同用 gmail 不构成
 * 公司重合证据。 */
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "yahoo.es", "hotmail.com", "hotmail.es", "outlook.com",
  "outlook.es", "aol.com", "icloud.com", "me.com", "live.com", "msn.com",
  "protonmail.com", "proton.me", "gmx.com", "mail.com", "yandex.com", "yandex.ru",
  "mail.ru", "zoho.com", "comcast.net", "verizon.net", "att.net", "sbcglobal.net",
]);
/* 通用联系人姓名跨公司大面积误报，不作为「联系人重合」证据。 */
const GENERIC_CONTACT_NAMES = new Set([
  "admin", "owner", "info", "manager", "sales", "contact", "office", "general",
  "gerencia", "oficina", "staff", "team", "hello", "support", "bookings", "booking",
  "reservation", "reservations",
]);
const DUP_DF_MAX = 3;
const DUP_TOKEN_MIN_LEN = 5;

function foldAscii(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function coNameTokens(name: string): string[] {
  return foldAscii(name.toLowerCase())
    .replace(/[()]/g, " ")
    .replace(/&/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !CO_NAME_STOPWORDS.has(t));
}

function coNameFull(name: string): string {
  return foldAscii(name.toLowerCase())
    .replace(/[()]/g, " ")
    .replace(/&/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function coNameNoParens(name: string): string {
  return foldAscii(name.toLowerCase())
    .replace(/[（(][^)）]*[)）]/g, " ")
    .replace(/&/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* 名称强匹配：归一化后相同（去括号注记）或整词包含 —— 可单独入选。 */
function nameStrongKind(na: string, nb: string): string | null {
  const da = coNameNoParens(na);
  const db = coNameNoParens(nb);
  if (da && da === db) return "名称相同";
  const ka = coNameFull(na);
  const kb = coNameFull(nb);
  if (ka && kb && ka !== kb) {
    if (kb.startsWith(ka + " ") || kb.endsWith(" " + ka) || ka.startsWith(kb + " ") || ka.endsWith(" " + kb)) {
      return "名称包含";
    }
  }
  return null;
}

/* 名称弱近似：低频专名重合（"crashboat" 是信号，"surf/sailing" 高频自动
 * 失效）—— 只作 1 项，须凑满 ≥2 项才入选。 */
function nameLowFreqMatch(na: string, nb: string, df: Map<string, number>): boolean {
  const sa = new Set(coNameTokens(na));
  const sb = new Set(coNameTokens(nb));
  let lowFreqCommon = 0;
  sa.forEach((t) => {
    if (sb.has(t) && t.length >= DUP_TOKEN_MIN_LEN && (df.get(t) ?? 0) <= DUP_DF_MAX) lowFreqCommon++;
  });
  return lowFreqCommon >= 1;
}

/* 电话/WhatsApp（同一存储字段）：去非数字、去美国国家码前缀 1；
 * 近似 = 完全相等，或双方 ≥7 位且末 7 位相同（区号/国家码写法差异）。 */
function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d;
}

function phonesOverlap(pa: Set<string>, pb: Set<string>): boolean {
  for (const p of pa) {
    if (pb.has(p)) return true;
    if (p.length >= 7) {
      const tail = p.slice(-7);
      for (const q of pb) {
        if (q.length >= 7 && q.slice(-7) === tail) return true;
      }
    }
  }
  return false;
}

/* 公司邮箱后缀：@ 后域名，排除免费邮箱域。 */
function emailSuffixOf(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  const suffix = email.slice(at + 1).trim().toLowerCase();
  return FREE_EMAIL_DOMAINS.has(suffix) ? null : suffix;
}

/* 地址近似：归一化后相等，或一方包含另一方（<4 字符不判，太短易误报）。 */
function addressMatch(aa: string | null, ab: string | null): boolean {
  const na = aa ? foldAscii(aa.toLowerCase()).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim() : "";
  const nb = ab ? foldAscii(ab.toLowerCase()).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (na.length < 4 || nb.length < 4) return false;
  return na === nb || nb.includes(na) || na.includes(nb);
}

/* 网址近似：域名核心标签（去 www./TLD）相等或一方包含另一方。 */
function domainMatch(da: string | null, db: string | null): boolean {
  if (!da || !db) return false;
  const core = (d: string) => d.toLowerCase().replace(/^www\./, "").replace(/\..*$/, "");
  const ca = core(da);
  const cb = core(db);
  return ca === cb || ca.includes(cb) || cb.includes(ca);
}

function setsOverlap<T>(sa: Set<T>, sb: Set<T>): boolean {
  for (const s of sa) {
    if (sb.has(s)) return true;
  }
  return false;
}

async function listDuplicateCompanies(env: AdminEnv): Promise<Response> {
  const { results: companies } = await env.DB.prepare(
    "SELECT id, name, domain, address FROM crm_companies",
  ).all<{ id: string; name: string; domain: string | null; address: string | null }>();
  const { results: contacts } = await env.DB.prepare(
    "SELECT company_id, full_name, email, whatsapp_or_phone, tel, cellphone, whatsapp FROM crm_contacts",
  ).all<{
    company_id: string;
    full_name: string;
    email: string | null;
    whatsapp_or_phone: string | null;
    tel: string | null;
    cellphone: string | null;
    whatsapp: string | null;
  }>();

  interface DupAgg {
    id: string;
    name: string;
    domain: string | null;
    address: string | null;
    suffixes: Set<string>;
    phones: Set<string>;
    emails: Set<string>;
    contactNames: Set<string>;
  }
  const agg = new Map<string, DupAgg>();
  for (const c of companies ?? []) {
    agg.set(c.id, {
      id: c.id,
      name: c.name,
      domain: c.domain,
      address: c.address,
      suffixes: new Set<string>(),
      phones: new Set<string>(),
      emails: new Set<string>(),
      contactNames: new Set<string>(),
    });
  }
  for (const ct of contacts ?? []) {
    const a = agg.get(ct.company_id);
    if (!a) continue;
    if (ct.email) {
      const email = ct.email.trim().toLowerCase();
      if (email.includes("@") && !email.startsWith("@") && !email.endsWith("@")) {
        a.emails.add(email);
      }
      const suffix = emailSuffixOf(ct.email);
      if (suffix) a.suffixes.add(suffix);
    }
    // 0042 电话三列 + 遗留列：每列归一化后并入同一「电话/WhatsApp」集合。
    for (const rawPhone of [ct.whatsapp_or_phone, ct.tel, ct.cellphone, ct.whatsapp]) {
      const phone = normalizePhone(rawPhone);
      if (phone) a.phones.add(phone);
    }
    const cname = foldAscii((ct.full_name ?? "").trim().toLowerCase());
    if (cname.replace(/\s/g, "").length >= 4 && !GENERIC_CONTACT_NAMES.has(cname)) {
      a.contactNames.add(cname);
    }
  }

  // 名称文档频率（低频专名自适应）
  const df = new Map<string, number>();
  for (const a of agg.values()) {
    for (const t of new Set(coNameTokens(a.name))) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const byId = new Map((companies ?? []).map((c) => [c.id, c]));
  const list = [...agg.values()];
  const pairs: DupPair[] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const strong = nameStrongKind(a.name, b.name);
      const reasons: string[] = [];
      if (strong) reasons.push(strong);
      else if (nameLowFreqMatch(a.name, b.name, df)) reasons.push("名称相似");
      if (addressMatch(a.address, b.address)) reasons.push("地址近似");
      if (phonesOverlap(a.phones, b.phones)) reasons.push("电话/WhatsApp");
      if (domainMatch(a.domain, b.domain)) reasons.push("网址近似");
      if (setsOverlap(a.suffixes, b.suffixes)) reasons.push("邮箱后缀");
      if (
        setsOverlap(a.emails, b.emails) ||
        phonesOverlap(a.phones, b.phones) ||
        setsOverlap(a.contactNames, b.contactNames)
      ) {
        reasons.push("联系人重合");
      }
      /* 名称强匹配可单独入选；其余须 ≥2 项近似。 */
      if (!strong && reasons.length < 2) continue;
      const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      const ca = byId.get(x);
      const cb = byId.get(y);
      if (!ca || !cb) continue;
      pairs.push({ a_id: x, a_name: ca.name, b_id: y, b_name: cb.name, reasons });
    }
  }
  pairs.sort(
    (p, q) => q.reasons.length - p.reasons.length || p.a_name.localeCompare(q.a_name),
  );
  return jsonResponse({ duplicates: pairs });
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
  // 0042 电话三列：tel/cellphone/whatsapp 各自独立 COALESCE 保全，互不覆盖
  //（合并前「只保一个号」的痛点）；遗留列 whatsapp_or_phone 同样保全。
  // 邮箱检测（0036）：目标邮箱原为空、被来源邮箱补齐 → 重置为待检测。
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE crm_contacts SET
         job_title = COALESCE(job_title, ?2),
         email = COALESCE(email, ?3),
         whatsapp_or_phone = COALESCE(whatsapp_or_phone, ?4),
         tel = COALESCE(tel, ?7),
         cellphone = COALESCE(cellphone, ?8),
         whatsapp = COALESCE(whatsapp, ?9),
         linkedin_url = COALESCE(linkedin_url, ?5),
         is_primary = MAX(is_primary, ?6),
         email_check_status = CASE
           WHEN email IS NULL AND ?3 IS NOT NULL THEN 'pending'
           ELSE email_check_status END
       WHERE id = ?1`,
    ).bind(
      targetId,
      source.job_title,
      source.email,
      source.whatsapp_or_phone,
      source.linkedin_url,
      source.is_primary,
      source.tel,
      source.cellphone,
      source.whatsapp,
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
  // ⑦ 多角色联系人图谱：按职位关键词自动推断采购角色（更新.txt 第 7 项）。
  const jobTitle = optString(body.job_title, "job_title", 100);
  const roleInference = inferProcurementRole(jobTitle);
  // 0042 电话三列（tel/cellphone/whatsapp 各自独立保存，同 /admin 联系人
  // 格式）。遗留 whatsapp_or_phone 键兼容：未提供 whatsapp 时写入 whatsapp
  // （老缓存面板不炸）；镜像列同步写入，老面板仍能显示电话。
  const tel = optString(body.tel, "tel", 100);
  const cellphone = optString(body.cellphone, "cellphone", 100);
  const legacyPhone = optString(body.whatsapp_or_phone, "whatsapp_or_phone", 100);
  let whatsapp = optString(body.whatsapp, "whatsapp", 100);
  if (whatsapp === null) whatsapp = legacyPhone;
  const phoneMirror = whatsapp ?? cellphone ?? tel;
  await env.DB.prepare(
    `INSERT INTO crm_contacts (id, company_id, full_name, job_title, email, whatsapp_or_phone, tel, cellphone, whatsapp, linkedin_url, is_primary, procurement_role, role_evidence, role_updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
  )
    .bind(
      id,
      companyId,
      reqString(body.full_name, "full_name", 200),
      jobTitle,
      optString(body.email, "email", 200),
      phoneMirror,
      tel,
      cellphone,
      whatsapp,
      optString(body.linkedin_url, "linkedin_url", 300),
      isPrimary ? 1 : 0,
      roleInference.role,
      roleInference.evidence,
      new Date().toISOString(),
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
    // ⑦ 联系人图谱：职位变更 → 重新推断采购角色（显式 procurement_role
    // 优先：同一次请求里带显式角色时以显式值为准，不重复推断）。
    if (!("procurement_role" in body)) {
      const inference = inferProcurementRole(optString(body.job_title, "job_title", 100));
      sets.push(
        `procurement_role = ?${sets.length + 2}`,
        `role_evidence = ?${sets.length + 3}`,
        "role_updated_at = CURRENT_TIMESTAMP",
      );
      binds.push(inference.role, inference.evidence);
    }
  }
  if ("procurement_role" in body) {
    // 显式角色：允许人工覆盖自动推断（oneOf 校验 + 依据可选）。
    const role = oneOf(body.procurement_role, PROCUREMENT_ROLES, "procurement_role") as ProcurementRole;
    sets.push(`procurement_role = ?${sets.length + 2}`);
    binds.push(role);
    if ("role_evidence" in body) {
      sets.push(`role_evidence = ?${sets.length + 2}`);
      binds.push(optString(body.role_evidence, "role_evidence", 500));
    }
    sets.push("role_updated_at = CURRENT_TIMESTAMP");
  }
  if ("email" in body) {
    sets.push(`email = ?${sets.length + 2}`);
    binds.push(optString(body.email, "email", 200));
    // 邮箱检测（0036）：邮箱新增/修改 → 重新进入检测队列。
    sets.push("email_check_status = 'pending'");
  }
  // 0042 电话三列：tel/cellphone/whatsapp 各自独立 PATCH；遗留键
  // whatsapp_or_phone 兼容（未同时提供 whatsapp 时写入 whatsapp）。
  let phoneTouched = false;
  if ("tel" in body) {
    sets.push(`tel = ?${sets.length + 2}`);
    binds.push(optString(body.tel, "tel", 100));
    phoneTouched = true;
  }
  if ("cellphone" in body) {
    sets.push(`cellphone = ?${sets.length + 2}`);
    binds.push(optString(body.cellphone, "cellphone", 100));
    phoneTouched = true;
  }
  if ("whatsapp" in body) {
    sets.push(`whatsapp = ?${sets.length + 2}`);
    binds.push(optString(body.whatsapp, "whatsapp", 100));
    phoneTouched = true;
  }
  if ("whatsapp_or_phone" in body) {
    const legacy = optString(body.whatsapp_or_phone, "whatsapp_or_phone", 100);
    sets.push(`whatsapp_or_phone = ?${sets.length + 2}`);
    binds.push(legacy);
    if (legacy !== null && !("whatsapp" in body)) {
      sets.push(`whatsapp = ?${sets.length + 2}`);
      binds.push(legacy);
    }
    phoneTouched = true;
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
  // 0042 电话字段有变更 → 镜像列同步为三列首选值（老面板仍能显示电话）。
  if (phoneTouched) {
    await env.DB.prepare(
      `UPDATE crm_contacts SET whatsapp_or_phone = COALESCE(NULLIF(whatsapp, ''), NULLIF(cellphone, ''), NULLIF(tel, '')) WHERE id = ?1`,
    )
      .bind(id)
      .run();
  }
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

/** ⑧ 任务日历（0038）：阶段推进自动生成的下一步行动
 * （null = 该阶段无自动任务：inquiry/lost 只是进入或离开漏斗）。 */
export interface NextStepTask {
  summary: string;
  dueOffsetDays: number;
}

export function nextStepTaskFor(stage: string, dealTitle: string): NextStepTask | null {
  switch (stage) {
    case "sample_quoted":
      return { summary: `跟进样品报价反馈：商机「${dealTitle}」`, dueOffsetDays: 3 };
    case "pi_sent":
      return { summary: `跟进 PI 确认与定金：商机「${dealTitle}」`, dueOffsetDays: 3 };
    case "deposit_paid":
      return { summary: `安排生产与发货节点：商机「${dealTitle}」`, dueOffsetDays: 5 };
    case "won":
      return { summary: `赢单后售后回访：商机「${dealTitle}」`, dueOffsetDays: 7 };
    default:
      return null;
  }
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
  if (stageChangedTo === "won") summary = `商机「${existing.title}」赢单 🎉（${existing.stage} → won），公司转正式客户`;
  else if (stageChangedTo === "lost") {
    const reason = lostReason ?? null;
    summary = `商机「${existing.title}」输单（${existing.stage} → lost）${reason ? `，原因: ${reason}` : ""}`;
  } else summary = `商机「${existing.title}」阶段推进: ${existing.stage} → ${stageChangedTo}`;
  await env.DB.prepare(
    `INSERT INTO crm_activities (id, company_id, deal_id, type, summary)
     VALUES (?1, ?2, ?3, 'note', ?4)`,
  )
    .bind(crypto.randomUUID(), existing.company_id, id, summary)
    .run();
  // ⑧ 任务日历（0038）：阶段推进自动生成下一步行动任务（同文案未完成任务
  // 已存在则跳过 —— 回退再推进不会堆任务）。
  const nextStep = nextStepTaskFor(stageChangedTo, existing.title);
  if (nextStep) {
    const dup = await env.DB.prepare(
      "SELECT id FROM crm_activities WHERE company_id = ?1 AND type = 'task' AND is_completed = 0 AND summary = ?2",
    )
      .bind(existing.company_id, nextStep.summary)
      .first<{ id: string }>();
    if (!dup) {
      const due = new Date(Date.now() + nextStep.dueOffsetDays * 86400000)
        .toISOString()
        .slice(0, 10);
      await env.DB.prepare(
        `INSERT INTO crm_activities (id, company_id, deal_id, type, summary, due_date)
         VALUES (?1, ?2, ?3, 'task', ?4, ?5)`,
      )
        .bind(crypto.randomUUID(), existing.company_id, id, nextStep.summary, due)
        .run();
    }
  }
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

/* ── ⑦ 商机 ↔ 联系人图谱边（crm_deal_contacts） ─────────────────────────── */

async function addDealContact(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
  dealId: string,
): Promise<Response> {
  const deal = await env.DB.prepare("SELECT * FROM crm_deals WHERE id = ?1")
    .bind(dealId)
    .first<CrmDealRow>();
  if (!deal) throw new HttpError(404, "商机不存在");
  const body = await readJsonBody(request);
  const contactId = reqString(body.contact_id, "contact_id", 64);
  const contact = await env.DB.prepare("SELECT * FROM crm_contacts WHERE id = ?1")
    .bind(contactId)
    .first<CrmContactRow>();
  if (!contact) throw new HttpError(404, "联系人不存在");
  // 图谱约束：联系人必须属于商机所在公司（跨公司关联没有业务意义）。
  if (contact.company_id !== deal.company_id) {
    throw new HttpError(400, "联系人必须属于商机所在公司");
  }
  const roleInDeal = optString(body.role_in_deal, "role_in_deal", 100);
  const dup = await env.DB.prepare(
    "SELECT id FROM crm_deal_contacts WHERE deal_id = ?1 AND contact_id = ?2",
  ).bind(dealId, contactId).first<{ id: string }>();
  if (dup) throw new HttpError(409, "该联系人已关联到此商机");
  const edgeId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO crm_deal_contacts (id, deal_id, contact_id, role_in_deal, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(edgeId, dealId, contactId, roleInDeal, new Date().toISOString())
    .run();
  await auditAdminAction(env, request, auth, "LINK_DEAL_CONTACT", "crm_deal", dealId, {
    contact_id: contactId,
    full_name: contact.full_name,
  });
  const edge = await env.DB.prepare(
    `SELECT dc.*, ct.full_name, ct.job_title, ct.procurement_role
     FROM crm_deal_contacts dc JOIN crm_contacts ct ON ct.id = dc.contact_id
     WHERE dc.id = ?1`,
  ).bind(edgeId).first<DealContactEdge>();
  return jsonResponse({ edge }, 201);
}

async function removeDealContact(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
  dealId: string,
  contactId: string,
): Promise<Response> {
  const deal = await env.DB.prepare("SELECT * FROM crm_deals WHERE id = ?1")
    .bind(dealId)
    .first<CrmDealRow>();
  if (!deal) throw new HttpError(404, "商机不存在");
  const existing = await env.DB.prepare(
    "SELECT id FROM crm_deal_contacts WHERE deal_id = ?1 AND contact_id = ?2",
  ).bind(dealId, contactId).first<{ id: string }>();
  if (!existing) throw new HttpError(404, "该联系人未关联到此商机");
  await env.DB.prepare("DELETE FROM crm_deal_contacts WHERE deal_id = ?1 AND contact_id = ?2")
    .bind(dealId, contactId)
    .run();
  await auditAdminAction(env, request, auth, "UNLINK_DEAL_CONTACT", "crm_deal", dealId, {
    contact_id: contactId,
  });
  return jsonResponse({ ok: true });
}

/* ── ⑥ 持续意向监测 HTTP handlers ───────────────────────────────────────── */

async function forceSignalCheck(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
  companyId: string,
): Promise<Response> {
  await requireCompany(env, companyId);
  let report: SignalCheckReport;
  try {
    report = await checkCompanySignals(env, companyId, { force: true });
  } catch (e) {
    throw new HttpError(404, e instanceof Error ? e.message : String(e));
  }
  await auditAdminAction(env, request, auth, "CHECK_CRM_SIGNALS", "crm_company", companyId, {
    new_signals: report.new_signals,
    tier_bumped: report.tier_bumped,
  });
  return jsonResponse({ report });
}

async function setSignalWatch(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
  companyId: string,
): Promise<Response> {
  const body = await readJsonBody(request);
  const watchEnabled = optBool(body.enabled, "enabled");
  const watchInterval = body.interval_days === undefined ? undefined : Number(body.interval_days);
  let response: Response;
  try {
    response = await updateSignalWatch(env, companyId, {
      enabled: watchEnabled ?? undefined,
      interval_days: watchInterval,
    });
  } catch (e) {
    throw new HttpError(404, e instanceof Error ? e.message : String(e));
  }
  await auditAdminAction(env, request, auth, "UPDATE_SIGNAL_WATCH", "crm_company", companyId, {
    enabled: watchEnabled ?? null,
    interval_days: watchInterval ?? null,
  });
  return response;
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
  // ⑧ 任务日历（0038）：任务负责人（用户名），可空 = 未分配。
  const owner = type === "task" ? optString(body.owner, "owner", 50) : null;
  if (type !== "task" && "owner" in body && body.owner) {
    throw new HttpError(400, "owner 只能用于 type='task'");
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO crm_activities (id, company_id, deal_id, type, summary, due_date, owner)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      id,
      companyId,
      dealId,
      // 'note' is the caller-facing name of the internal 'manual_note' log row.
      type === "note" ? "manual_note" : type,
      summary,
      dueDate,
      owner,
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
  // ⑧ 任务日历（0038）：任务负责人分配/改派。
  if ("owner" in body) {
    if (existing.type !== "task") throw new HttpError(400, "owner 只能用于任务");
    sets.push(`owner = ?${sets.length + 2}`);
    binds.push(optString(body.owner, "owner", 50));
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

interface ImportCompanyCache {
  byName: Map<string, string>; // lowercased name → id
  byDomain: Map<string, string>; // lowercased domain → id
  domainById: Map<string, string | null>; // id → domain（域名回填需知公司自身是否已有域名）
}

async function loadCompanyCache(env: AdminEnv): Promise<ImportCompanyCache> {
  const rows = await env.DB.prepare(
    "SELECT id, name, domain FROM crm_companies LIMIT 20000",
  ).all<{ id: string; name: string; domain: string | null }>();
  const cache: ImportCompanyCache = { byName: new Map(), byDomain: new Map(), domainById: new Map() };
  for (const r of rows.results) {
    cache.byName.set(r.name.toLowerCase(), r.id);
    if (r.domain) cache.byDomain.set(r.domain.toLowerCase(), r.id);
    cache.domainById.set(r.id, r.domain);
  }
  return cache;
}

interface ImportResult {
  created: number;
  skipped: number;
  errors: string[];
}

const IMPORT_ROW_LIMIT = 1000;

/** 经销/代理品牌值清洗：去掉 CSV 导入残留的包裹引号与内部双写引号。
 *  Excel 单元格里的原始文本常是 `"brandA, brandB"`（原 CSV 字段含逗号被
 *  引号包裹、引号被当作字面量保留），展示与检索前统一剥掉。 */
function cleanDealerBrandsValue(v: string): string {
  return v
    .trim()
    .replace(/^"+/, "")
    .replace(/"+$/, "")
    .replace(/""/g, '"')
    .replace(/^[,;\s]+|[,;\s]+$/g, "")
    .trim();
}

/** 0042 is_* 业务角色布尔值导入：TRUE/是/1/y → 1，其余 0（同 is_primary）。 */
function flagBit(v: string): number {
  return ["1", "true", "yes", "y", "是"].includes(v.trim().toLowerCase()) ? 1 : 0;
}

/** entity 解析：'auto'（默认）按表头自动识别，否则显式三选一。 */
function resolveImportEntity(raw: unknown, header: string[]): ImportEntity {
  if (raw === undefined || raw === null || raw === "" || raw === "auto") {
    return detectEntity(header);
  }
  return oneOf(raw, IMPORT_ENTITIES, "entity");
}

interface ImportOutcome {
  created: number;
  companiesCreated: number;
  skipped: number;
  errors: string[];
  /** 识别成功的列映射（表头原文 → 字段名），随响应回传。 */
  columns: Record<string, string>;
  /** 未识别的表头（安全忽略）。 */
  unmapped: string[];
  /** 修复模式（mode=repair）：回填了空缺字段的公司/联系人数。 */
  repairedCompanies?: number;
  repairedContacts?: number;
  /** 本次新建的公司清单（id + 名称）—— 面板据此渲染「加入待办」入口。 */
  createdCompanies?: Array<{ id: string; name: string }>;
}

/** 把已解析的行列矩阵导入 DB（CSV 与 Excel 共用核心）。
 *  repair=true 为修复模式：只回填已有公司/联系人的空缺字段（0042 电话三列、
 *  admin 对齐列、industry 归位），绝不新建任何行 —— 用于旧规则导入的存量
 *  表格重新上传修正（普通重导入会因已合并公司复活重复数据，不安全）。 */
async function runImportRows(
  entity: ImportEntity,
  rows: string[][],
  env: AdminEnv,
  repair = false,
): Promise<ImportOutcome> {
  if (rows.length < 2) throw new HttpError(400, "至少需要表头 + 一行数据");
  if (rows.length - 1 > IMPORT_ROW_LIMIT) {
    throw new HttpError(400, `最多 ${IMPORT_ROW_LIMIT} 行数据`);
  }
  if (repair && entity === "deals") {
    throw new HttpError(400, "修复模式仅支持公司 / 联系人表");
  }

  const { keyByIndex, keys } = matchColumns(entity, rows[0]);
  let missing = REQUIRED_KEYS[entity].filter((k) => !keys.has(k));
  // contacts 的姓名可由 full_name 单列或 first_name + last_name 拆分列表达。
  if (entity === "contacts" && !missing.length && !hasContactName(keys)) {
    missing = ["姓名 (姓名 / First Name / Last Name)"];
  }
  if (missing.length) {
    throw new HttpError(
      400,
      `表头无法识别必需列: ${missing.join(" / ")}。请检查表头（支持中英文，如「公司名称 / Company Name」「姓名」「Email」）`,
    );
  }
  // contacts/deals 导入时，表内公司级列（国家/官网/中文备注/产品服务）用于
  // 补全自动创建的公司 —— 用 companies 视角对同一表头再映射一遍。
  const companyMap =
    entity === "companies" ? keyByIndex : matchColumns("companies", rows[0]).keyByIndex;
  // 0042 contacts/deals 表里的电话列（tel/whatsapp）描述的是联系人本人而非
  // 公司级电话：从 companyMap 剔除，避免把联系人电话回填成公司电话
  //（companies 实体不受影响 —— 此时 companyMap 就是 keyByIndex 本身）。
  if (entity !== "companies") {
    for (let i = 0; i < companyMap.length; i++) {
      if (companyMap[i] === "tel" || companyMap[i] === "whatsapp") companyMap[i] = null;
    }
  }
  const columns: Record<string, string> = {};
  const unmapped: string[] = [];
  rows[0].forEach((h, i) => {
    const t = h.trim();
    if (!t) return;
    const key = keyByIndex[i] ?? companyMap[i];
    if (key) columns[t] = key;
    else unmapped.push(t);
  });

  // 行 → rec（智能值清洗：Website URL → 域名、Excel 日期序列号 → ISO、中文
  // 阶段 → 英文、Excel 公式错误字面量（#N/A 等）→ 空值）。
  const recFromRow = (row: string[], map: Array<string | null>): Record<string, string> => {
    const rec: Record<string, string> = {};
    for (let c = 0; c < map.length; c++) {
      const key = map[c];
      if (!key) continue;
      let v = (row[c] ?? "").trim();
      if (isExcelErrorValue(v)) v = "";
      rec[key] = v;
    }
    if (rec.domain) rec.domain = cleanDomainValue(rec.domain);
    if (rec.expected_close_date) {
      rec.expected_close_date = excelSerialToIsoDate(rec.expected_close_date);
    }
    if (rec.stage) rec.stage = normalizeStageValue(rec.stage);
    return rec;
  };
  const buildRec = (row: string[]): Record<string, string> => recFromRow(row, keyByIndex);

  const result: ImportResult = { created: 0, skipped: 0, errors: [] };
  type CrmStatement = ReturnType<AdminEnv["DB"]["prepare"]>;
  const statements: CrmStatement[] = [];
  let companiesCreated = 0;
  const createdCompanies: Array<{ id: string; name: string }> = [];
  const companies = await loadCompanyCache(env);

  // 已有公司回填 0041 扩展列（地址/外部编号/经销代理品牌）与空缺域名：只补
  // 空值（NULLIF+COALESCE），不覆盖人工修改。按「公司 × 字段」去重——多行同
  // 公司时，第一行可能只带编号没带品牌，不能因此拦掉后续行对该字段的回填。
  // 0042 admin 对齐列同样只补空值；is_* 勾选真值只升不降（置 1）。
  const enrichedFields = new Set<string>();
  const backfillCompany = (id: string, companyRec: Record<string, string>): boolean => {
    const fields: Array<[string, string]> = [
      ["address", (companyRec.address ?? "").trim()],
      ["external_id", (companyRec.external_id ?? "").trim()],
      ["dealer_brands", cleanDealerBrandsValue(companyRec.dealer_brands ?? "")],
    ];
    for (const [field] of COMPANY_TEXT_FIELDS) {
      fields.push([field, (companyRec[field] ?? "").trim()]);
    }
    const sets: string[] = [];
    const binds: unknown[] = [];
    for (const [field, value] of fields) {
      if (!value || enrichedFields.has(`${id}|${field}`)) continue;
      enrichedFields.add(`${id}|${field}`);
      sets.push(`${field} = COALESCE(NULLIF(${field}, ''), ?${binds.length + 1}, ${field})`);
      binds.push(value);
    }
    // 0042 归位修复：旧规则把「产品与服务」写进 industry（当年还没有
    // products_services 列）。回填 products_services 的同时，若 industry 仍是
    // 同一文本（且 products_services 原本为空）→ 清掉，避免同一文本存两份。
    const productsRepair = (companyRec.products_services ?? "").trim();
    if (productsRepair && !enrichedFields.has(`${id}|industry_repair`)) {
      enrichedFields.add(`${id}|industry_repair`);
      sets.push(
        `industry = CASE WHEN TRIM(IFNULL(industry, '')) != ''` +
          ` AND (products_services IS NULL OR TRIM(products_services) = '')` +
          ` AND industry = ?${binds.length + 1} THEN NULL ELSE industry END`,
      );
      binds.push(productsRepair);
    }
    // 0042 is_* 业务角色：真值导入只升不降（已有 1 不动，0 → 1）。
    for (const flag of COMPANY_ROLE_FLAGS) {
      const raw = (companyRec[flag] ?? "").trim();
      if (!raw || flagBit(raw) !== 1 || enrichedFields.has(`${id}|${flag}`)) continue;
      enrichedFields.add(`${id}|${flag}`);
      sets.push(`${flag} = 1`);
    }
    // 域名回填：官网在后续行才出现（首行是 Facebook 主页/空）时补绑；仅当
    // 公司自身无域名、且域名未被其他公司占用（含本次导入内的认领）——
    // domain 唯一约束 + 经销商共用品牌官网不可抢绑。
    const domain = (companyRec.domain ?? "").trim().toLowerCase();
    if (
      domain &&
      !companies.domainById.get(id) &&
      !companies.byDomain.has(domain) &&
      !enrichedFields.has(`${id}|domain`)
    ) {
      enrichedFields.add(`${id}|domain`);
      companies.byDomain.set(domain, id);
      companies.domainById.set(id, domain);
      sets.push(`domain = COALESCE(NULLIF(domain, ''), ?${binds.length + 1}, domain)`);
      binds.push(domain);
    }
    if (!sets.length) return false;
    statements.push(
      env.DB.prepare(
        `UPDATE crm_companies SET ${sets.join(", ")} WHERE id = ?${binds.length + 1}`,
      ).bind(...binds, id),
    );
    return true;
  };

  const resolveCompany = (
    rec: Record<string, string>,
    companyRec: Record<string, string>,
    rowIndex: number,
  ): { id: string } | { error: string } => {
    const name = (rec.company ?? "").trim();
    const domain = (companyRec.domain ?? "").trim().toLowerCase();
    if (!name && !domain) return { error: `第 ${rowIndex} 行: 缺少公司名称/域名` };
    // 名称优先匹配：真实表格中同一公司名写法一致，是更强的身份键。
    if (name && companies.byName.has(name.toLowerCase())) {
      const id = companies.byName.get(name.toLowerCase())!;
      backfillCompany(id, companyRec);
      return { id };
    }
    // 无名行才按域名兜底匹配：不同公司共享域名（经销商共用品牌官网）时
    // 不可凭域名把后到的公司并到先到的公司上。
    if (!name && domain && companies.byDomain.has(domain)) {
      const id = companies.byDomain.get(domain)!;
      backfillCompany(id, companyRec);
      return { id };
    }
    // Auto-create the company (OpenCRM import behavior): contacts/deals rows
    // name a company that does not exist yet — create it so the row imports.
    // 域名已被其他公司占用 → 不绑定（domain 唯一约束 + 归属正确性）。
    const bindDomain = domain && !companies.byDomain.has(domain) ? domain : null;
    const id = crypto.randomUUID();
    const companyName = name || domain;
    if (name) companies.byName.set(name.toLowerCase(), id);
    if (bindDomain) companies.byDomain.set(bindDomain, id);
    companies.domainById.set(id, bindDomain);
    // 0042 admin 对齐列：文本字段 + is_* 业务角色（TRUE/是/1/y → 1）。
    const textBinds: unknown[] = [];
    for (const [field] of COMPANY_TEXT_FIELDS) {
      textBinds.push((companyRec[field] ?? "").trim() || null);
    }
    const flagBinds: unknown[] = [];
    for (const flag of COMPANY_ROLE_FLAGS) {
      flagBinds.push(flagBit(companyRec[flag] ?? ""));
    }
    const newCols = [
      ...COMPANY_TEXT_FIELDS.map(([f]) => f),
      ...COMPANY_ROLE_FLAGS,
    ].join(", ");
    const firstNew = 10;
    const newPlaceholders = [
      ...COMPANY_TEXT_FIELDS.map((_, i) => `?${firstNew + i}`),
      ...COMPANY_ROLE_FLAGS.map((_, i) => `?${firstNew + COMPANY_TEXT_FIELDS.length + i}`),
    ].join(", ");
    statements.push(
      env.DB.prepare(
        `INSERT INTO crm_companies (id, name, domain, industry, country, tier, lead_status,
           chinese_remarks, address, external_id, dealer_brands, ${newCols}, source)
         VALUES (?1, ?2, ?3, ?4, ?5, 'unqualified', 'new', ?6, ?7, ?8, ?9, ${newPlaceholders}, 'csv_import')`,
      ).bind(
        id,
        companyName,
        bindDomain,
        (companyRec.industry ?? "").trim() || null,
        (companyRec.country ?? "").trim() || null,
        (companyRec.chinese_remarks ?? "").trim() || null,
        (companyRec.address ?? "").trim() || null,
        (companyRec.external_id ?? "").trim() || null,
        cleanDealerBrandsValue(companyRec.dealer_brands ?? "") || null,
        ...textBinds,
        ...flagBinds,
      ),
    );
    companiesCreated++;
    createdCompanies.push({ id, name: companyName });
    return { id };
  };

  if (repair) {
    const repairedCompanies = new Set<string>();
    const repairedContacts = new Set<string>();
    if (entity === "companies") {
      for (let i = 1; i < rows.length; i++) {
        const rec = buildRec(rows[i]);
        const rowIndex = i + 1;
        const name = (rec.name ?? "").trim();
        const domain = (rec.domain ?? "").trim().toLowerCase();
        if (!name && !domain) {
          result.errors.push(`第 ${rowIndex} 行: 缺少公司名称/域名`);
          continue;
        }
        const existingId =
          (name ? companies.byName.get(name.toLowerCase()) : undefined) ??
          (domain ? companies.byDomain.get(domain) : undefined);
        if (!existingId) {
          result.skipped++; // 不存在的公司：跳过，不新建
          continue;
        }
        if (backfillCompany(existingId, rec)) repairedCompanies.add(existingId);
      }
    } else {
      // contacts 修复：联系人按 公司+邮箱 → 全局邮箱（合并后换了公司）→
      // 公司+姓名 匹配；命中则只补空缺字段，未命中只修公司或跳过。
      interface RepairContactRow {
        id: string;
        company_id: string;
        lemail: string;
        lname: string;
        tel: string;
        cellphone: string;
        whatsapp: string;
        wop: string;
        job_title: string;
      }
      const existingContacts = await env.DB.prepare(
        "SELECT id, company_id, LOWER(IFNULL(email, '')) AS lemail, LOWER(full_name) AS lname," +
          " IFNULL(tel, '') AS tel, IFNULL(cellphone, '') AS cellphone, IFNULL(whatsapp, '') AS whatsapp," +
          " IFNULL(whatsapp_or_phone, '') AS wop, IFNULL(job_title, '') AS job_title" +
          " FROM crm_contacts LIMIT 50000",
      ).all<RepairContactRow>();
      const byCompanyEmail = new Map<string, RepairContactRow>();
      const byCompanyName = new Map<string, RepairContactRow>();
      const byEmail = new Map<string, RepairContactRow>();
      for (const r of existingContacts.results) {
        if (r.lemail) {
          byCompanyEmail.set(`${r.company_id}|${r.lemail}`, r);
          if (!byEmail.has(r.lemail)) byEmail.set(r.lemail, r);
        }
        byCompanyName.set(`${r.company_id}|n|${r.lname}`, r);
      }
      for (let i = 1; i < rows.length; i++) {
        const rec = buildRec(rows[i]);
        const companyRec = recFromRow(rows[i], companyMap);
        const rowIndex = i + 1;
        let fullName = (rec.full_name ?? "").trim();
        if (!fullName) {
          fullName = [(rec.first_name ?? "").trim(), (rec.last_name ?? "").trim()]
            .filter(Boolean)
            .join(" ");
        }
        const name = (rec.company ?? "").trim();
        const domain = (companyRec.domain ?? "").trim().toLowerCase();
        // 公司匹配（不新建）：名称优先，域名兜底。
        const companyId =
          (name ? companies.byName.get(name.toLowerCase()) : undefined) ??
          (domain ? companies.byDomain.get(domain) : undefined) ??
          null;
        const emailRaw = (rec.email ?? "").trim();
        const email = emailRaw.toLowerCase();
        let matched: RepairContactRow | undefined;
        if (email && companyId) matched = byCompanyEmail.get(`${companyId}|${email}`);
        if (!matched && email) matched = byEmail.get(email);
        if (!matched && !email && companyId) {
          matched = byCompanyName.get(`${companyId}|n|${fullName.toLowerCase()}`);
        }
        if (!matched) {
          // 联系人未命中：公司命中 → 只修公司；都未命中 → 跳过
          // （合并后已删除的源公司绝不复活）。
          if (companyId && backfillCompany(companyId, companyRec)) {
            repairedCompanies.add(companyId);
          }
          result.skipped++;
          continue;
        }
        if (companyId && backfillCompany(companyId, companyRec)) {
          repairedCompanies.add(companyId);
        }
        // 0042 电话归位：只补空缺；旧导入塌缩进遗留列的 TEL/手机号
        // （迁移时镜像到了 whatsapp）在表内 WhatsApp 为空且与 tel/cellphone
        // 同值时清空归位 —— 号码已在正确的列里，不再冒充 WhatsApp。
        const newTel = (rec.tel ?? "").trim();
        const newCell = (rec.cellphone ?? "").trim();
        const newWa = (rec.whatsapp ?? "").trim();
        const dbTel = matched.tel.trim();
        const dbCell = matched.cellphone.trim();
        const dbWa = matched.whatsapp.trim();
        const dbWop = matched.wop.trim();
        const finalTel = dbTel || newTel;
        const finalCell = dbCell || newCell;
        let finalWa = dbWa || newWa;
        if (!newWa && dbWa && dbWa === dbWop && (dbWa === newTel || dbWa === newCell)) {
          finalWa = "";
        }
        const finalMirror = finalWa || finalCell || finalTel;
        const sets: string[] = [];
        const binds: unknown[] = [];
        const setCol = (col: string, v: string): void => {
          sets.push(`${col} = ?${binds.length + 1}`);
          binds.push(v || null);
        };
        if (finalTel !== dbTel) setCol("tel", finalTel);
        if (finalCell !== dbCell) setCol("cellphone", finalCell);
        if (finalWa !== dbWa) setCol("whatsapp", finalWa);
        if (!dbWop && finalMirror) setCol("whatsapp_or_phone", finalMirror);
        if (!matched.lemail && emailRaw) setCol("email", emailRaw);
        const newJob = (rec.job_title ?? "").trim();
        if (!matched.job_title.trim() && newJob) setCol("job_title", newJob);
        if (sets.length) {
          statements.push(
            env.DB.prepare(
              `UPDATE crm_contacts SET ${sets.join(", ")} WHERE id = ?${binds.length + 1}`,
            ).bind(...binds, matched.id),
          );
          repairedContacts.add(matched.id);
        }
      }
    }
    for (let i = 0; i < statements.length; i += 50) {
      await env.DB.batch(statements.slice(i, i + 50));
    }
    return {
      created: 0,
      companiesCreated: 0,
      skipped: result.skipped,
      errors: result.errors,
      columns,
      unmapped,
      repairedCompanies: repairedCompanies.size,
      repairedContacts: repairedContacts.size,
    };
  }

  if (entity === "companies") {
    for (let i = 1; i < rows.length; i++) {
      const rec = buildRec(rows[i]);
      const rowIndex = i + 1;
      const name = (rec.name ?? "").trim();
      const domain = (rec.domain ?? "").trim().toLowerCase();
      if (!name) {
        result.errors.push(`第 ${rowIndex} 行: 缺少公司名称`);
        continue;
      }
      if (companies.byName.has(name.toLowerCase()) || (domain && companies.byDomain.has(domain))) {
        // 已存在：回填 0041 扩展列的空值（地址/编号/经销品牌）。
        const existingId =
          companies.byName.get(name.toLowerCase()) ??
          (domain ? companies.byDomain.get(domain) : undefined);
        if (existingId) backfillCompany(existingId, rec);
        result.skipped++;
        continue;
      }
      const tierRaw = (rec.tier ?? "").trim();
      const tier = (TIERS as readonly string[]).includes(tierRaw) ? tierRaw : "unqualified";
      const id = crypto.randomUUID();
      companies.byName.set(name.toLowerCase(), id);
      if (domain) companies.byDomain.set(domain, id);
      companies.domainById.set(id, domain || null);
      // 0042 admin 对齐列：文本字段 + is_* 业务角色（TRUE/是/1/y → 1）。
      const textBinds: unknown[] = [];
      for (const [field] of COMPANY_TEXT_FIELDS) {
        textBinds.push((rec[field] ?? "").trim() || null);
      }
      const flagBinds: unknown[] = [];
      for (const flag of COMPANY_ROLE_FLAGS) {
        flagBinds.push(flagBit(rec[flag] ?? ""));
      }
      const newCols = [
        ...COMPANY_TEXT_FIELDS.map(([f]) => f),
        ...COMPANY_ROLE_FLAGS,
      ].join(", ");
      const firstNew = 11;
      const newPlaceholders = [
        ...COMPANY_TEXT_FIELDS.map((_, i) => `?${firstNew + i}`),
        ...COMPANY_ROLE_FLAGS.map((_, i) => `?${firstNew + COMPANY_TEXT_FIELDS.length + i}`),
      ].join(", ");
      statements.push(
        env.DB.prepare(
          `INSERT INTO crm_companies (id, name, domain, industry, country, tier, lead_status,
             chinese_remarks, address, external_id, dealer_brands, ${newCols}, source)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'new', ?7, ?8, ?9, ?10, ${newPlaceholders}, 'csv_import')`,
        ).bind(
          id,
          name,
          domain || null,
          (rec.industry ?? "").trim() || null,
          (rec.country ?? "").trim() || null,
          tier,
          (rec.chinese_remarks ?? "").trim() || null,
          (rec.address ?? "").trim() || null,
          (rec.external_id ?? "").trim() || null,
          cleanDealerBrandsValue(rec.dealer_brands ?? "") || null,
          ...textBinds,
          ...flagBinds,
        ),
      );
      result.created++;
      createdCompanies.push({ id, name });
    }
  } else if (entity === "contacts") {
    // Dedupe key: same company + same email (when present)；无邮箱行按
    // 公司 + 姓名去重（重复导入同一张表不会重复建联系人）。
    const existing = await env.DB.prepare(
      "SELECT company_id, LOWER(IFNULL(email, '')) AS lemail, LOWER(full_name) AS lname FROM crm_contacts LIMIT 50000",
    ).all<{ company_id: string; lemail: string; lname: string }>();
    const seen = new Set<string>();
    for (const r of existing.results) {
      seen.add(`${r.company_id}|${r.lemail}`);
      seen.add(`${r.company_id}|n|${r.lname}`);
    }
    for (let i = 1; i < rows.length; i++) {
      const rec = buildRec(rows[i]);
      const companyRec = recFromRow(rows[i], companyMap);
      const rowIndex = i + 1;
      // 姓名：完整姓名列优先；拆分列（First Name + Last Name）拼接。
      let fullName = (rec.full_name ?? "").trim();
      if (!fullName) {
        fullName = [(rec.first_name ?? "").trim(), (rec.last_name ?? "").trim()]
          .filter(Boolean)
          .join(" ");
      }
      // 公司先落库：无联系人姓名的公司行（只有公司数据）也要完整导入。
      const resolved = resolveCompany(rec, companyRec, rowIndex);
      if ("error" in resolved) {
        result.errors.push(resolved.error);
        continue;
      }
      if (!fullName) {
        result.skipped++; // 公司行（无联系人）：公司已入库，本行无联系人可建
        continue;
      }
      const email = (rec.email ?? "").trim().toLowerCase();
      if (email && seen.has(`${resolved.id}|${email}`)) {
        result.skipped++;
        continue;
      }
      if (!email && seen.has(`${resolved.id}|n|${fullName.toLowerCase()}`)) {
        result.skipped++;
        continue;
      }
      if (email) seen.add(`${resolved.id}|${email}`);
      seen.add(`${resolved.id}|n|${fullName.toLowerCase()}`);
      const isPrimary = ["1", "true", "是", "y", "yes"].includes((rec.is_primary ?? "").trim().toLowerCase())
        ? 1
        : 0;
      // 0042 电话三列独立入库（tel/cellphone/whatsapp 各自保存），遗留列
      // whatsapp_or_phone 镜像首选值（老面板兼容），不再三档合并互抢。
      const tel = (rec.tel ?? "").trim() || null;
      const cellphone = (rec.cellphone ?? "").trim() || null;
      const whatsapp = (rec.whatsapp ?? "").trim() || null;
      const phoneMirror = whatsapp ?? cellphone ?? tel;
      statements.push(
        env.DB.prepare(
          `INSERT INTO crm_contacts (id, company_id, full_name, job_title, email, whatsapp_or_phone, tel, cellphone, whatsapp, linkedin_url, is_primary)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        ).bind(
          crypto.randomUUID(),
          resolved.id,
          fullName,
          (rec.job_title ?? "").trim() || null,
          (rec.email ?? "").trim() || null,
          phoneMirror,
          tel,
          cellphone,
          whatsapp,
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
      const rec = buildRec(rows[i]);
      const companyRec = recFromRow(rows[i], companyMap);
      const rowIndex = i + 1;
      const title = (rec.title ?? "").trim();
      if (!title) {
        result.errors.push(`第 ${rowIndex} 行: 缺少商机名称`);
        continue;
      }
      const resolved = resolveCompany(rec, companyRec, rowIndex);
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
  return {
    created: result.created,
    companiesCreated,
    skipped: result.skipped,
    errors: result.errors,
    columns,
    unmapped,
    createdCompanies: createdCompanies.slice(0, 500),
  };
}

/** 统一导入响应（含识别到的实体、列映射与未识别表头；修复模式附带修复计数）。 */
function importResponse(outcome: ImportOutcome, entity: ImportEntity): Response {
  const payload: Record<string, unknown> = {
    created: outcome.created,
    companies_created: outcome.companiesCreated,
    created_companies: outcome.createdCompanies ?? [],
    skipped: outcome.skipped,
    error_total: outcome.errors.length,
    errors: outcome.errors.slice(0, 20),
    entity_used: entity,
    columns: outcome.columns,
    unmapped: outcome.unmapped,
  };
  if (outcome.repairedContacts !== undefined || outcome.repairedCompanies !== undefined) {
    payload.mode = "repair";
    payload.repaired_contacts = outcome.repairedContacts ?? 0;
    payload.repaired_companies = outcome.repairedCompanies ?? 0;
  }
  return jsonResponse(payload);
}

/** POST /admin/api/crm/import — CSV 文本（粘贴或前端读取的文件内容）。 */
async function importCrmCsv(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
): Promise<Response> {
  const body = await readJsonBody(request);
  // Excel 上传走同一入口（body 带 xlsx_base64 字段时切换到 xlsx 分支；
  // body 只读一次，避免二次消费 Request 流）。
  if (typeof body.xlsx_base64 === "string" && body.xlsx_base64) {
    return await importCrmExcel(body, request, env, auth);
  }
  const csv = reqString(body.csv, "csv", 400_000);
  const rows = parseCsv(csv);
  const entity = resolveImportEntity(body.entity, rows[0] ?? []);
  const repair = body.mode === "repair";
  const outcome = await runImportRows(entity, rows, env, repair);
  await auditAdminAction(env, request, auth, "CRM_CSV_IMPORT", `crm_${entity}`, null, {
    rows: rows.length - 1,
    created: outcome.created,
    skipped: outcome.skipped,
    errors: outcome.errors.length,
    ...(repair ? { mode: "repair", repaired: (outcome.repairedContacts ?? 0) + (outcome.repairedCompanies ?? 0) } : {}),
  });
  return importResponse(outcome, entity);
}

/** POST /admin/api/crm/import — Excel(.xlsx)：base64 → 解析 → 同一核心导入。 */
async function importCrmExcel(
  body: Record<string, unknown>,
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
): Promise<Response> {
  const b64 = reqString(body.xlsx_base64, "xlsx_base64", 2_800_000);
  const bytes = decodeBase64(b64);
  // D0 CF = 旧版 OLE2 .xls（Excel 97-2003）文件头 —— 明确提示另存为 .xlsx。
  if (bytes.length > 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf) {
    throw new HttpError(400, "暂不支持旧版 .xls：请在 Excel/WPS 中「另存为 .xlsx」后重新导入");
  }
  let rows: string[][];
  try {
    rows = await parseXlsx(bytes);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : "xlsx 解析失败");
  }
  const entity = resolveImportEntity(body.entity, rows[0] ?? []);
  const repair = body.mode === "repair";
  const outcome = await runImportRows(entity, rows, env, repair);
  await auditAdminAction(env, request, auth, "CRM_EXCEL_IMPORT", `crm_${entity}`, null, {
    rows: rows.length - 1,
    created: outcome.created,
    skipped: outcome.skipped,
    errors: outcome.errors.length,
    ...(repair ? { mode: "repair", repaired: (outcome.repairedContacts ?? 0) + (outcome.repairedCompanies ?? 0) } : {}),
  });
  return importResponse(outcome, entity);
}


/* ── 多步销售序列 HTTP handlers（引擎在 src/sequences.ts） ───────────────── */

async function createSequence(request: Request, env: AdminEnv, auth: AdminAuthContext): Promise<Response> {
  const body = await readJsonBody(request);
  const name = reqString(body.name, "name", 100);
  const brandName = reqString(body.brand_name, "brand_name", 100);
  let created: { id: string; steps: number };
  try {
    created = await createSequenceInDb(env, {
      name,
      brand_name: brandName,
      steps: Array.isArray(body.steps) ? body.steps : [],
    });
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  await auditAdminAction(env, request, auth, "CREATE_CRM_SEQUENCE", "crm_sequence", created.id, {
    name,
    steps: created.steps,
  });
  return jsonResponse({ sequence: { id: created.id, steps: created.steps } }, 201);
}

async function updateSequence(request: Request, env: AdminEnv, auth: AdminAuthContext, id: string): Promise<Response> {
  const body = await readJsonBody(request);
  const enabled = optBool(body.enabled, "enabled");
  try {
    if (enabled !== null) await setSequenceEnabledInDb(env, id, enabled);
    else throw new Error("仅支持 enabled 布尔字段");
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  await auditAdminAction(env, request, auth, "UPDATE_CRM_SEQUENCE", "crm_sequence", id, { enabled });
  return jsonResponse({ ok: true });
}

async function deleteSequence(request: Request, env: AdminEnv, auth: AdminAuthContext, id: string): Promise<Response> {
  try {
    await deleteSequenceInDb(env, id);
  } catch (e) {
    throw new HttpError(404, e instanceof Error ? e.message : String(e));
  }
  await auditAdminAction(env, request, auth, "DELETE_CRM_SEQUENCE", "crm_sequence", id, null);
  return jsonResponse({ ok: true });
}

async function enrollCompanyInSequence(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
  sequenceId: string,
): Promise<Response> {
  const body = await readJsonBody(request);
  const companyId = reqString(body.company_id, "company_id", 64);
  const requested: { contact_id?: string; contact_email?: string } = {};
  const contactId = optString(body.contact_id, "contact_id", 64);
  if (contactId) requested.contact_id = contactId;
  const contactEmail = optString(body.contact_email, "contact_email", 200);
  if (contactEmail) requested.contact_email = contactEmail;
  let r: Awaited<ReturnType<typeof enrollInSequence>>;
  try {
    r = await enrollInSequence(env, sequenceId, companyId, requested);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  await auditAdminAction(env, request, auth, "CRM_SEQUENCE_ENROLL", "crm_sequence_enrollment", r.enrollment.id, {
    sequence_id: sequenceId,
    company_id: companyId,
    contact_email: r.enrollment.contact_email,
  });
  return jsonResponse({ enrollment: r.enrollment, re_enrolled: r.reEnrolled }, 201);
}

async function updateEnrollment(request: Request, env: AdminEnv, auth: AdminAuthContext, id: string): Promise<Response> {
  const body = await readJsonBody(request);
  const status = oneOf(body.status, ["active", "paused", "stopped"] as const, "status");
  const reason = optString(body.reason, "reason", 300);
  try {
    await setEnrollmentStatusInDb(env, id, status, reason);
  } catch (e) {
    throw new HttpError(404, e instanceof Error ? e.message : String(e));
  }
  await auditAdminAction(env, request, auth, "UPDATE_CRM_ENROLLMENT", "crm_sequence_enrollment", id, {
    status,
    reason,
  });
  return jsonResponse({ ok: true });
}


/* ── 邮箱/域名检测 HTTP handlers（引擎在 src/email-verify.ts） ───────────── */

function checkToSummary(check: DomainCheckResult): Record<string, unknown> {
  return {
    domain: check.domain,
    verdict: check.verdict,
    mx_provider: check.mx_provider,
    has_mx_record: check.has_mx_record,
    has_a_record: check.has_a_record,
    has_spf_record: check.has_spf_record,
    feedback_notes: check.feedback_notes,
  };
}

async function recheckCompanyDomain(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
  id: string,
): Promise<Response> {
  let check: DomainCheckResult;
  try {
    check = await recheckCompanyDomainInDb(env, id);
  } catch (e) {
    throw new HttpError(404, e instanceof Error ? e.message : String(e));
  }
  await auditAdminAction(env, request, auth, "RECHECK_COMPANY_DOMAIN", "crm_company", id, {
    domain: check.domain,
    verdict: check.verdict,
  });
  return jsonResponse({ check: checkToSummary(check) });
}

async function recheckContactEmail(
  request: Request,
  env: AdminEnv,
  auth: AdminAuthContext,
  id: string,
): Promise<Response> {
  let check: DomainCheckResult;
  try {
    check = await recheckContactEmailInDb(env, id);
  } catch (e) {
    throw new HttpError(404, e instanceof Error ? e.message : String(e));
  }
  await auditAdminAction(env, request, auth, "RECHECK_CONTACT_EMAIL", "crm_contact", id, {
    verdict: check.verdict,
  });
  return jsonResponse({ check: checkToSummary(check) });
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
      const sub = parts[5] ?? "";
      if (!id && method === "GET") return await listCompanies(url, env);
      if (!id && method === "POST") return await createCompany(request, env, auth);
      if (id === "promote" && method === "POST") return await promoteLead(request, env, auth);
      if (id === "merge" && method === "POST") return await mergeCompanies(request, env, auth);
      if (id === "duplicates" && method === "GET") return await listDuplicateCompanies(env);
      if (id && sub === "recheck-domain" && method === "POST") return await recheckCompanyDomain(request, env, auth, id);
      // ⑥ 持续意向监测：companies/:id/check-signals 立即检查；companies/:id/watch 改监测配置。
      if (id && sub === "check-signals" && method === "POST") return await forceSignalCheck(request, env, auth, id);
      if (id && sub === "watch" && method === "PATCH") return await setSignalWatch(request, env, auth, id);
      if (id && method === "GET") return await getCompany(env, id);
      if (id && method === "PATCH") return await updateCompany(request, env, auth, id);
      if (id && method === "DELETE") return await deleteCompany(request, env, auth, id);
    } else if (resource === "contacts") {
      const sub = parts[5] ?? "";
      if (id === "merge" && method === "POST") return await mergeContacts(request, env, auth);
      if (!id && method === "POST") return await createContact(request, env, auth);
      if (id && sub === "recheck-email" && method === "POST") return await recheckContactEmail(request, env, auth, id);
      if (id && method === "PATCH") return await updateContact(request, env, id);
      if (id && method === "DELETE") return await deleteContact(env, id);
    } else if (resource === "domains") {
      if (!id && method === "GET") return await listDomainChecks(env);
    } else if (resource === "deals") {
      const sub = parts[5] ?? "";
      if (!id && method === "GET") return await listDeals(env, url);
      if (!id && method === "POST") return await createDeal(request, env, auth);
      // ⑦ 图谱边：POST deals/:id/contacts 关联联系人；DELETE deals/:id/contacts/:cid 解除。
      if (id && sub === "contacts" && method === "POST") return await addDealContact(request, env, auth, id);
      if (id && sub === "contacts" && method === "DELETE") return await removeDealContact(request, env, auth, id, parts[6] ?? "");
      if (id && method === "PATCH") return await updateDeal(request, env, id);
      if (id && method === "DELETE") return await deleteDeal(request, env, auth, id);
    } else if (resource === "signals") {
      // ⑥ 持续意向监测：总览（监测列表 + 最近信号）。
      if (!id && method === "GET") return await listSignalOverview(env);
    } else if (resource === "attribution") {
      // ⑤ 来源归因（0038）：来源/国家/行业/角色/序列五维 ROI 总览。
      if (!id && method === "GET") return await getAttribution(env);
    } else if (resource === "calendar") {
      // ⑧ 任务日历（0038）：月视图 + 逾期 + 今日待办。
      if (!id && method === "GET") return await getTaskCalendar(env, url);
    } else if (resource === "calendar.ics") {
      // ⑧ 任务日历（0038）：RFC 5545 日历订阅源（日历同步）。
      if (method === "GET") return await buildIcsFeed(env);
    } else if (resource === "activities") {
      if (!id && method === "GET") return await listOpenTasks(env, url);
      if (!id && method === "POST") return await createActivity(request, env, auth);
      if (id && method === "PATCH") return await updateActivity(request, env, id);
      if (id && method === "DELETE") return await deleteActivity(env, id);
    } else if (resource === "sequences") {
      const sub = parts[5] ?? "";
      if (!id && method === "GET") return await listSequencesWithCounts(env);
      if (!id && method === "POST") return await createSequence(request, env, auth);
      if (id && sub === "enroll" && method === "POST") return await enrollCompanyInSequence(request, env, auth, id);
      if (id && sub === "enrollments" && method === "GET") return await listEnrollmentsFor(env, id);
      if (id && method === "PATCH") return await updateSequence(request, env, auth, id);
      if (id && method === "DELETE") return await deleteSequence(request, env, auth, id);
    } else if (resource === "enrollments") {
      if (id && method === "PATCH") return await updateEnrollment(request, env, auth, id);
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
