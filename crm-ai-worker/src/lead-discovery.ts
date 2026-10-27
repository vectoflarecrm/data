// 更新.txt ① 自动寻找新客户：基于现有搜索舰队（Tavily/Exa/Searlo/DuckDuckGo，
// src/web-search.ts）的线索自动发现引擎。发现规则（行业/国家/产品关键词）→
// 自动生成搜索查询 → 提取候选公司（名称/域名/来源）→ 去重（customers +
// crm_companies + 本次运行内）→ 写入 customers（status='pending'，研究管线
// 照常 enrich）→ 线索提升后进入 CRM。零新增付费 API；每条候选记录进
// lead_discovery_log，可追溯可复查。
import { safeLog } from "./security/safe-log";
import { isNoiseResult, multiEngineSearch, type GoogleSearchResult, type SearchEnv } from "./web-search";

export interface DiscoveryRuleRow {
  id: string;
  name: string;
  keywords: string;
  industry: string | null;
  country: string | null;
  max_results: number;
  interval_hours: number;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
}

export interface DiscoveryRuleWithStats extends DiscoveryRuleRow {
  inserted_count: number;
  duplicate_count: number;
}

export interface DiscoveryLogRow {
  id: string;
  rule_id: string;
  run_at: string;
  query: string;
  company_name: string;
  domain: string | null;
  source_url: string | null;
  snippet: string | null;
  outcome: string;
  customer_id: number | null;
}

export interface DiscoveryCandidate {
  name: string;
  domain: string | null; // bare host (no www.); null = platform page (LinkedIn…)
  sourceUrl: string;
  snippet: string;
  query: string;
}

export interface DiscoveryRunReport {
  rule_id: string;
  queries: string[];
  candidates: number;
  inserted: number;
  duplicates: number;
}

// ---------------------------------------------------------------------------
// Query generation
// ---------------------------------------------------------------------------

function joinParts(parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build the search queries for one rule. The templates target the CRM
 * owner's buyers (distributors/importers/wholesalers/retailers) instead of
 * end consumers, so discovered companies are potential resellers. */
export function buildDiscoveryQueries(rule: Pick<DiscoveryRuleRow, "keywords" | "industry" | "country">): string[] {
  const keywords = (rule.keywords ?? "").trim();
  // Without product keywords the queries would just search the role word —
  // nothing discovery-worthy. The API layer already requires keywords; this
  // guard keeps the function honest when called directly (cron/tests).
  if (!keywords) return [];
  const templates = [
    (role: string) => joinParts([keywords, rule.industry, role, rule.country]),
    (role: string) => joinParts([keywords, rule.industry, role, rule.country]),
    (role: string) => joinParts([keywords, rule.industry, role, rule.country]),
  ];
  const roles = ["distributor", "importer wholesaler", "retailer reseller"];
  const queries: string[] = [];
  for (let i = 0; i < templates.length; i++) {
    const q = templates[i](roles[i]);
    // Skip degenerate queries (e.g. keywords-only is still searched; a query
    // shorter than 3 chars cannot produce useful results).
    if (q.length >= 3 && !queries.includes(q)) queries.push(q);
  }
  return queries;
}

// ---------------------------------------------------------------------------
// Candidate extraction
// ---------------------------------------------------------------------------

// Social platforms are name-only sources: the page identifies the company,
// but the domain belongs to the platform, never the company.
const SOCIAL_HOSTS = ["linkedin.com", "facebook.com", "instagram.com", "x.com", "twitter.com"];

// Hosted-page platforms (free blogs/site builders) are not real company
// domains and their content is rarely a distributor's storefront — skip.
const HOSTED_PAGE_HOSTS = [
  "blogspot.", "wordpress.com", "wixsite.com", "medium.com", "substack.com",
  "weebly.com", "jimdofree.", "github.io", "webnode.", "over-blog.com",
];

// Search-engine hosts — results pointing back at a SERP are never companies.
const SEARCH_HOSTS = ["google.", "bing.com", "duckduckgo.com", "yahoo.", "baidu.com", "yandex."];

function hostMatches(host: string, needles: string[]): boolean {
  return needles.some((n) => host === n || host.endsWith("." + n) || host.includes(n));
}

/** Unwrap DuckDuckGo redirect links (…/l/?uddg=<encoded>) to the real URL. */
function unwrapSearchRedirect(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith("duckduckgo.com") && parsed.pathname.startsWith("/l/")) {
      const target = parsed.searchParams.get("uddg");
      if (target) {
        try {
          return new URL(target).toString();
        } catch { return url; }
      }
    }
    return url;
  } catch {
    return url;
  }
}

function decodeTitleEntities(title: string): string {
  return title
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, d: string) => {
      const code = parseInt(d, 10);
      return Number.isFinite(code) && code > 0 && code < 0x10000 ? String.fromCharCode(code) : "";
    });
}

// Trailing title decorations that carry no company identity.
const TITLE_SUFFIX_PATTERNS = [
  /\s*[|·•]\s*(home|homepage|official (web ?)?site|welcome|index|main)\s*$/i,
  /\s*[-–—]\s*(home|homepage|official (web ?)?site|welcome|index|main)\s*$/i,
  /\s*[|·•]\s*(linkedin|facebook|instagram)\s*$/i,
  /\s*[|·•]\s*(just another wordpress site|site officiel|offizielle website)\s*$/i,
];

/** Turn a search-result title into a plausible company name, or null when
 * the title carries no usable identity (listicles, SERP crumbs, raw URLs). */
export function cleanTitleName(rawTitle: string): string | null {
  let title = decodeTitleEntities(rawTitle).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!title) return null;
  if (/https?:\/\//i.test(title)) return null;
  // Listicles / aggregations never name one company.
  if (/^(top|best)\s+\d+/i.test(title) || /^(list of|the \d+)\b/i.test(title)) return null;
  if (/\bdirectory\b|\bdistributors list\b|\bsuppliers list\b/i.test(title)) return null;
  // "Welcome to <Company>" → "<Company>"
  title = title.replace(/^welcome to\s+/i, "");
  for (const pattern of TITLE_SUFFIX_PATTERNS) {
    title = title.replace(pattern, "");
  }
  // Own-site titles usually lead with the brand: "Brand | Slogan",
  // "Brand - Products". Take the first segment when it looks like a name;
  // otherwise fall back to the longest segment (2..80 chars).
  const segments = title.split(/\s*[|·•]\s*|\s+-\s+|\s+–\s+|\s+—\s+|::\s*/);
  let best: string | null = null;
  for (const segment of segments) {
    const value = segment.trim();
    if (value.length >= 2 && value.length <= 80 && !/@/.test(value) && !/^\d+$/.test(value)) {
      if (best === null || value.length > best.length) best = value;
    }
  }
  // Prefer the first plausible segment (brand-first convention) over longest.
  const first = segments.length ? segments[0].trim() : title;
  if (first.length >= 2 && first.length <= 80 && !/@/.test(first) && !/^\d+$/.test(first)) return first;
  return best;
}

/** Extract one discovery candidate from a search result, or null when the
 * result is noise (marketplace/directory), a hosted page, a SERP, or carries
 * neither a usable name nor a real domain. */
export function extractCandidate(result: GoogleSearchResult, query: string): DiscoveryCandidate | null {
  const sourceUrl = unwrapSearchRedirect(result.link);
  // Marketplaces, directories, encyclopedias, video/social feeds: never a
  // company's own presence.
  if (isNoiseResult(sourceUrl)) return null;
  let host: string;
  try {
    host = new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  if (!host) return null;
  if (hostMatches(host, SEARCH_HOSTS)) return null;
  if (hostMatches(host, HOSTED_PAGE_HOSTS)) return null;
  const snippet = (result.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const name = cleanTitleName(result.title ?? "");
  if (hostMatches(host, SOCIAL_HOSTS)) {
    // Name-only source (e.g. LinkedIn company page): valid candidate, but
    // the domain is the platform's — leave domain null so research finds the
    // real site by name.
    if (!name) return null;
    return { name, domain: null, sourceUrl, snippet, query };
  }
  // Real domain: the name may come from the title or, failing that, the host.
  if (name) return { name, domain: host, sourceUrl, snippet, query };
  if (host.includes(".") && host.length >= 4) {
    return { name: host, domain: host, sourceUrl, snippet, query };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule CRUD + validation
// ---------------------------------------------------------------------------

export interface DiscoveryRuleInput {
  name: string;
  keywords: string;
  industry: string | null;
  country: string | null;
  max_results: number;
  interval_hours: number;
  enabled: number;
}

/** Validate an untrusted rule payload; returns the normalized input or an
 * error string (admin.ts maps it to a 400). */
export function parseDiscoveryRuleInput(raw: unknown): { ok: true; value: DiscoveryRuleInput } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "请求体必须是 JSON 对象" };
  const body = raw as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const keywords = typeof body.keywords === "string" ? body.keywords.trim() : "";
  if (!name) return { ok: false, error: "规则名称不能为空" };
  if (name.length > 100) return { ok: false, error: "规则名称过长（≤100 字符）" };
  if (!keywords) return { ok: false, error: "产品关键词不能为空" };
  if (keywords.length > 200) return { ok: false, error: "产品关键词过长（≤200 字符）" };
  const industry = typeof body.industry === "string" && body.industry.trim() ? body.industry.trim().slice(0, 100) : null;
  const country = typeof body.country === "string" && body.country.trim() ? body.country.trim().slice(0, 100) : null;
  const maxResults = body.max_results === undefined || body.max_results === null || body.max_results === ""
    ? 20
    : Number(body.max_results);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
    return { ok: false, error: "每次入库上限必须是 1-50 的整数" };
  }
  const intervalHours = body.interval_hours === undefined || body.interval_hours === null || body.interval_hours === ""
    ? 168
    : Number(body.interval_hours);
  if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 8760) {
    return { ok: false, error: "运行间隔必须是 1-8760 的整数小时" };
  }
  const enabled = body.enabled === undefined || body.enabled === null ? 1 : Number(body.enabled);
  if (enabled !== 0 && enabled !== 1) return { ok: false, error: "enabled 必须是 0 或 1" };
  return { ok: true, value: { name, keywords, industry, country, max_results: maxResults, interval_hours: intervalHours, enabled } };
}

export async function listDiscoveryRules(env: SearchEnv): Promise<DiscoveryRuleWithStats[]> {
  const rows = await env.DB.prepare(
    `SELECT r.*,
            (SELECT COUNT(*) FROM lead_discovery_log l WHERE l.rule_id = r.id AND l.outcome = 'inserted') AS inserted_count,
            (SELECT COUNT(*) FROM lead_discovery_log l WHERE l.rule_id = r.id AND l.outcome = 'duplicate') AS duplicate_count
     FROM lead_discovery_rules r
     ORDER BY r.created_at DESC, r.id`,
  ).all<DiscoveryRuleWithStats>();
  return rows.results ?? [];
}

export async function getDiscoveryRuleById(env: SearchEnv, id: string): Promise<DiscoveryRuleRow | null> {
  return await env.DB.prepare(
    `SELECT * FROM lead_discovery_rules WHERE id = ?`,
  ).bind(id).first<DiscoveryRuleRow>();
}

export async function createDiscoveryRule(env: SearchEnv, input: DiscoveryRuleInput): Promise<DiscoveryRuleRow> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO lead_discovery_rules (id, name, keywords, industry, country, max_results, interval_hours, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, input.name, input.keywords, input.industry, input.country, input.max_results, input.interval_hours, input.enabled).run();
  const rule = await getDiscoveryRuleById(env, id);
  if (!rule) throw new Error("创建发现规则后读取失败");
  return rule;
}

export async function updateDiscoveryRule(env: SearchEnv, id: string, input: DiscoveryRuleInput): Promise<DiscoveryRuleRow | null> {
  const result = await env.DB.prepare(
    `UPDATE lead_discovery_rules
     SET name = ?, keywords = ?, industry = ?, country = ?, max_results = ?, interval_hours = ?, enabled = ?
     WHERE id = ?`,
  ).bind(input.name, input.keywords, input.industry, input.country, input.max_results, input.interval_hours, input.enabled, id).run();
  if (!result.success) return null;
  return await getDiscoveryRuleById(env, id);
}

export async function deleteDiscoveryRule(env: SearchEnv, id: string): Promise<boolean> {
  const result = await env.DB.prepare(`DELETE FROM lead_discovery_rules WHERE id = ?`).bind(id).run();
  // The run log stays: discovered leads keep their provenance trail even
  // after the rule that found them is deleted.
  return result.success;
}

export async function getDiscoveryLog(env: SearchEnv, ruleId: string, limit: number): Promise<Array<DiscoveryLogRow & { customer_status: string | null; customer_lead_score: number | null }>> {
  const rows = await env.DB.prepare(
    `SELECT l.*, c.status AS customer_status, c.lead_score AS customer_lead_score
     FROM lead_discovery_log l
     LEFT JOIN customers c ON c.id = l.customer_id
     WHERE l.rule_id = ?
     ORDER BY l.run_at DESC, l.id DESC
     LIMIT ?`,
  ).bind(ruleId, limit).all<DiscoveryLogRow & { customer_status: string | null; customer_lead_score: number | null }>();
  return rows.results ?? [];
}

// ---------------------------------------------------------------------------
// The discovery run
// ---------------------------------------------------------------------------

async function findExistingCustomer(env: SearchEnv, candidate: DiscoveryCandidate): Promise<boolean> {
  if (candidate.domain) {
    const hit = await env.DB.prepare(
      `SELECT id FROM customers WHERE normalized_domain = ? OR domain LIKE ? LIMIT 1`,
    ).bind(candidate.domain, `%${candidate.domain}%`).first<{ id: number }>();
    if (hit) return true;
  }
  const hit = await env.DB.prepare(
    `SELECT id FROM customers WHERE LOWER(company_name) = LOWER(?) LIMIT 1`,
  ).bind(candidate.name).first<{ id: number }>();
  return Boolean(hit);
}

// crm_companies lives on the promoted side of the pipeline; a candidate that
// already made it to CRM must never re-enter research. Fail-open: a missing
// table (pre-0031 database) skips the check, never breaks the run.
async function findExistingCrmCompany(env: SearchEnv, candidate: DiscoveryCandidate): Promise<boolean> {
  try {
    if (candidate.domain) {
      const hit = await env.DB.prepare(
        `SELECT id FROM crm_companies WHERE domain = ? LIMIT 1`,
      ).bind(candidate.domain).first<{ id: string }>();
      if (hit) return true;
    }
    const hit = await env.DB.prepare(
      `SELECT id FROM crm_companies WHERE LOWER(name) = LOWER(?) LIMIT 1`,
    ).bind(candidate.name).first<{ id: string }>();
    return Boolean(hit);
  } catch {
    return false;
  }
}

/** Run one discovery rule now: generate queries → search the fleet → extract
 * candidates → dedupe → insert pending customers + log rows. Also stamps
 * last_run_at so the cron scheduler leaves the rule alone until due. */
export async function runDiscoveryRule(env: SearchEnv, rule: DiscoveryRuleRow): Promise<DiscoveryRunReport> {
  const queries = buildDiscoveryQueries(rule);
  const seenDomains = new Set<string>();
  const seenNames = new Set<string>();
  const maxResults = Math.min(Math.max(rule.max_results, 1), 50);
  let candidates = 0;
  let inserted = 0;
  let duplicates = 0;

  for (const query of queries) {
    if (inserted >= maxResults) break;
    const results = await multiEngineSearch(query, env);
    for (const result of results) {
      if (inserted >= maxResults) break;
      const candidate = extractCandidate(result, query);
      if (!candidate) continue;
      candidates++;
      // Within-run dedupe first (cheap): the same domain/name resurfacing in
      // a LATER query is the same candidate again, not a new company nor a
      // new duplicate — skip silently so the report and the log count real
      // companies, not per-query repeats.
      const nameKey = candidate.name.toLowerCase();
      if ((candidate.domain && seenDomains.has(candidate.domain)) || seenNames.has(nameKey)) {
        continue;
      }
      // Cross-run dedupe: customers (research queue, incl. CSV imports) and
      // crm_companies (already promoted).
      if (await findExistingCustomer(env, candidate) || await findExistingCrmCompany(env, candidate)) {
        seenNames.add(nameKey);
        if (candidate.domain) seenDomains.add(candidate.domain);
        duplicates++;
        await env.DB.prepare(
          `INSERT INTO lead_discovery_log (id, rule_id, query, company_name, domain, source_url, snippet, outcome)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'duplicate')`,
        ).bind(crypto.randomUUID(), rule.id, query, candidate.name, candidate.domain, candidate.sourceUrl, candidate.snippet || null).run();
        continue;
      }
      seenNames.add(nameKey);
      if (candidate.domain) seenDomains.add(candidate.domain);
      // New lead: land in the customers research queue exactly like a CSV
      // import row (status='pending', research cron enriches it), with the
      // rule id as provenance.
      const companyId = crypto.randomUUID();
      const row = await env.DB.prepare(
        `INSERT INTO customers (company_id, domain, normalized_domain, company_name, country, products_services, status, discovery_rule_id)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
         RETURNING id`,
      ).bind(
        companyId,
        candidate.domain ?? "",
        candidate.domain,
        candidate.name,
        rule.country,
        rule.keywords,
        rule.id,
      ).first<{ id: number }>();
      await env.DB.prepare(
        `INSERT INTO lead_discovery_log (id, rule_id, query, company_name, domain, source_url, snippet, outcome, customer_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'inserted', ?)`,
      ).bind(crypto.randomUUID(), rule.id, query, candidate.name, candidate.domain, candidate.sourceUrl, candidate.snippet || null, row?.id ?? null).run();
      inserted++;
    }
  }

  await env.DB.prepare(
    `UPDATE lead_discovery_rules SET last_run_at = datetime('now') WHERE id = ?`,
  ).bind(rule.id).run();
  return { rule_id: rule.id, queries, candidates, inserted, duplicates };
}

export async function runDiscoveryRuleById(env: SearchEnv, id: string): Promise<DiscoveryRunReport | null> {
  const rule = await getDiscoveryRuleById(env, id);
  if (!rule) return null;
  return await runDiscoveryRule(env, rule);
}

/** Cron entry: run at most ONE due enabled rule per idle tick (subrequest
 * budget: ≤3 fleet searches per run). Returns the report, or null when no
 * rule is due / the table is absent (fail-open — discovery never breaks the
 * research tick). */
export async function runDueDiscoveryRule(env: SearchEnv): Promise<DiscoveryRunReport | null> {
  let rule: DiscoveryRuleRow | null = null;
  try {
    rule = await env.DB.prepare(
      `SELECT * FROM lead_discovery_rules
       WHERE enabled = 1
         AND (last_run_at IS NULL OR last_run_at <= datetime('now', '-' || interval_hours || ' hours'))
       ORDER BY (last_run_at IS NULL) DESC, last_run_at ASC
       LIMIT 1`,
    ).first<DiscoveryRuleRow>();
  } catch {
    return null; // pre-0039 database: feature not installed yet
  }
  if (!rule) return null;
  const report = await runDiscoveryRule(env, rule);
  safeLog("log", `[lead-discovery] rule "${rule.name}" run: inserted=${report.inserted} duplicates=${report.duplicates} queries=${report.queries.length}`);
  return report;
}
