/* ⑥ 持续采购意向监测（更新.txt 第 6 项，开发顺序阶段四）。
 *
 * 研究时发现 buying_signals 只是"一次性快照"；本模块把它升级为
 * 持续监控：对重要客户（A/VIP 或有未结商机，自动入 crm_signal_watch）
 * 按 interval_days 周期性用 DuckDuckGo 搜索五类信号——
 *   new_product      新品发布
 *   expansion        扩张（新店/新市场/新产能）
 *   distributor      经销商招募
 *   procurement      采购公告/招标
 *   channel_change   渠道变化（换供应商/新合作）
 * 每类一条查询（单公司一次检查 = 5 个子请求，免费额度内），结果标题/
 * 摘要按"公司名锚点 + 信号关键词"判定；命中且 (公司, 类型, 来源URL)
 * 未见过 → crm_signal_checks 落库（保存来源、发生时间、失效时间 90 天），
 * 并自动：时间线备注 + 待办任务 + C 级公司上调 B 级（A/VIP/B/unqualified
 * 不动）。全部 fail-open：搜索失败只记 last_error，不影响 cron 主流程。
 */

import { jsonResponse, type AdminEnv } from "./admin";
import { safeLog } from "./security/safe-log";

export type SignalType = "new_product" | "expansion" | "distributor" | "procurement" | "channel_change";

export const SIGNAL_TYPES: SignalType[] = [
  "new_product",
  "expansion",
  "distributor",
  "procurement",
  "channel_change",
];

export function signalTypeLabel(type: string): string {
  switch (type) {
    case "new_product": return "新品发布";
    case "expansion": return "扩张动向";
    case "distributor": return "经销商招募";
    case "procurement": return "采购公告";
    case "channel_change": return "渠道变化";
    default: return type;
  }
}

/** 搜索查询词 + 结果判定关键词（小写子串匹配，中英兼顾）。 */
const SIGNAL_KEYWORDS: Array<{ type: SignalType; query: string; match: string[] }> = [
  {
    type: "new_product",
    query: "new product launch",
    match: ["new product", "product launch", "launches", "unveil", "新品", "发布"],
  },
  {
    type: "expansion",
    query: "expansion new location",
    match: ["expansion", "expands", "new store", "new location", "new facility", "new market", "扩张", "新店", "新厂"],
  },
  {
    type: "distributor",
    query: "distributor wanted dealer inquiry",
    match: ["distributor wanted", "dealers wanted", "become a dealer", "dealer inquiry", "seeking distributors", "seeks distributors", "distributors", "招募经销商", "经销加盟"],
  },
  {
    type: "procurement",
    query: "tender procurement request for quotation",
    match: ["tender", "procurement", "request for quotation", "rfq", "invitation to bid", "招标", "采购公告", "询价"],
  },
  {
    type: "channel_change",
    query: "new supplier partnership",
    match: ["new supplier", "partnership with", "signs agreement", "appointed", "更换供应商", "达成合作", "签署"],
  },
];

/** 新信号触发优先级上调的信号类型（扩张/招经销/采购 = 强购买意向）。 */
const STRONG_SIGNAL_TYPES: ReadonlySet<string> = new Set(["expansion", "distributor", "procurement"]);

/** 信号有效期：90 天后视为过期（列表仍可查，面板默认不展示）。 */
export const SIGNAL_EXPIRY_DAYS = 90;
/** 每 tick 最多检查的公司数（×5 条 DDG 查询）。 */
const TICK_BUDGET = 1;
/** 搜索超时，与 index.ts 的 FETCH_TIMEOUT_MS 同量级。 */
const SEARCH_TIMEOUT_MS = 8000;

interface SearchHit {
  title: string;
  link: string;
  snippet: string;
}

interface WatchRow {
  company_id: string;
  enabled: number;
  interval_days: number;
  last_checked_at: string | null;
  last_error: string | null;
}

interface CompanyRow {
  id: string;
  name: string;
  domain: string | null;
  tier: string;
}

export interface SignalCheckReport {
  company_id: string;
  new_signals: number;
  tier_bumped: boolean;
  queries: number;
}

/* ── DuckDuckGo HTML 搜索（与 index.ts 同款零 key 兜底引擎，独立实现
 *    以免与主研究管线产生模块环） ─────────────────────────────────────────── */

async function duckduckgoSearch(query: string): Promise<SearchHit[]> {
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CRM-SignalMonitor/1.0)" },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const hits: SearchHit[] = [];
    const regex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>(?:[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([^<]+)<\/a>)?/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null && hits.length < 10) {
      hits.push({
        title: match[2].replace(/<[^>]+>/g, "").trim(),
        link: match[1],
        snippet: (match[3] ?? "").replace(/<[^>]+>/g, "").trim(),
      });
    }
    return hits;
  } catch {
    return [];
  }
}

/* ── 信号判定（纯函数，供测试） ───────────────────────────────────────────── */

/** 公司名锚点：去除尾部法务后缀（Ltd/Co/Inc 等）与标点噪音，
 *  保留其余词（含开头的 The），用于标题/摘要的子串相关性判定。 */
const ANCHOR_NOISE_SUFFIX = /^(the|inc|llc|ltd|gmbh|co|corp|corporation|company|limited)$/i;
export function companyNameAnchor(name: string): string {
  const words = name
    .replace(/[.,，、/|()（）]/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && ANCHOR_NOISE_SUFFIX.test(words[words.length - 1])) {
    words.pop();
  }
  return words.join(" ");
}

export function buildSignalQuery(company: CompanyRow, type: SignalType): string {
  const spec = SIGNAL_KEYWORDS.find((s) => s.type === type);
  const base = company.domain ? `"${company.name}" OR "${company.domain}"` : `"${company.name}"`;
  return `${base} ${spec?.query ?? ""}`.trim();
}

/** 判定一条搜索结果是否构成该类型的信号：
 *  公司锚点命中 + 类型关键词命中，且标题不为空。 */
export function matchSignalHit(hit: SearchHit, companyName: string, type: SignalType): boolean {
  if (!hit.title) return false;
  const anchor = companyNameAnchor(companyName);
  if (!anchor) return false;
  const text = `${hit.title} ${hit.snippet}`.toLowerCase();
  if (!text.includes(anchor)) return false;
  const spec = SIGNAL_KEYWORDS.find((s) => s.type === type);
  if (!spec) return false;
  return spec.match.some((kw) => text.includes(kw));
}

/* ── 落库与副作用 ────────────────────────────────────────────────────────── */

async function noteTimeline(env: AdminEnv, companyId: string, summary: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO crm_activities (id, company_id, type, summary) VALUES (?1, ?2, 'note', ?3)",
  ).bind(crypto.randomUUID(), companyId, summary).run();
}

async function createTask(env: AdminEnv, companyId: string, summary: string): Promise<void> {
  const due = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  await env.DB.prepare(
    "INSERT INTO crm_activities (id, company_id, type, summary, due_date) VALUES (?1, ?2, 'task', ?3, ?4)",
  ).bind(crypto.randomUUID(), companyId, summary, due).run();
}

async function recordNewSignal(
  env: AdminEnv,
  company: CompanyRow,
  type: SignalType,
  hit: SearchHit,
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SIGNAL_EXPIRY_DAYS * 24 * 3600 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO crm_signal_checks (id, company_id, signal_type, signal_text, source_url, detected_at, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6)
     ON CONFLICT(company_id, signal_type, source_url) DO NOTHING`,
  )
    .bind(crypto.randomUUID(), company.id, type, hit.title.slice(0, 300), hit.link || null, now.toISOString(), expiresAt)
    .run();
}

/** 检查一家公司的信号（面板「立即检查」与 cron 共用）。
 *  force=true 跳过冷却时间；仍会刷新 last_checked_at。 */
export async function checkCompanySignals(
  env: AdminEnv,
  companyId: string,
  options: { force?: boolean } = {},
): Promise<SignalCheckReport> {
  const company = await env.DB.prepare(
    "SELECT id, name, domain, tier FROM crm_companies WHERE id = ?1",
  ).bind(companyId).first<CompanyRow>();
  if (!company) throw new Error("公司不存在");

  const watch = await env.DB.prepare(
    "SELECT * FROM crm_signal_watch WHERE company_id = ?1",
  ).bind(companyId).first<WatchRow>();

  let report: SignalCheckReport = { company_id: companyId, new_signals: 0, tier_bumped: false, queries: 0 };

  try {
    let newSignals = 0;
    for (const spec of SIGNAL_KEYWORDS) {
      const hits = await duckduckgoSearch(buildSignalQuery(company, spec.type));
      report.queries++;
      for (const hit of hits) {
        if (!matchSignalHit(hit, company.name, spec.type)) continue;
        const before = await env.DB.prepare(
          "SELECT id FROM crm_signal_checks WHERE company_id = ?1 AND signal_type = ?2 AND source_url = ?3",
        ).bind(companyId, spec.type, hit.link || "").first<{ id: string }>();
        if (before) continue; // 来源去重：同一条新闻只记一次
        await recordNewSignal(env, company, spec.type, hit);
        newSignals++;
        const label = signalTypeLabel(spec.type);
        await noteTimeline(
          env,
          companyId,
          `📡 检测到${label}信号（更新.txt ⑥ 持续意向监测）：${hit.title.slice(0, 120)}${hit.link ? `（来源: ${hit.link.slice(0, 200)}）` : ""}`,
        );
        await createTask(env, companyId, `跟进${label}信号：${hit.title.slice(0, 100)}`);
      }
    }
    report.new_signals = newSignals;

    // 强信号 → C 级自动上调 B 级（A/VIP/B/unqualified 不动；更新.txt
    // 「在新信号出现时自动调整优先级」的保守实现）。
    if (newSignals > 0 && company.tier === "C") {
      const strong = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM crm_signal_checks
         WHERE company_id = ?1 AND signal_type IN ('expansion', 'distributor', 'procurement')
           AND detected_at >= datetime('now', '-${SIGNAL_EXPIRY_DAYS} days')`,
      ).bind(companyId).first<{ n: number }>();
      if ((strong?.n ?? 0) > 0) {
        await env.DB.prepare(
          "UPDATE crm_companies SET tier = 'B', updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        ).bind(companyId).run();
        await noteTimeline(env, companyId, "📡 检测到强购买意向信号，公司分级已自动由 C 上调为 B（更新.txt ⑥）");
        report.tier_bumped = true;
      }
    }

    await env.DB.prepare(
      `INSERT INTO crm_signal_watch (company_id, enabled, interval_days, last_checked_at, last_error)
       VALUES (?1, 1, 14, ?2, NULL)
       ON CONFLICT(company_id) DO UPDATE SET last_checked_at = ?2, last_error = NULL`,
    ).bind(companyId, new Date().toISOString()).run();
  } catch (error) {
    // 搜索/落库失败：记 last_error，不抛出（fail-open）。
    await env.DB.prepare(
      `INSERT INTO crm_signal_watch (company_id, enabled, interval_days, last_checked_at, last_error)
       VALUES (?1, 1, 14, ?2, ?3)
       ON CONFLICT(company_id) DO UPDATE SET last_error = ?3`,
    ).bind(companyId, new Date().toISOString(), error instanceof Error ? error.message : String(error)).run().catch(() => undefined);
    safeLog("warn", "[signal-monitor] 检查失败（fail-open）", error);
  }
  void options.force; // 冷却控制在 tick 选取阶段；直查总是执行
  return report;
}

/* ── Cron tick ───────────────────────────────────────────────────────────── */

export interface SignalTickReport {
  checked: number;
  new_signals: number;
  errors: number;
}

/** 重要客户自动入监测表（A/VIP 或有未结商机），幂等。 */
async function autoWatchImportant(env: AdminEnv): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO crm_signal_watch (company_id, enabled, interval_days)
     SELECT c.id, 1, 14 FROM crm_companies c
     WHERE c.do_not_contact = 0
       AND (c.tier IN ('A', 'VIP')
         OR EXISTS (SELECT 1 FROM crm_deals d
                    WHERE d.company_id = c.id AND d.archived_at IS NULL
                      AND d.stage NOT IN ('won', 'lost')))`,
  ).run();
}

/** 空闲 tick：自动入表 → 挑到期公司（冷却内跳过）→ 逐家检查。 */
export async function runSignalMonitorTick(env: AdminEnv): Promise<SignalTickReport> {
  const report: SignalTickReport = { checked: 0, new_signals: 0, errors: 0 };
  try {
    await autoWatchImportant(env);
  } catch (error) {
    // 表缺失（migration 0037 未应用）→ 跳过本 tick。
    safeLog("warn", "[signal-monitor] 监测表不可用，跳过本 tick（fail-open）", error);
    return report;
  }
  const due = await env.DB.prepare(
    `SELECT w.company_id FROM crm_signal_watch w
     JOIN crm_companies c ON c.id = w.company_id
     WHERE w.enabled = 1 AND c.do_not_contact = 0
       AND (w.last_checked_at IS NULL
         OR w.last_checked_at <= datetime('now', printf('-%d days', w.interval_days)))
     ORDER BY w.last_checked_at IS NOT NULL, w.last_checked_at ASC
     LIMIT ${TICK_BUDGET}`,
  ).all<{ company_id: string }>();
  for (const row of due.results) {
    try {
      const r = await checkCompanySignals(env, row.company_id);
      report.checked++;
      report.new_signals += r.new_signals;
    } catch (error) {
      report.errors++;
      safeLog("warn", `[signal-monitor] 公司 ${row.company_id} 检查失败（跳过）`, error);
    }
  }
  return report;
}

/* ── 面板/HTTP（供 crm.ts 调用） ─────────────────────────────────────────── */

/** GET /admin/api/crm/signals：监测列表 + 最近信号。 */
export async function listSignalOverview(env: AdminEnv): Promise<Response> {
  const watch = await env.DB.prepare(
    `SELECT w.*, c.name AS company_name, c.tier,
       (SELECT COUNT(*) FROM crm_signal_checks s
        WHERE s.company_id = w.company_id AND s.expires_at > datetime('now')) AS active_signals
     FROM crm_signal_watch w JOIN crm_companies c ON c.id = w.company_id
     ORDER BY w.enabled DESC, active_signals DESC, w.last_checked_at IS NOT NULL, w.last_checked_at ASC
     LIMIT 200`,
  ).all();
  const signals = await env.DB.prepare(
    `SELECT s.*, c.name AS company_name FROM crm_signal_checks s
     JOIN crm_companies c ON c.id = s.company_id
     WHERE s.expires_at > datetime('now')
     ORDER BY s.detected_at DESC LIMIT 100`,
  ).all();
  return jsonResponse({ watch: watch.results, signals: signals.results });
}

/** PATCH /admin/api/crm/signals/watch/:id：停用/启用/改周期。 */
export async function updateSignalWatch(
  env: AdminEnv,
  companyId: string,
  body: { enabled?: boolean; interval_days?: number },
): Promise<Response> {
  const company = await env.DB.prepare("SELECT id FROM crm_companies WHERE id = ?1")
    .bind(companyId).first<{ id: string }>();
  if (!company) throw new Error("公司不存在");
  const enabled = body.enabled === undefined ? 1 : body.enabled ? 1 : 0;
  const interval = body.interval_days === undefined ? 14 : Math.max(1, Math.min(90, Math.floor(body.interval_days)));
  await env.DB.prepare(
    `INSERT INTO crm_signal_watch (company_id, enabled, interval_days)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(company_id) DO UPDATE SET enabled = ?2, interval_days = ?3`,
  ).bind(companyId, enabled, interval).run();
  const watch = await env.DB.prepare("SELECT * FROM crm_signal_watch WHERE company_id = ?1")
    .bind(companyId).first<WatchRow>();
  return jsonResponse({ watch });
}
