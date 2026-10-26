/* 邮箱/域名检测（CRM/email/emailcheck.txt + 筛查.txt + sslboard/throwaway 思路）。
 *
 * Workers 封禁出站 TCP 25，无法做 SMTP 握手探测（check-if-email-exists
 * 那条路）；本模块采用 throwaway 的 DoH 方案：通过 Cloudflare 1.1.1.1 的
 * DNS-over-HTTPS JSON 接口（cloudflare-dns.com/dns-query）并发查询
 * A / MX / TXT(SPF) 三类记录，零依赖、单域名约 3 个子请求。
 *
 * 检测对象与触发（用户口径：「只要是新增加或者修改的邮箱都会触发检查」）：
 *   - 公司域名（crm_companies.domain）与联系人邮箱（crm_contacts.email）
 *     在新增/导入时经列默认值 'pending'，修改时由 crm.ts 重置 'pending'；
 *   - cron 空闲 tick 扫描 pending 队列，按域名去重检测（domain_dns_checks
 *     为 30 天缓存，公司域名与联系人邮箱共享同一域名的结果）。
 *
 * 结论（email_verdict / domain_email_status / email_check_status 共用词表）：
 *   valid       有 MX 记录（可收企业邮件）
 *   free_email  免费个人邮箱（gmail/outlook/qq 等，B2B 里降权但不禁发）
 *   disposable  一次性/临时邮箱（本地名单 + 特征正则）
 *   no_mx       域名可解析但未配置 MX（该域名邮箱无法收信）
 *   dead_domain A/MX 均无（域名过期或拼写错误）
 *
 * 全部 fail-open：表缺失或 DoH 超时只影响本 tick，不影响 cron 主流程。
 */

import { jsonResponse, type AdminEnv } from "./admin";
import { safeLog } from "./security/safe-log";

export type EmailVerdict = "pending" | "valid" | "free_email" | "disposable" | "no_mx" | "dead_domain";

export interface DomainCheckResult {
  domain: string;
  has_a_record: number;
  has_mx_record: number;
  has_spf_record: number;
  mx_provider: string;
  mx_records: string[];
  is_free: boolean;
  is_disposable: boolean;
  verdict: Exclude<EmailVerdict, "pending">;
  feedback_notes: string;
}

export interface EmailScreeningReport {
  companies: number;
  contacts: number;
  domains_checked: number;
  errors: number;
}

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
/** throwaway 同款超时保护：DoH 单查询 3.5s。 */
const DOH_TIMEOUT_MS = 3500;
/** 检测缓存有效期：30 天内同域名直接复用缓存，不重复打 DoH。 */
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
/** 每 tick 最多处理的公司数 / 联系人数。 */
const TICK_BATCH = 20;
/** 每 tick 最多发起 DoH 新检测的域名数（×3 查询，控制在免费版 50 子请求内）。 */
const NEW_DOMAIN_BUDGET = 12;

/* ── 免费个人邮箱（B2B 场景直接标记，无需查 DoH） ────────────────────────── */

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "hotmail.com", "hotmail.co.uk",
  "outlook.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "163.com", "126.com", "qq.com", "sina.com", "139.com", "mail.ru", "yandex.ru", "yandex.com",
  "gmx.com", "gmx.de", "gmx.net", "web.de", "t-online.de", "proton.me", "protonmail.com",
  "hey.com", "fastmail.com", "zoho.com", "orange.fr", "free.fr", "wanadoo.fr", "libero.it",
  "naver.com", "hanmail.net", "rediffmail.com",
]);

/* ── 一次性/临时邮箱（本地精选名单 + 特征正则；throwaway 的 7.2 万域名
 *    布隆过滤器需独立构建产物，Workers 内改用高覆盖名单 + 正则兜底） ────── */

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "10minutemail.com", "10minutemail.net", "guerrillamail.com",
  "guerrillamail.net", "guerrillamail.org", "guerrillamailblock.com", "sharklasers.com",
  "grr.la", "tempmail.com", "tempmail.net", "tempmail.org", "temp-mail.org", "temp-mail.io",
  "tempmailo.com", "tempmail.plus", "tmpmail.org", "tmpmail.net", "tmpeml.com",
  "throwawaymail.com", "throwawaymail.cc", "yopmail.com", "yopmail.net", "yopmail.fr",
  "cool.fr.nf", "jetable.fr.nf", "courriel.fr.nf", "moncourrier.fr.nf", "monemail.fr.nf",
  "monmail.fr.nf", "trashmail.com", "trashmail.de", "trashmail.net", "trashmail.me",
  "trash-mail.com", "wegwerfmail.de", "wegwerfmail.net", "byom.de", "getnada.com",
  "getnada.net", "dispostable.com", "maildrop.cc", "fakeinbox.com", "mailnesia.com",
  "mytemp.email", "moakt.com", "moakt.ws", "tmail.ws", "emailondeck.com", "spam4.me",
  "mailcatch.com", "mintemail.com", "tempinbox.com", "discard.email", "spambog.com",
  "spambog.de", "spambog.ru", "mail-temp.com", "luxusmail.org", "1secmail.com",
  "1secmail.org", "1secmail.net", "fakermail.com", "tempr.email", "tmails.net",
  "burnermail.io", "inboxbear.com", "mail7.io", "muellmail.com", "inboxkitten.com",
  "spamgourmet.com", "mailsac.com", "mailinator.net", "mailinator2.com", "sogetthis.com",
  "reallymymail.com", "binkmail.com", "bobmail.info", "chammy.info", "devnullmail.com",
  "letthemeatspam.com", "mailin8r.com", "mailinater.com", "mailinator2.net", "spamherelots.com",
  "thisisnotmyrealemail.com", "tradermail.info", "veryrealemail.com", "zippymail.info",
]);

const DISPOSABLE_RE =
  /(temp[-_.]?mail|10minute|guerrilla|mailinator|yopmail|sharklasers|getnada|dispostable|mailnesia|emailondeck|spamgourmet|burnermail|fakermail|1secmail|inboxkitten|tempr\.email|throwawaymail|muellmail|wegwerfmail|spambog|maildrop\.cc)/;

export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0]
    .split(":")[0]
    .replace(/\.+$/, "");
}

export function extractEmailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const domain = normalizeDomain(email.slice(at + 1));
  return domain.includes(".") ? domain : null;
}

export function isFreeEmailDomain(domain: string): boolean {
  return FREE_EMAIL_DOMAINS.has(domain);
}

export function isDisposableEmailDomain(domain: string): boolean {
  return DISPOSABLE_DOMAINS.has(domain) || DISPOSABLE_RE.test(domain);
}

/* ── DoH 查询（throwaway 同款：JSON API + Accept 头 + 超时保护） ─────────── */

interface DohAnswer {
  name: string;
  type: number;
  data: string;
}

async function queryDoH(domain: string, type: "A" | "MX" | "TXT"): Promise<DohAnswer[]> {
  try {
    const res = await fetch(`${DOH_ENDPOINT}?name=${encodeURIComponent(domain)}&type=${type}`, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { Status?: number; Answer?: DohAnswer[] };
    return Array.isArray(data.Answer) ? data.Answer : [];
  } catch {
    return []; // 超时/网络错误按"无记录"处理 → 保守降级为 dead_domain
  }
}

/** MX 记录 → 邮局服务商指纹（emailcheck.txt 口径）。 */
export function detectMailProvider(mxRecords: string[]): string {
  const joined = mxRecords.join(" ").toLowerCase();
  if (!joined) return "None";
  if (joined.includes("google.com") || joined.includes("googlemail.com")) return "Google Workspace";
  if (joined.includes("protection.outlook.com") || joined.includes("outlook.com")) return "Microsoft 365";
  if (joined.includes("zoho.com") || joined.includes("zoho.eu")) return "Zoho Mail";
  if (joined.includes("mimecast.com")) return "Mimecast（高安全网关）";
  if (joined.includes("pphosted.com")) return "Proofpoint（高安全网关）";
  if (joined.includes("secureserver.net")) return "GoDaddy Mail";
  if (joined.includes("yahoodns.net")) return "Yahoo Small Business";
  if (joined.includes("mxhichina.com") || joined.includes("qiye.aliyun.com")) return "阿里企业邮箱";
  if (joined.includes("exmail.qq.com")) return "腾讯企业邮箱";
  if (joined.includes("qq.com")) return "腾讯邮箱";
  if (joined.includes("mail.ru")) return "Mail.ru";
  return "Self-Hosted / Other";
}

/* ── 单域名检测 ──────────────────────────────────────────────────────────── */

export async function verifyDomain(rawDomain: string): Promise<DomainCheckResult> {
  const domain = normalizeDomain(rawDomain);
  if (!domain || !domain.includes(".")) {
    return {
      domain, has_a_record: 0, has_mx_record: 0, has_spf_record: 0,
      mx_provider: "None", mx_records: [], is_free: false, is_disposable: false,
      verdict: "dead_domain", feedback_notes: "[邮箱检测异常] 域名格式无效（缺少顶级域），请检查拼写",
    };
  }
  if (isDisposableEmailDomain(domain)) {
    return {
      domain, has_a_record: 0, has_mx_record: 0, has_spf_record: 0,
      mx_provider: "None", mx_records: [], is_free: false, is_disposable: true,
      verdict: "disposable", feedback_notes: "[邮箱检测拦截] 一次性/临时邮箱域名，不具备真实商务价值",
    };
  }
  if (isFreeEmailDomain(domain)) {
    return {
      domain, has_a_record: 1, has_mx_record: 1, has_spf_record: 1,
      mx_provider: "Free（个人邮箱）", mx_records: [], is_free: true, is_disposable: false,
      verdict: "free_email", feedback_notes: "[邮箱检测通过] 免费个人邮箱（非企业域名），B2B 触达建议降权处理",
    };
  }

  const [aAnswers, mxAnswers, txtAnswers] = await Promise.all([
    queryDoH(domain, "A"),
    queryDoH(domain, "MX"),
    queryDoH(domain, "TXT"),
  ]);

  const hasA = aAnswers.some((r) => r.type === 1) ? 1 : 0;
  // RFC 7505 Null MX（"0 ."）明确声明不收信，视为无 MX。
  const mxRecords = mxAnswers
    .filter((r) => r.type === 15 && r.data)
    .map((r) => r.data.trim())
    .filter((data) => data !== "0 ." && data !== ".");
  const hasMx = mxRecords.length > 0 ? 1 : 0;
  const hasSpf = txtAnswers.some((r) => r.type === 16 && r.data.toLowerCase().includes("v=spf1")) ? 1 : 0;
  const provider = detectMailProvider(mxRecords);

  let verdict: DomainCheckResult["verdict"];
  let notes: string;
  if (hasMx) {
    verdict = "valid";
    notes = `[邮箱检测通过] 存在有效MX记录（${provider}），网站A记录:${hasA ? "正常" : "无"}，SPF记录:${hasSpf ? "已配置" : "未配置"}`;
  } else if (hasA) {
    verdict = "no_mx";
    notes = "[邮箱检测异常] 域名网站可解析（有A记录），但未配置MX邮件记录，该域名下邮箱无法收信";
  } else {
    verdict = "dead_domain";
    notes = "[域名已失效] 既无A记录也无MX记录，域名可能已过期或拼写错误";
  }

  return {
    domain,
    has_a_record: hasA,
    has_mx_record: hasMx,
    has_spf_record: hasSpf,
    mx_provider: provider,
    mx_records: mxRecords,
    is_free: false,
    is_disposable: false,
    verdict,
    feedback_notes: notes,
  };
}

/* ── 缓存（domain_dns_checks：按域名去重，30 天内复用） ──────────────────── */

interface CacheRow {
  domain: string;
  has_a_record: number;
  has_mx_record: number;
  has_spf_record: number;
  mx_provider: string;
  mx_records_json: string | null;
  is_free: number;
  is_disposable: number;
  email_verdict: string;
  feedback_notes: string | null;
  last_checked_at: string;
}

function cacheRowToResult(row: CacheRow): DomainCheckResult {
  let mxRecords: string[] = [];
  try {
    const parsed = JSON.parse(row.mx_records_json ?? "[]") as unknown;
    if (Array.isArray(parsed)) mxRecords = parsed.map(String);
  } catch { /* 损坏的 JSON 按空处理 */ }
  return {
    domain: row.domain,
    has_a_record: row.has_a_record,
    has_mx_record: row.has_mx_record,
    has_spf_record: row.has_spf_record,
    mx_provider: row.mx_provider,
    mx_records: mxRecords,
    is_free: row.is_free === 1,
    is_disposable: row.is_disposable === 1,
    verdict: row.email_verdict as DomainCheckResult["verdict"],
    feedback_notes: row.feedback_notes ?? "",
  };
}

async function readFreshCache(env: AdminEnv, domain: string): Promise<DomainCheckResult | null> {
  const row = await env.DB.prepare("SELECT * FROM domain_dns_checks WHERE domain = ?1")
    .bind(domain)
    .first<CacheRow>();
  if (!row) return null;
  const checkedAt = Date.parse(row.last_checked_at);
  if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > CACHE_TTL_MS) return null;
  return cacheRowToResult(row);
}

/** 检测并落缓存（upsert）。 */
async function verifyAndStore(env: AdminEnv, domain: string): Promise<DomainCheckResult> {
  const result = await verifyDomain(domain);
  await env.DB.prepare(
    `INSERT INTO domain_dns_checks
       (domain, has_a_record, has_mx_record, has_spf_record, mx_provider, mx_records_json,
        is_free, is_disposable, email_verdict, feedback_notes, last_checked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(domain) DO UPDATE SET
       has_a_record = excluded.has_a_record,
       has_mx_record = excluded.has_mx_record,
       has_spf_record = excluded.has_spf_record,
       mx_provider = excluded.mx_provider,
       mx_records_json = excluded.mx_records_json,
       is_free = excluded.is_free,
       is_disposable = excluded.is_disposable,
       email_verdict = excluded.email_verdict,
       feedback_notes = excluded.feedback_notes,
       last_checked_at = excluded.last_checked_at`,
  )
    .bind(
      result.domain,
      result.has_a_record,
      result.has_mx_record,
      result.has_spf_record,
      result.mx_provider,
      JSON.stringify(result.mx_records),
      result.is_free ? 1 : 0,
      result.is_disposable ? 1 : 0,
      result.verdict,
      result.feedback_notes,
      new Date().toISOString(),
    )
    .run();
  return result;
}

/** 强制重新检测（面板「重检」按钮）：跳过缓存直接打 DoH。 */
async function forceCheck(env: AdminEnv, domain: string): Promise<DomainCheckResult> {
  return await verifyAndStore(env, domain);
}

/* ── 结论回写 ────────────────────────────────────────────────────────────── */

async function noteTimeline(env: AdminEnv, companyId: string, summary: string): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO crm_activities (id, company_id, type, summary) VALUES (?1, ?2, 'note', ?3)",
    ).bind(crypto.randomUUID(), companyId, summary).run();
  } catch (error) {
    safeLog("warn", "[email-verify] 时间线写入失败（fail-open）", error);
  }
}

/** 异常结论（no_mx/dead_domain/disposable）才写时间线，valid/free 不刷屏。 */
function isAnomaly(verdict: string): boolean {
  return verdict === "no_mx" || verdict === "dead_domain" || verdict === "disposable";
}

/* ── Cron tick：扫描 pending 队列 ────────────────────────────────────────── */

interface PendingCompany {
  id: string;
  domain: string;
}

interface PendingContact {
  id: string;
  company_id: string;
  email: string;
}

export async function runEmailScreeningTick(env: AdminEnv): Promise<EmailScreeningReport> {
  const report: EmailScreeningReport = { companies: 0, contacts: 0, domains_checked: 0, errors: 0 };

  let companies: PendingCompany[] = [];
  let contacts: PendingContact[] = [];
  try {
    companies = (await env.DB.prepare(
      `SELECT id, domain FROM crm_companies
       WHERE domain_email_status = 'pending' AND domain IS NOT NULL AND TRIM(domain) != ''
       ORDER BY created_at LIMIT ${TICK_BATCH}`,
    ).all<PendingCompany>()).results;
    contacts = (await env.DB.prepare(
      `SELECT id, company_id, email FROM crm_contacts
       WHERE email_check_status = 'pending' AND email IS NOT NULL AND TRIM(email) != ''
       ORDER BY created_at LIMIT ${TICK_BATCH}`,
    ).all<PendingContact>()).results;
  } catch (error) {
    // 列/表不存在（migration 0036 未应用）→ 跳过本 tick。
    safeLog("warn", "[email-verify] 检测队列不可用，跳过本 tick（fail-open）", error);
    return report;
  }

  const cache = new Map<string, DomainCheckResult>();
  const resolve = async (domain: string): Promise<DomainCheckResult | null> => {
    const hit = cache.get(domain);
    if (hit) return hit;
    const fresh = await readFreshCache(env, domain).catch(() => null);
    if (fresh) {
      cache.set(domain, fresh);
      return fresh;
    }
    return null;
  };

  let newChecks = 0;
  const check = async (domain: string): Promise<DomainCheckResult | null> => {
    const existing = await resolve(domain);
    if (existing) return existing;
    if (newChecks >= NEW_DOMAIN_BUDGET) return null; // 留给下一个 tick
    newChecks++;
    report.domains_checked++;
    const result = await verifyAndStore(env, domain);
    cache.set(domain, result);
    return result;
  };

  for (const co of companies) {
    try {
      const domain = normalizeDomain(co.domain);
      const result = domain ? await check(domain) : null;
      if (!result) continue; // 预算用尽或域名无效 → 留 pending
      await env.DB.prepare("UPDATE crm_companies SET domain_email_status = ?2 WHERE id = ?1")
        .bind(co.id, result.verdict)
        .run();
      report.companies++;
      if (isAnomaly(result.verdict)) {
        await noteTimeline(env, co.id, `邮箱检测异常（域名 ${result.domain}）：${result.feedback_notes}`);
      }
    } catch (error) {
      report.errors++;
      safeLog("warn", `[email-verify] 公司 ${co.id} 检测失败（跳过）`, error);
    }
  }

  for (const ct of contacts) {
    try {
      const domain = extractEmailDomain(ct.email);
      const result = domain ? await check(domain) : null;
      if (!result) continue;
      await env.DB.prepare("UPDATE crm_contacts SET email_check_status = ?2 WHERE id = ?1")
        .bind(ct.id, result.verdict)
        .run();
      report.contacts++;
      if (isAnomaly(result.verdict)) {
        await noteTimeline(
          env,
          ct.company_id,
          `邮箱检测异常（${ct.email}）：${result.feedback_notes}`,
        );
      }
    } catch (error) {
      report.errors++;
      safeLog("warn", `[email-verify] 联系人 ${ct.id} 检测失败（跳过）`, error);
    }
  }

  if (report.companies || report.contacts || report.errors) {
    safeLog(
      "log",
      `[email-verify] tick: companies=${report.companies} contacts=${report.contacts} domains_checked=${report.domains_checked} errors=${report.errors}`,
    );
  }
  return report;
}

/* ── 面板/HTTP（供 crm.ts 调用） ─────────────────────────────────────────── */

/** 强制重检公司域名并回写状态（面板「重检域名」按钮）。 */
export async function recheckCompanyDomainInDb(
  env: AdminEnv,
  companyId: string,
): Promise<DomainCheckResult> {
  const company = await env.DB.prepare("SELECT id, domain FROM crm_companies WHERE id = ?1")
    .bind(companyId)
    .first<{ id: string; domain: string | null }>();
  if (!company) throw new Error("公司不存在");
  if (!company.domain || !company.domain.trim()) throw new Error("该公司没有域名，无法检测");
  const result = await forceCheck(env, normalizeDomain(company.domain));
  await env.DB.prepare("UPDATE crm_companies SET domain_email_status = ?2 WHERE id = ?1")
    .bind(companyId, result.verdict)
    .run();
  if (isAnomaly(result.verdict)) {
    await noteTimeline(env, companyId, `邮箱检测异常（域名 ${result.domain}）：${result.feedback_notes}`);
  }
  return result;
}

/** 强制重检联系人邮箱域名并回写状态（面板「重检邮箱」按钮）。 */
export async function recheckContactEmailInDb(
  env: AdminEnv,
  contactId: string,
): Promise<DomainCheckResult> {
  const contact = await env.DB.prepare("SELECT id, company_id, email FROM crm_contacts WHERE id = ?1")
    .bind(contactId)
    .first<{ id: string; company_id: string; email: string | null }>();
  if (!contact) throw new Error("联系人不存在");
  const domain = contact.email ? extractEmailDomain(contact.email) : null;
  if (!domain) throw new Error("该联系人没有可用邮箱，无法检测");
  const result = await forceCheck(env, domain);
  await env.DB.prepare("UPDATE crm_contacts SET email_check_status = ?2 WHERE id = ?1")
    .bind(contactId, result.verdict)
    .run();
  if (isAnomaly(result.verdict)) {
    await noteTimeline(env, contact.company_id, `邮箱检测异常（${contact.email}）：${result.feedback_notes}`);
  }
  return result;
}

/** GET /admin/api/crm/domains：最近检测记录 + 公司/联系人状态聚合。 */
export async function listDomainChecks(env: AdminEnv): Promise<Response> {
  const checks = await env.DB.prepare(
    "SELECT * FROM domain_dns_checks ORDER BY last_checked_at DESC LIMIT 100",
  ).all<CacheRow>();
  const companyCounts = await env.DB.prepare(
    "SELECT domain_email_status AS status, COUNT(*) AS n FROM crm_companies GROUP BY domain_email_status",
  ).all<{ status: string; n: number }>();
  const contactCounts = await env.DB.prepare(
    "SELECT email_check_status AS status, COUNT(*) AS n FROM crm_contacts GROUP BY email_check_status",
  ).all<{ status: string; n: number }>();
  return jsonResponse({
    checks: checks.results.map((row) => ({
      ...cacheRowToResult(row),
      last_checked_at: row.last_checked_at,
    })),
    company_counts: companyCounts.results,
    contact_counts: contactCounts.results,
  });
}
