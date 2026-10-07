import { AdminEnv } from "./admin";
import { LEAD_SCORE_DIMENSIONS, LEAD_SCORE_WEIGHTS, type LeadScoreDimension } from "./lead-score-dims";
import { generateOutreachForCustomerIds, generateOutreachForContactIds, attachmentLangForCountry } from "./outreach";
import { getQuota, sendOutreachEmail, sendDelayMs, GmailConfigError } from "./gmail";
import { sendWithStateMachine, type StateSendResult } from "./outreach-send";
import { acquireCampaignLock, CampaignLockedError } from "./campaign-lock";

/* ── 定向群发 (targeted outreach campaigns) ──────────────────────────────────
 *
 * 三层结构：
 *   SegmentFilters  海选条件（与 /admin 海选过滤器共用同一套 SQL 构造器）
 *   outreach_groups 可复用的命名客群，存一份 filters JSON
 *   outreach_campaigns + _members
 *                   一次性群发任务，创建时把命中的 customer.id 快照进
 *                   members 表，之后每一步（生成 / 发送）都以 members 的
 *                   status 作为续跑游标，因此关掉页面随时可以接着发。
 *
 * 快照而非每次重跑筛选：管道会持续把客户从 pending 研究成 completed，
 * 边发边变会导致「预览时的 N 家」和「实际发到的 N 家」对不上。
 */

/* Guards: every value is bound as a SQL parameter, so these only bound query
 * size and storage, not injection. */
const MAX_FILTER_VALUES = 10;
const MAX_VALUE_LENGTH = 50;
const MAX_KEYWORDS = 5;
const MAX_CUSTOMER_IDS = 500;
const MAX_CAMPAIGN_SIZE = 2000;
const MAX_GROUP_FILTER_BYTES = 4_000;

export interface SegmentFilters {
  countries: string[];
  segments: string[];
  products: string[];
  keywords: string[];
  minLeadScore: number;
  hasEmail: boolean;
  /** Exclude customers already emailed with this brand (dedupe per brand). */
  excludeSent: boolean;
  /** Manual pick from the customer list; AND-ed with the filters above. */
  customerIds: number[];
  /** Phase 6 (design §2.1): only companies whose CURRENT research run
   * produced buying signals (EXISTS over research_signals, is_current = 1). */
  hasBuyingSignal: boolean;
  /** Phase 6 (design §2.2): per-dimension minimums over the six lead-score
   * dimensions (json_extract on customers.lead_score_breakdown). A NULL
   * breakdown reads as 0 — a floor asserts knowledge. */
  dimensionFloors: Partial<Record<LeadScoreDimension, number>>;
  /** Phase 8 (design §2.1): only companies whose CURRENT research run
   * produced a buyer persona with one of these exact persona_role values
   * (EXISTS over research_personas, is_current = 1). Empty = no filter. */
  personaRoles: string[];
  /** Phase 8 (design §2.2): per-person grain — members carry a contact_id
   * and drafts go to that contact's own address. Stored inside the filters
   * JSON so the campaign's grain is derivable from its single data source
   * (the panel restores it from the same JSON). Default false = company
   * grain, the pre-Phase-8 behavior. */
  perPerson: boolean;
}

export const EMPTY_FILTERS: SegmentFilters = {
  countries: [],
  segments: [],
  products: [],
  keywords: [],
  minLeadScore: 0,
  hasEmail: true,
  excludeSent: true,
  customerIds: [],
  hasBuyingSignal: false,
  dimensionFloors: {},
  personaRoles: [],
  perPerson: false,
};

function sanitizeList(value: unknown, max: number, label: string): string[] {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : (() => { throw new Error(`${label} 必须是数组或逗号分隔字符串`); })();
  const cleaned = raw
    .map((v) => String(v ?? "").trim().slice(0, MAX_VALUE_LENGTH))
    .filter(Boolean);
  if (cleaned.length > max) throw new Error(`${label} 最多 ${max} 个`);
  return [...new Set(cleaned)];
}

function sanitizeIds(value: unknown): number[] {
  if (value === undefined || value === null || value === "") return [];
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : (() => { throw new Error("customerIds 必须是数组或逗号分隔字符串"); })();
  const ids = raw
    .map((v) => Number(String(v).trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  if (ids.length > MAX_CUSTOMER_IDS) throw new Error(`手工勾选最多 ${MAX_CUSTOMER_IDS} 家`);
  return [...new Set(ids)];
}

/** Phase 6 (design §2.2): validate per-dimension floors against the pinned
 * Phase 5 weights (single server-side home: lead-score-dims). Unknown keys
 * are typos — rejected, not ignored; zero floors are dropped (no-op);
 * out-of-range values are rejected like min_lead_score. */
function sanitizeDimensionFloors(value: unknown): Partial<Record<LeadScoreDimension, number>> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dimension_floors 必须是 JSON 对象");
  }
  const raw = value as Record<string, unknown>;
  const floors: Partial<Record<LeadScoreDimension, number>> = {};
  for (const key of Object.keys(raw)) {
    if (!(LEAD_SCORE_DIMENSIONS as readonly string[]).includes(key)) {
      throw new Error(`dimension_floors 未知维度: ${key.slice(0, 50)}`);
    }
    const dim = key as LeadScoreDimension;
    const num = Number(raw[key]);
    const max = LEAD_SCORE_WEIGHTS[dim];
    if (!Number.isInteger(num) || num < 0 || num > max) {
      throw new Error(`${dim} 门槛必须在 0-${max} 之间`);
    }
    if (num > 0) floors[dim] = num;
  }
  return floors;
}

/** Parse + validate an untrusted filter payload (API body or stored JSON). */
export function parseSegmentFilters(input: unknown): SegmentFilters {
  if (input === undefined || input === null) return { ...EMPTY_FILTERS };
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("filters 必须是 JSON 对象");
  }
  const raw = input as Record<string, unknown>;
  const minLeadScore = Number(raw.min_lead_score ?? raw.minLeadScore ?? 0) || 0;
  if (!Number.isFinite(minLeadScore) || minLeadScore < 0 || minLeadScore > 100) {
    throw new Error("min_lead_score 必须在 0-100 之间");
  }
  return {
    countries: sanitizeList(raw.countries, MAX_FILTER_VALUES, "countries"),
    segments: sanitizeList(raw.segments, MAX_FILTER_VALUES, "segments"),
    products: sanitizeList(raw.products, MAX_FILTER_VALUES, "products"),
    keywords: sanitizeList(raw.keywords, MAX_KEYWORDS, "keywords"),
    minLeadScore: Math.floor(minLeadScore),
    hasEmail: raw.has_email === undefined ? true : raw.has_email !== false && raw.has_email !== 0,
    excludeSent: raw.exclude_sent === undefined ? true : raw.exclude_sent !== false && raw.exclude_sent !== 0,
    customerIds: sanitizeIds(raw.customer_ids ?? raw.customerIds),
    hasBuyingSignal: raw.has_buying_signal === undefined
      ? false
      : raw.has_buying_signal !== false && raw.has_buying_signal !== 0,
    dimensionFloors: sanitizeDimensionFloors(raw.dimension_floors ?? raw.dimensionFloors),
    personaRoles: sanitizeList(raw.persona_roles ?? raw.personaRoles, MAX_FILTER_VALUES, "persona_roles"),
    perPerson: raw.per_person === undefined
      ? false
      : raw.per_person !== false && raw.per_person !== 0,
  };
}

export function serializeFilters(f: SegmentFilters): string {
  return JSON.stringify({
    countries: f.countries,
    segments: f.segments,
    products: f.products,
    keywords: f.keywords,
    min_lead_score: f.minLeadScore,
    has_email: f.hasEmail,
    exclude_sent: f.excludeSent,
    customer_ids: f.customerIds,
    has_buying_signal: f.hasBuyingSignal,
    dimension_floors: f.dimensionFloors,
    persona_roles: f.personaRoles,
    per_person: f.perPerson,
  });
}

export function deserializeFilters(raw: string | null): SegmentFilters {
  if (!raw) return { ...EMPTY_FILTERS };
  try {
    return parseSegmentFilters(JSON.parse(raw));
  } catch {
    return { ...EMPTY_FILTERS };
  }
}

/* ── Shared SQL builder (海选 + 群发预览共用) ─────────────────────────────
 * The /admin 海选过滤器 and the campaign preview must agree, so both build
 * their WHERE clause here. `requireCompleted` means "the research pipeline has
 * already produced a profile"; `requireEmail` means "has a recipient we can
 * actually send to". `table` is the alias the caller queries under ("" or
 * "c"), so the same builder works for both bare and joined selects. */
export function buildSegmentWhere(
  filters: SegmentFilters,
  opts: { requireCompleted: boolean; requireEmail: boolean; brandName?: string | null; table?: string },
): { where: string[]; binds: Array<string | number> } {
  const t = opts.table ? `${opts.table}.` : "";
  const where: string[] = [];
  const binds: Array<string | number> = [];

  if (opts.requireCompleted) where.push(`${t}status = 'completed'`);
  if (opts.requireEmail) where.push(`(${t}email IS NOT NULL AND ${t}email != '')`);

  if (filters.countries.length) {
    where.push(`(${filters.countries.map(() => `${t}country LIKE ?`).join(" OR ")})`);
    filters.countries.forEach((c) => binds.push(`%${c}%`));
  }
  if (filters.segments.length) {
    where.push(`(${filters.segments.map(() => `${t}customer_segment LIKE ?`).join(" OR ")})`);
    filters.segments.forEach((s) => binds.push(`%${s}%`));
  }
  if (filters.products.length) {
    where.push(
      `(${filters.products
        .map(() => `(${t}product_categories LIKE ? OR ${t}products_services LIKE ?)`)
        .join(" OR ")})`,
    );
    filters.products.forEach((p) => binds.push(`%${p}%`, `%${p}%`));
  }
  if (filters.keywords.length) {
    where.push(
      `(${filters.keywords
        .map(() => `(${t}company_name LIKE ? OR ${t}description LIKE ? OR ${t}business_tag LIKE ?)`)
        .join(" OR ")})`,
    );
    filters.keywords.forEach((k) => binds.push(`%${k}%`, `%${k}%`, `%${k}%`));
  }
  if (filters.minLeadScore > 0) {
    where.push(`${t}lead_score >= ?`);
    binds.push(filters.minLeadScore);
  }
  // Phase 6 (design §2.1): only companies whose CURRENT research run
  // produced buying signals. The outer reference MUST be explicitly
  // qualified — inside the EXISTS an unqualified customer_id would resolve
  // to the inner research_signals column (always-true self-comparison,
  // matching every company as soon as any signal row exists anywhere).
  // Bare mode uses the original table name (no alias to shadow it);
  // aliased mode must use the alias (SQLite forbids the original name
  // once aliased).
  if (filters.hasBuyingSignal) {
    const outer = opts.table ? `${opts.table}.company_id` : `customers.company_id`;
    where.push(
      `EXISTS (SELECT 1 FROM research_signals rs WHERE rs.customer_id = ${outer} AND rs.is_current = 1)`,
    );
  }
  // Phase 8 (design §2.1): companies whose current persona set contains one
  // of these exact persona_role values (typed by one writer, Stage 41 —
  // exact IN, not LIKE, to avoid over-matching free text). Same correlated-
  // safe qualification rule as hasBuyingSignal above.
  if (filters.personaRoles.length) {
    const outer = opts.table ? `${opts.table}.company_id` : `customers.company_id`;
    where.push(
      `EXISTS (SELECT 1 FROM research_personas rp WHERE rp.customer_id = ${outer} AND rp.is_current = 1 AND rp.persona_role IN (${filters.personaRoles.map(() => "?").join(",")}))`,
    );
    filters.personaRoles.forEach((r) => binds.push(r));
  }
  // Phase 6 (design §2.2): per-dimension floors in the pinned dimension
  // order — deterministic SQL shape. COALESCE reads a NULL breakdown
  // (pre-Stage-43 rows, precheck skips) as 0: a floor asserts knowledge,
  // so unscored rows are excluded, never silently passed.
  for (const dim of LEAD_SCORE_DIMENSIONS) {
    const floor = filters.dimensionFloors[dim];
    if (floor !== undefined && floor > 0) {
      where.push(
        `COALESCE(CAST(json_extract(${t}lead_score_breakdown, '$.${dim}') AS INTEGER), 0) >= ?`,
      );
      binds.push(floor);
    }
  }
  if (filters.customerIds.length) {
    where.push(`${t}id IN (${filters.customerIds.map(() => "?").join(",")})`);
    filters.customerIds.forEach((id) => binds.push(id));
  }
  // Dedup per brand: a customer already emailed with this brand must not be
  // mailed again by a second campaign. contact_id IS NULL (Phase 8 Stage 49):
  // company grain only — a per-person draft (or send) belongs to the
  // (brand, customer, contact) key, not this one.
  if (filters.excludeSent && opts.brandName) {
    where.push(
      `${t}id NOT IN (SELECT customer_id FROM outreach_emails
                      WHERE brand_name = ? AND status = 'sent' AND customer_id IS NOT NULL AND contact_id IS NULL)`,
    );
    binds.push(opts.brandName);
  }
  return { where, binds };
}

/** "WHERE a AND b" for the built clause ("" when no filter applies). */
export function segmentClause(filters: SegmentFilters, opts: Parameters<typeof buildSegmentWhere>[1]): {
  clause: string;
  binds: Array<string | number>;
} {
  const { where, binds } = buildSegmentWhere(filters, opts);
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", binds };
}

/* ── Saved groups (客群) ────────────────────────────────────────────────── */

export interface OutreachGroup {
  id: number;
  name: string;
  description: string | null;
  filters: string;
  created_at: string;
  updated_at: string;
}

export async function listGroups(env: AdminEnv): Promise<OutreachGroup[]> {
  const rows = await env.DB.prepare(
    "SELECT id, name, description, filters, created_at, updated_at FROM outreach_groups ORDER BY id DESC",
  ).all<OutreachGroup>();
  return rows.results;
}

export async function createGroup(
  env: AdminEnv,
  input: { name: string; description?: string | null; filters: unknown },
): Promise<number> {
  const name = String(input.name ?? "").trim().slice(0, 100);
  if (!name) throw new Error("客群名称不能为空");
  const filters = serializeFilters(parseSegmentFilters(input.filters));
  if (filters.length > MAX_GROUP_FILTER_BYTES) throw new Error("筛选条件过大");
  const description = typeof input.description === "string"
    ? input.description.trim().slice(0, 200) || null
    : null;
  try {
    const res = await env.DB.prepare(
      "INSERT INTO outreach_groups (name, description, filters) VALUES (?, ?, ?)",
    ).bind(name, description, filters).run();
    return Number(res.meta.last_row_id ?? 0);
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE")) {
      throw new Error(`客群「${name}」已存在，请换一个名称`);
    }
    throw e;
  }
}

export async function updateGroup(
  env: AdminEnv,
  id: number,
  input: { name?: unknown; description?: unknown; filters?: unknown },
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (input.name !== undefined) {
    const name = String(input.name ?? "").trim().slice(0, 100);
    if (!name) throw new Error("客群名称不能为空");
    sets.push("name = ?");
    binds.push(name);
  }
  if (input.description !== undefined) {
    sets.push("description = ?");
    binds.push(typeof input.description === "string" ? input.description.trim().slice(0, 200) || null : null);
  }
  if (input.filters !== undefined) {
    const filters = serializeFilters(parseSegmentFilters(input.filters));
    if (filters.length > MAX_GROUP_FILTER_BYTES) throw new Error("筛选条件过大");
    sets.push("filters = ?");
    binds.push(filters);
  }
  if (!sets.length) throw new Error("没有需要更新的字段");
  sets.push("updated_at = CURRENT_TIMESTAMP");
  binds.push(id);
  try {
    await env.DB.prepare(`UPDATE outreach_groups SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE")) throw new Error("客群名称已存在");
    throw e;
  }
}

export async function deleteGroup(env: AdminEnv, id: number): Promise<void> {
  await env.DB.prepare("DELETE FROM outreach_groups WHERE id = ?").bind(id).run();
}

/* ── Preview ────────────────────────────────────────────────────────────── */

export interface SegmentPreview {
  matching: number;
  pending: number;
  already: number;
  noDraft: number;
  by_country: Array<{ country: string | null; n: number }>;
  sample: Array<{
    id: number;
    display_id: string | null;
    company_name: string | null;
    country: string | null;
    customer_segment: string | null;
    lead_score: number | null;
    email: string | null;
    has_draft: number;
  }>;
}

/* Preview is the safety gate before a campaign: it must report exactly how
 * many customers will be emailed and how many already have an email for this
 * brand, so the operator never has to guess what "全部发送" will include.
 *
 * Phase 8 per-person grain: when filters.perPerson is set, the previewed
 * unit is the company's pick (lowest-seq email-bearing contact) — the
 * matching count requires such a contact, and the has-draft/already checks
 * look at that contact's drafts (contact grain), so the preview counts
 * exactly what the campaign's generate step will adopt or generate. */
export async function previewSegment(
  env: AdminEnv,
  filters: SegmentFilters,
  brandName: string | null,
): Promise<SegmentPreview> {
  const brand = filters.excludeSent ? brandName : null;
  const perPerson = filters.perPerson;
  const { clause, binds } = segmentClause(filters, {
    requireCompleted: true,
    requireEmail: !perPerson,
    brandName: brand,
    table: "c",
  });
  // Per-person: a company only counts when it has an email-bearing contact.
  const contactGate = perPerson
    ? ` AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.company_id = c.company_id AND ct.email IS NOT NULL AND ct.email != '')`
    : "";
  // The company's contact pick, identical to the createCampaign snapshot.
  const contactPick = `(SELECT ct.id FROM contacts ct
                        WHERE ct.company_id = c.company_id AND ct.email IS NOT NULL AND ct.email != ''
                        ORDER BY ct.seq, ct.id LIMIT 1)`;
  // has_draft at the campaign's own grain: company drafts for company
  // campaigns, the picked contact's drafts for per-person campaigns.
  const hasDraftExpr = perPerson
    ? `(SELECT COUNT(*) FROM outreach_emails e
         WHERE e.customer_id = c.id AND e.brand_name = ? AND e.status = 'draft'
           AND e.contact_id = ${contactPick})`
    : `(SELECT COUNT(*) FROM outreach_emails e
         WHERE e.customer_id = c.id AND e.brand_name = ? AND e.status = 'draft')`;
  const alreadyExpr = perPerson
    ? `EXISTS (SELECT 1 FROM outreach_emails e
                WHERE e.customer_id = c.id AND e.brand_name = ? AND e.status IN ('draft','sent')
                  AND e.contact_id = ${contactPick})`
    : `EXISTS (SELECT 1 FROM outreach_emails e
                WHERE e.customer_id = c.id AND e.brand_name = ? AND e.status IN ('draft','sent'))`;

  const [count, sample, byCountry, covered] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM customers c ${clause}${contactGate}`)
      .bind(...binds).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT c.id, c.display_id, c.company_name, c.country, c.customer_segment, c.lead_score, c.email,
              ${hasDraftExpr} AS has_draft
       FROM customers c ${clause}${contactGate}
       ORDER BY c.lead_score DESC NULLS LAST, c.id LIMIT 20`,
    ).bind(brandName ?? "", ...binds).all<SegmentPreview["sample"][number]>(),
    env.DB.prepare(
      `SELECT c.country, COUNT(*) AS n FROM customers c ${clause}${contactGate}
       GROUP BY c.country ORDER BY n DESC LIMIT 10`,
    ).bind(...binds).all<{ country: string | null; n: number }>(),
    // How many of the matched rows already have a draft or a sent email for
    // this brand at the campaign's grain; those cost no AI budget and are
    // adopted by the generate step.
    brandName
      ? env.DB.prepare(
          `SELECT COUNT(*) AS n FROM customers c ${clause}${contactGate}
             AND ${alreadyExpr}`,
        ).bind(...binds, brandName).first<{ n: number }>()
      : Promise.resolve(null),
  ]);

  const matching = count?.n ?? 0;
  const already = Math.min(covered?.n ?? 0, matching);
  return {
    matching,
    pending: Math.max(0, matching - already),
    already,
    noDraft: Math.max(0, matching - already),
    by_country: byCountry.results,
    sample: sample.results,
  };
}

/* ── Campaigns ──────────────────────────────────────────────────────────── */

export interface CampaignRow {
  id: number;
  name: string;
  brand_name: string;
  group_id: number | null;
  filters: string | null;
  total: number;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignProgress {
  id: number;
  name: string;
  brand_name: string;
  group_id: number | null;
  total: number;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  pending: number;
  generated: number;
  sent: number;
  skipped: number;
  failed: number;
  remaining: number;
  done: boolean;
}

const MEMBER_STATUSES = ["pending", "generated", "sent", "skipped", "failed"] as const;
type MemberStatus = (typeof MEMBER_STATUSES)[number];

async function progressFor(env: AdminEnv, campaign: CampaignRow): Promise<CampaignProgress> {
  const rows = await env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM outreach_campaign_members WHERE campaign_id = ? GROUP BY status",
  ).bind(campaign.id).all<{ status: MemberStatus; n: number }>();
  const counts: Record<MemberStatus, number> = {
    pending: 0, generated: 0, sent: 0, skipped: 0, failed: 0,
  };
  for (const row of rows.results) {
    if (row.status in counts) counts[row.status] = row.n;
  }
  const remaining = counts.pending + counts.generated;
  return {
    ...campaign,
    pending: counts.pending,
    generated: counts.generated,
    sent: counts.sent,
    skipped: counts.skipped,
    failed: counts.failed,
    remaining,
    done: campaign.total > 0 && remaining === 0,
  };
}

export async function listCampaigns(env: AdminEnv, limit = 30): Promise<CampaignProgress[]> {
  const rows = await env.DB.prepare(
    `SELECT id, name, brand_name, group_id, filters, total, status, last_error, created_at, updated_at
     FROM outreach_campaigns ORDER BY id DESC LIMIT ?`,
  ).bind(Math.min(Math.max(limit, 1), 100)).all<CampaignRow>();
  return Promise.all(rows.results.map((c) => progressFor(env, c)));
}

export async function getCampaign(env: AdminEnv, id: number): Promise<CampaignProgress | null> {
  const row = await env.DB.prepare(
    `SELECT id, name, brand_name, group_id, filters, total, status, last_error, created_at, updated_at
     FROM outreach_campaigns WHERE id = ?`,
  ).bind(id).first<CampaignRow>();
  return row ? progressFor(env, row) : null;
}

export async function listCampaignMembers(
  env: AdminEnv,
  campaignId: number,
  opts: { status?: string; limit: number; offset: number },
): Promise<{ items: unknown[]; total: number }> {
  const where = ["m.campaign_id = ?"];
  const binds: unknown[] = [campaignId];
  if (opts.status && (MEMBER_STATUSES as readonly string[]).includes(opts.status)) {
    where.push("m.status = ?");
    binds.push(opts.status);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const [rows, count] = await Promise.all([
    env.DB.prepare(
      `SELECT m.customer_id, m.status, m.outreach_email_id, m.error,
              c.display_id, c.company_name, c.country, c.customer_segment, c.lead_score, c.email,
              m.contact_id,
              ct.contact_id AS contact_ref, ct.first_name AS contact_first_name, ct.last_name AS contact_last_name,
              ct.title AS contact_title, ct.email AS contact_email,
              e.subject, e.email_to, e.status AS email_status, e.created_at AS email_created_at
       FROM outreach_campaign_members m
       LEFT JOIN customers c ON c.id = m.customer_id
       LEFT JOIN contacts ct ON ct.id = m.contact_id
       LEFT JOIN outreach_emails e ON e.id = m.outreach_email_id
       ${clause} ORDER BY m.customer_id LIMIT ? OFFSET ?`,
    ).bind(...binds, opts.limit, opts.offset).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM outreach_campaign_members m ${clause}`)
      .bind(...binds).first<{ n: number }>(),
  ]);
  return { items: rows.results, total: count?.n ?? 0 };
}

export async function createCampaign(
  env: AdminEnv,
  input: { name?: unknown; brandName: string; groupId?: number | null; filters: SegmentFilters; groupName?: string | null },
): Promise<{ id: number; total: number; capped: boolean; companies: number }> {
  const brandName = String(input.brandName ?? "").trim();
  if (!brandName) throw new Error("brandName 不能为空");
  // A campaign sends real mail, so refuse a brand that is off or not yet set up.
  const brand = await env.DB.prepare(
    "SELECT brand_name, enabled, company_intro FROM outreach_settings WHERE brand_name = ?",
  ).bind(brandName).first<{ brand_name: string; enabled: number; company_intro: string | null }>();
  if (!brand) throw new Error(`品牌 ${brandName} 不存在`);
  if (!brand.enabled) throw new Error(`品牌 ${brandName} 未启用，无法群发`);
  if (!brand.company_intro || brand.company_intro.startsWith("[")) {
    throw new Error(`品牌 ${brandName} 的公司简介尚未配置，无法生成开发信`);
  }

  const name = String(input.name ?? "").trim().slice(0, 100)
    || input.groupName?.trim().slice(0, 100)
    || `${brandName} ${new Date().toISOString().slice(0, 10)}`;

  // Phase 8: per-person campaigns need a contact with an email, not a
  // company mailbox — requireEmail only applies to company grain.
  const perPerson = input.filters.perPerson;
  const { clause, binds } = segmentClause(input.filters, {
    requireCompleted: true,
    requireEmail: !perPerson,
    brandName: input.filters.excludeSent ? brandName : null,
    table: "c",
  });
  const ids = await env.DB.prepare(
    `SELECT c.id FROM customers c ${clause} ORDER BY c.lead_score DESC NULLS LAST, c.id LIMIT ?`,
  ).bind(...binds, MAX_CAMPAIGN_SIZE + 1).all<{ id: number }>();
  const capped = ids.results.length > MAX_CAMPAIGN_SIZE;
  const memberIds = (capped ? ids.results.slice(0, MAX_CAMPAIGN_SIZE) : ids.results).map((r) => r.id);
  if (!memberIds.length) {
    throw new Error(perPerson
      ? "没有匹配的客户：请放宽筛选条件（海选需要 status=completed）"
      : "没有匹配的客户：请放宽筛选条件（海选需要 status=completed 且有邮箱）");
  }

  // Phase 8 (design §2.2): a per-person snapshot takes exactly ONE
  // email-bearing contact per matched company — lowest seq (the first the
  // research found), ties by id. The members PK pins one row per company
  // either way. Companies without such a contact drop out (reported via
  // companies vs total).
  const memberPairs: Array<{ customer_id: number; contact_id: number }> = [];
  if (perPerson) {
    for (let i = 0; i < memberIds.length; i += 100) {
      const chunk = memberIds.slice(i, i + 100);
      const rows = await env.DB.prepare(
        `SELECT c.id AS customer_id,
                (SELECT ct.id FROM contacts ct
                  WHERE ct.company_id = c.company_id AND ct.email IS NOT NULL AND ct.email != ''
                  ORDER BY ct.seq, ct.id LIMIT 1) AS contact_id
         FROM customers c WHERE c.id IN (${chunk.map(() => "?").join(",")})`,
      ).bind(...chunk).all<{ customer_id: number; contact_id: number | null }>();
      for (const row of rows.results) {
        if (row.contact_id !== null) {
          memberPairs.push({ customer_id: row.customer_id, contact_id: row.contact_id });
        }
      }
    }
    if (!memberPairs.length) {
      throw new Error("没有可发送的联系人：匹配的公司都没有带邮箱的联系人");
    }
  }

  const total = perPerson ? memberPairs.length : memberIds.length;
  const res = await env.DB.prepare(
    `INSERT INTO outreach_campaigns (name, brand_name, group_id, filters, total, status)
     VALUES (?, ?, ?, ?, ?, 'draft')`,
  ).bind(name, brandName, input.groupId ?? null, serializeFilters(input.filters), total).run();
  const campaignId = Number(res.meta.last_row_id ?? 0);

  // D1 caps a batch at 100 statements; chunk well below it.
  const stmts: D1PreparedStatement[] = perPerson
    ? memberPairs.map((p) =>
      env.DB.prepare(
        "INSERT INTO outreach_campaign_members (campaign_id, customer_id, contact_id, status) VALUES (?, ?, ?, 'pending')",
      ).bind(campaignId, p.customer_id, p.contact_id))
    : memberIds.map((customerId) =>
      env.DB.prepare(
        "INSERT INTO outreach_campaign_members (campaign_id, customer_id, status) VALUES (?, ?, 'pending')",
      ).bind(campaignId, customerId));
  for (let i = 0; i < stmts.length; i += 50) {
    await env.DB.batch(stmts.slice(i, i + 50));
  }
  return { id: campaignId, total, capped, companies: memberIds.length };
}

export async function setCampaignStatus(
  env: AdminEnv,
  id: number,
  status: "draft" | "paused" | "done",
): Promise<void> {
  await env.DB.prepare(
    "UPDATE outreach_campaigns SET status = ?, last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(status, id).run();
}

export async function deleteCampaign(env: AdminEnv, id: number): Promise<void> {
  await env.DB.prepare("DELETE FROM outreach_campaign_members WHERE campaign_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM outreach_campaigns WHERE id = ?").bind(id).run();
}

async function requireCampaign(env: AdminEnv, id: number): Promise<CampaignRow> {
  const row = await env.DB.prepare(
    `SELECT id, name, brand_name, group_id, filters, total, status, last_error, created_at, updated_at
     FROM outreach_campaigns WHERE id = ?`,
  ).bind(id).first<CampaignRow>();
  if (!row) throw new Error("群发任务不存在");
  return row;
}

async function markCampaignError(env: AdminEnv, id: number, message: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE outreach_campaigns SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(message.slice(0, 500), id).run();
}

/* A step that ends clean must clear the banner. Otherwise a transient 429 from
 * this morning stays on screen as a red "最近错误" long after the retry that
 * fixed it succeeded, which trains the operator to ignore the field. */
async function clearCampaignError(env: AdminEnv, id: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE outreach_campaigns SET last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(id).run();
}

/* ── Step 1: generate drafts for the campaign members ────────────────────── */

/* The two steps below shell out to a real AI provider and the real Gmail API.
 * They are injected so the state machine (resume cursor, quota handling, dedupe)
 * can be tested without spending tokens or sending mail. Production uses the
 * defaults; nothing else needs to know this seam exists. */
export interface CampaignDeps {
  generate: typeof generateOutreachForCustomerIds;
  generateContacts: typeof generateOutreachForContactIds;
  send: typeof sendOutreachEmail;
  quota: typeof getQuota;
}

/* Stage 10: production sends go through the sending state machine, so a
 * duplicate campaign execution cannot double-send and a crashed worker
 * leaves an auditable trail (draft → reserved → sending → sent/failed/
 * uncertain). The seam keeps accepting raw senders for tests. */
const DEFAULT_DEPS: CampaignDeps = {
  generate: generateOutreachForCustomerIds,
  generateContacts: generateOutreachForContactIds,
  send: (env, email, options) => sendWithStateMachine(env, email, options),
  quota: getQuota,
};

export interface CampaignStepResult {
  processed: number;
  generated: number;
  skipped: number;
  failed: number;
  /** True when the batch stopped because the daily send quota ran out. */
  quotaStop: boolean;
  /** Members still owing work in the whole campaign (not yet generated or sent). */
  remaining: number;
  /** True when THIS step has no more work — not the same as the campaign
   * being finished, which is only true once everything is sent or failed. */
  done: boolean;
  quota: Awaited<ReturnType<typeof getQuota>> | null;
  results: Array<{ customer_id: number; ok: boolean; error?: string }>;
}

/* Upstream failures that a later click can plausibly succeed on. Anything else
 * (missing customer, unparseable AI answer) is treated as terminal. */
const RETRYABLE_ERROR = /429|rate limit|quota|timeout|timed out|ECONNRESET|fetch failed|502|503|504|overloaded|unavailable|try again/i;

function isRetryableError(message: string): boolean {
  return RETRYABLE_ERROR.test(message);
}

/* Resolve the outcome for one member the generator produced no draft for:
 * a transient upstream failure means "keep it queued and retry", anything else
 * is terminal and must be recorded so the campaign can finish. Returns null to
 * leave the member on 'pending'. */
function classifyGenerationError(
  customerId: number,
  errors: Array<{ customer_id: number; message: string }>,
): string | null {
  const own = errors.find((e) => e.customer_id === customerId);
  const message = own?.message ?? "";
  if (message && isRetryableError(message)) return null;
  return message || "AI 生成失败（客户记录可能已被删除）";
}

/* Resolve the outcome for one PER-PERSON member the generator produced no
 * draft for — same retryable/terminal split as classifyGenerationError, but
 * errors are keyed by the (customer, contact) pair, not the customer alone. */
function classifyContactGenerationError(
  pair: { customer_id: number; contact_id: number },
  errors: Array<{ customer_id: number; contact_id: number; message: string }>,
): string | null {
  const own = errors.find(
    (e) => e.customer_id === pair.customer_id && e.contact_id === pair.contact_id,
  );
  const message = own?.message ?? "";
  if (message && isRetryableError(message)) return null;
  return message || "AI 生成失败（客户或联系人记录可能已被删除）";
}

/* Resumable generation: only members still 'pending' are considered, and
 * customers that already have an email for this brand are marked 'skipped'
 * rather than re-generated — this is what keeps a repeated click from burning
 * AI tokens on customers that are already handled.
 *
 * Phase 8: a batch can mix grains — company members (contact_id NULL) and
 * per-person members (contact_id set). Each half is routed to its own
 * generator; a member row is updated by (campaign_id, customer_id), which
 * stays the members PK either way. */
export async function runCampaignGenerate(
  env: AdminEnv,
  campaignId: number,
  limit: number,
  deps: Partial<CampaignDeps> = {},
  requestId: string | null = null,
): Promise<CampaignStepResult> {
  const { generate, generateContacts } = { ...DEFAULT_DEPS, ...deps };
  const campaign = await requireCampaign(env, campaignId);
  if (campaign.status === "paused") {
    throw new Error("群发任务已暂停：请先点「恢复」再生成");
  }
  // Single-flight (spec §13): two concurrent generate steps on the same
  // campaign would double-spend AI tokens on the same pending members. The
  // per-customer generation claims remain the hard guarantee; this lock
  // prevents the duplicated work itself.
  const lock = await acquireCampaignLock(env, campaignId);
  if (!lock) {
    throw new CampaignLockedError("该群发任务正在被另一个执行处理（或上次执行异常中断，锁超时后会自动释放），请稍后重试");
  }
  try {
    const batch = Math.min(Math.max(limit, 1), 50);
    const pending = await env.DB.prepare(
      `SELECT customer_id, contact_id FROM outreach_campaign_members
       WHERE campaign_id = ? AND status = 'pending' ORDER BY customer_id LIMIT ?`,
    ).bind(campaignId, batch).all<{ customer_id: number; contact_id: number | null }>();
    if (!pending.results.length) {
      const progress = (await getCampaign(env, campaignId))!;
      await clearCampaignError(env, campaignId);
      return { processed: 0, generated: 0, skipped: 0, failed: 0, quotaStop: false, remaining: progress.remaining, done: true, quota: null, results: [] };
    }

    // Split the batch by grain and generate each half with its own
    // generator. Either half may be empty — its call is skipped entirely.
    const companyIds = pending.results
      .filter((r) => r.contact_id === null)
      .map((r) => r.customer_id);
    const contactPairs = pending.results
      .filter((r): r is { customer_id: number; contact_id: number } => r.contact_id !== null)
      .map((r) => ({ customer_id: r.customer_id, contact_id: r.contact_id }));

    let companyOutcome: Awaited<ReturnType<typeof generateOutreachForCustomerIds>> | null = null;
    let contactOutcome: Awaited<ReturnType<typeof generateOutreachForContactIds>> | null = null;
    try {
      if (companyIds.length) {
        companyOutcome = await generate(env, campaign.brand_name, companyIds, requestId);
      }
      if (contactPairs.length) {
        contactOutcome = await generateContacts(env, campaign.brand_name, contactPairs, requestId);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await markCampaignError(env, campaignId, message);
      throw e;
    }

    const stmts: D1PreparedStatement[] = [];
    const results: CampaignStepResult["results"] = [];
    const touched = new Set<number>();

    for (const row of companyOutcome?.already ?? []) {
      // Already has a draft (or a sent one) for this brand: adopt it instead of
      // generating a second email, so the campaign still gets sent.
      stmts.push(env.DB.prepare(
        `UPDATE outreach_campaign_members SET status = ?, outreach_email_id = ?, error = NULL
         WHERE campaign_id = ? AND customer_id = ?`,
      ).bind(row.status === "sent" ? "sent" : "generated", row.email_id, campaignId, row.customer_id));
      touched.add(row.customer_id);
      results.push({ customer_id: row.customer_id, ok: true });
    }
    for (const row of companyOutcome?.drafts ?? []) {
      stmts.push(env.DB.prepare(
        `UPDATE outreach_campaign_members SET status = 'generated', outreach_email_id = ?, error = NULL
         WHERE campaign_id = ? AND customer_id = ?`,
      ).bind(row.email_id, campaignId, row.customer_id));
      touched.add(row.customer_id);
      results.push({ customer_id: row.customer_id, ok: true });
    }
    for (const row of contactOutcome?.already ?? []) {
      // Per-person adoption: the dedup key is (brand, customer, contact), so
      // "already" here means THIS contact already has an email for the brand.
      stmts.push(env.DB.prepare(
        `UPDATE outreach_campaign_members SET status = ?, outreach_email_id = ?, error = NULL
         WHERE campaign_id = ? AND customer_id = ?`,
      ).bind(row.status === "sent" ? "sent" : "generated", row.email_id, campaignId, row.customer_id));
      touched.add(row.customer_id);
      results.push({ customer_id: row.customer_id, ok: true });
    }
    for (const row of contactOutcome?.drafts ?? []) {
      stmts.push(env.DB.prepare(
        `UPDATE outreach_campaign_members SET status = 'generated', outreach_email_id = ?, error = NULL
         WHERE campaign_id = ? AND customer_id = ?`,
      ).bind(row.email_id, campaignId, row.customer_id));
      touched.add(row.customer_id);
      results.push({ customer_id: row.customer_id, ok: true });
    }

    // Members the generator could not attribute an outcome to. The distinction
    // matters for resumability: a rate-limited or temporarily-failed provider
    // call leaves the member 'pending' so a later click can retry it, while a
    // terminal problem (customer row gone, unparseable AI answer) is marked
    // 'failed' so it stops blocking the campaign.
    let failed = 0;
    let retryable = 0;
    const unattributed = pending.results.filter((p) => !touched.has(p.customer_id));
    for (const row of unattributed) {
      const message = row.contact_id === null
        ? classifyGenerationError(row.customer_id, companyOutcome?.errors ?? [])
        : classifyContactGenerationError(
          { customer_id: row.customer_id, contact_id: row.contact_id },
          contactOutcome?.errors ?? [],
        );
      if (message === null) { retryable++; continue; }
      failed++;
      stmts.push(env.DB.prepare(
        `UPDATE outreach_campaign_members SET status = 'failed', error = ? WHERE campaign_id = ? AND customer_id = ?`,
      ).bind(message.slice(0, 300), campaignId, row.customer_id));
      results.push({ customer_id: row.customer_id, ok: false, error: message });
    }

    for (let i = 0; i < stmts.length; i += 50) {
      await env.DB.batch(stmts.slice(i, i + 50));
    }

    const firstError = contactOutcome?.errors[0]?.message
      ?? companyOutcome?.errors[0]?.message
      ?? "部分客户生成失败";
    if (failed) await markCampaignError(env, campaignId, firstError);
    else if (retryable) await markCampaignError(env, campaignId, "AI 服务暂时不可用，这些客户保持待生成，可点「生成草稿」重试");
    else await clearCampaignError(env, campaignId);
    const progress = (await getCampaign(env, campaignId))!;
    return {
      processed: pending.results.length,
      generated: (companyOutcome?.drafts.length ?? 0) + (contactOutcome?.drafts.length ?? 0),
      skipped: (companyOutcome?.already.length ?? 0) + (contactOutcome?.already.length ?? 0),
      failed,
      quotaStop: false,
      remaining: progress.remaining,
      // Generation is finished when nothing is still waiting for a draft. The
      // campaign itself is not done until those drafts have been sent.
      done: progress.pending === 0,
      quota: null,
      results,
    };
  } finally {
    await lock.release();
  }
}

/* ── Step 2: send the campaign's drafts (resumable, quota-aware) ─────────── */

interface SendableMember {
  customer_id: number;
  outreach_email_id: number;
  email_to: string | null;
  subject: string | null;
  body: string | null;
  country: string | null;
}

/* A quota stop is NOT a per-customer failure. Marking those members 'failed'
 * would permanently exclude them, which is exactly the opposite of what an
 * operator hitting the 400/day limit wants — they want to finish them
 * tomorrow. So on quota exhaustion the members stay 'generated' and the batch
 * simply ends short. */
function isQuotaStop(message: string): boolean {
  return message.includes("配额") || message.includes("quota") || message.includes("Quota");
}

/* Each click sends one batch. Members move 'generated' → 'sent' one at a time,
 * so closing the tab mid-batch never loses or double-sends progress: already
 * sent members are terminal and never re-picked. */
export async function runCampaignSend(
  env: AdminEnv,
  campaignId: number,
  limit: number,
  deps: Partial<CampaignDeps> = {},
  requestId: string | null = null,
): Promise<CampaignStepResult> {
  const { send, quota: getQuotaNow } = { ...DEFAULT_DEPS, ...deps };
  const campaign = await requireCampaign(env, campaignId);
  // A paused campaign is a hard stop, not a warning: the operator may have
  // spotted a bad filter after the fact, and "just one more batch" is exactly
  // the mistake that guardrail exists to prevent.
  if (campaign.status === "paused") {
    throw new Error("群发任务已暂停：请先点「恢复」再发送");
  }
  // Single-flight (spec §13): even though Stage 10's per-email claims already
  // guarantee no double send, two interleaved batches would burn quota on
  // skipped members and race the member bookkeeping. One campaign, one runner.
  const lock = await acquireCampaignLock(env, campaignId);
  if (!lock) {
    throw new CampaignLockedError("该群发任务正在被另一个执行处理（或上次执行异常中断，锁超时后会自动释放），请稍后重试");
  }
  try {
    const batch = Math.min(Math.max(limit, 1), 50);

    // INNER JOIN semantics are intentional: a member is sendable only while its
    // draft still exists and is still unsent.
    const members = await env.DB.prepare(
      `SELECT m.customer_id, m.outreach_email_id, e.email_to, e.subject, e.body, c.country
       FROM outreach_campaign_members m
       JOIN outreach_emails e ON e.id = m.outreach_email_id
       LEFT JOIN customers c ON c.id = m.customer_id
       WHERE m.campaign_id = ? AND m.status = 'generated' AND e.status = 'draft'
       ORDER BY m.customer_id LIMIT ?`,
    ).bind(campaignId, batch).all<SendableMember>();

    if (!members.results.length) {
      const progress = (await getCampaign(env, campaignId))!;
      await clearCampaignError(env, campaignId);
      return { processed: 0, generated: 0, skipped: 0, failed: 0, quotaStop: false, remaining: progress.remaining, done: true, quota: await getQuotaNow(env), results: [] };
    }

    const settings = await env.DB.prepare(
      "SELECT sender_email, sender_name, gmail_account FROM outreach_settings WHERE brand_name = ?",
    ).bind(campaign.brand_name).first<{ sender_email: string | null; sender_name: string | null; gmail_account: string | null }>();

    const quota = await getQuotaNow(env);
    const delayMs = sendDelayMs(env);
    const results: CampaignStepResult["results"] = [];
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let stopped = false;
    let quotaStop = false;

    for (const member of members.results) {
      if (quota.sent_today + sent >= quota.daily_limit) {
        // Leave this member and every later one on 'generated' for tomorrow.
        quotaStop = true;
        break;
      }
      if (sent > 0) await new Promise((r) => setTimeout(r, delayMs));
      try {
        const res = await send(
          env,
          { id: member.outreach_email_id, email_to: member.email_to ?? "", subject: member.subject, body: member.body },
          {
            fromEmail: settings?.sender_email ?? null,
            fromName: settings?.sender_name ?? null,
            brandName: campaign.brand_name,
            attachmentLanguage: attachmentLangForCountry(member.country),
            gmailAccount: settings?.gmail_account ?? null,
            requestId,
          },
        );
        if (res.ok) {
          sent++;
          results.push({ customer_id: member.customer_id, ok: true });
          await env.DB.prepare(
            "UPDATE outreach_campaign_members SET status = 'sent', error = NULL WHERE campaign_id = ? AND customer_id = ?",
          ).bind(campaignId, member.customer_id).run();
        } else if ((res as StateSendResult).outcome === "skipped_locked") {
          // Another execution owns this email right now (an operator's
          // single-send click racing the batch, or a fail-open window before
          // the locks table was migrated). That owner will mark the member
          // when it finishes — burning it as 'failed' here would lie about
          // the send outcome.
          skipped++;
          continue;
        } else {
          failed++;
          results.push({ customer_id: member.customer_id, ok: false, error: res.error });
          await env.DB.prepare(
            "UPDATE outreach_campaign_members SET status = 'failed', error = ? WHERE campaign_id = ? AND customer_id = ?",
          ).bind((res.error ?? "发送失败").slice(0, 300), campaignId, member.customer_id).run();
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // assertQuota() throws (rather than returning ok:false) once the daily
        // budget is gone. Treat that as a batch-level stop: the member stays
        // 'generated' so it is retried on the next day, not burned as failed.
        if (isQuotaStop(message)) { quotaStop = true; break; }
        failed++;
        results.push({ customer_id: member.customer_id, ok: false, error: message });
        await env.DB.prepare(
          "UPDATE outreach_campaign_members SET status = 'failed', error = ? WHERE campaign_id = ? AND customer_id = ?",
        ).bind(message.slice(0, 300), campaignId, member.customer_id).run();
        // Missing/invalid Gmail config will fail identically for every remaining
        // member, so stop the batch instead of burning through all of them.
        if (e instanceof GmailConfigError) { stopped = true; break; }
      }
    }

    if (stopped) {
      await markCampaignError(env, campaignId, "Gmail 配置缺失或无效，群发已中止");
    } else if (failed) {
      await markCampaignError(env, campaignId, results.find((r) => !r.ok)?.error ?? "部分邮件发送失败");
    } else {
      await clearCampaignError(env, campaignId);
    }

    const progress = (await getCampaign(env, campaignId))!;
    const after = await getQuotaNow(env);
    return {
      processed: results.length,
      generated: sent,
      skipped,
      failed,
      // Not an error: the operator is simply out of daily quota and can resume
      // tomorrow. Surfacing it as a failure would wrongly imply bad addresses.
      quotaStop,
      remaining: progress.remaining,
      // Nothing left for the send step to do once no draft is waiting on it —
      // members still awaiting generation are a different step's business.
      done: progress.generated === 0,
      quota: after,
      results,
    };
  } finally {
    await lock.release();
  }
}
