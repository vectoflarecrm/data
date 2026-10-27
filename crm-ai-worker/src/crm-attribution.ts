// 0038 ⑤ 客户开发 ROI 与来源归因（更新.txt 第 5 项，开发顺序阶段五）。
//
// 回答「哪个客户来源最便宜、哪种客户最容易成交、哪种开发方式带来最高利润」：
// 按 来源 / 国家 / 行业 / 联系人采购角色 / 销售序列 五个维度聚合
// 公司 → 联系人 → 回复 → 商机 → 报价 → 成交 → 营收 → 赢单率 → 平均成交周期。
//
// 口径与 P1-8 漏斗保持一致（src/crm.ts crmFunnel）：
//   回复 = 时间线 email_received 活动数；商机/报价/成交 = 未归档 crm_deals
//   （报价 = 阶段推进到 sample_quoted 及之后；成交 = stage='won'）。
//   迁移 0038 未应用（crm_companies.source 缺列）时 fail-open 返回
//   available:false，面板提示先应用迁移。

import { jsonResponse, type AdminEnv } from "./admin";
import { safeLog } from "./security/safe-log";
import { roleLabel } from "./contact-roles";

/** 获客来源（crm_companies.source 合法值 + 面板中文标签）。 */
export const COMPANY_SOURCES = [
  "promoted",
  "manual",
  "csv_import",
  "merge",
  "referral",
  "other",
  "unknown",
] as const;

export type CompanySource = (typeof COMPANY_SOURCES)[number];

export const SOURCE_LABELS: Record<CompanySource, string> = {
  promoted: "管线提升",
  manual: "手工录入",
  csv_import: "CSV 导入",
  merge: "合并而来",
  referral: "转介绍",
  other: "其他",
  unknown: "未知",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source as CompanySource] ?? source;
}

/** 一个维度值的累计指标（grouping 时在内存中累加，公司量级小、无需 GROUP BY 五连发）。 */
interface DimAcc {
  dim: string;
  label: string;
  companies: number;
  contacts: number;
  replies: number;
  deals: number;
  quoted: number;
  won: number;
  revenue: number;
  cycle_sum: number;
  cycle_n: number;
  /** 序列维度专用：报名数与各状态计数（其余维度恒 0）。 */
  enrolled: number;
  active: number;
  stopped: number;
  completed: number;
}

function newAcc(dim: string, label: string): DimAcc {
  return {
    dim,
    label,
    companies: 0,
    contacts: 0,
    replies: 0,
    deals: 0,
    quoted: 0,
    won: 0,
    revenue: 0,
    cycle_sum: 0,
    cycle_n: 0,
    enrolled: 0,
    active: 0,
    stopped: 0,
    completed: 0,
  };
}

/** 单公司的漏斗指标行（SQL 一次性取出，JS 分组）。 */
interface CompanyMetricsRow {
  id: string;
  source: string;
  country: string | null;
  industry: string | null;
  contacts: number;
  replies: number;
  deals: number;
  quoted: number;
  won: number;
  revenue: number;
}

function toResult(acc: DimAcc): Record<string, unknown> {
  return {
    dim: acc.dim,
    label: acc.label,
    companies: acc.companies,
    contacts: acc.contacts,
    replies: acc.replies,
    deals: acc.deals,
    quoted: acc.quoted,
    won: acc.won,
    revenue: Math.round(acc.revenue * 100) / 100,
    win_rate: acc.deals > 0 ? Math.round((acc.won / acc.deals) * 1000) / 10 : 0,
    avg_cycle_days: acc.cycle_n > 0 ? Math.round((acc.cycle_sum / acc.cycle_n) * 10) / 10 : null,
    ...(acc.enrolled > 0 || acc.active > 0 || acc.stopped > 0 || acc.completed > 0
      ? { enrolled: acc.enrolled, active: acc.active, stopped: acc.stopped, completed: acc.completed }
      : {}),
  };
}

/** 排序：营收 → 成交数 → 公司数（回答「哪种方式利润最高」时最赚钱的排最前）。 */
function byRevenue(a: Record<string, unknown>, b: Record<string, unknown>): number {
  return (
    (b.revenue as number) - (a.revenue as number) ||
    (b.won as number) - (a.won as number) ||
    (b.companies as number) - (a.companies as number)
  );
}

/** GET /admin/api/crm/attribution：五维归因总览。 */
export async function getAttribution(env: AdminEnv): Promise<Response> {
  try {
    const perCompany = await env.DB.prepare(
      `SELECT c.id, c.source, c.country, c.industry,
         (SELECT COUNT(*) FROM crm_contacts ct WHERE ct.company_id = c.id) AS contacts,
         (SELECT COUNT(*) FROM crm_activities a
          WHERE a.company_id = c.id AND a.type = 'email_received') AS replies,
         (SELECT COUNT(*) FROM crm_deals d
          WHERE d.company_id = c.id AND d.archived_at IS NULL AND d.stage != 'lost') AS deals,
         (SELECT COUNT(*) FROM crm_deals d
          WHERE d.company_id = c.id AND d.archived_at IS NULL
            AND d.stage IN ('sample_quoted', 'pi_sent', 'deposit_paid', 'won')) AS quoted,
         (SELECT COUNT(*) FROM crm_deals d
          WHERE d.company_id = c.id AND d.stage = 'won') AS won,
         (SELECT IFNULL(SUM(d.amount), 0) FROM crm_deals d
          WHERE d.company_id = c.id AND d.stage = 'won') AS revenue
       FROM crm_companies c`,
    ).all<CompanyMetricsRow>();

    // 赢单周期（created_at → won_at 的平均天数）按公司聚合一次。
    const cycles = await env.DB.prepare(
      `SELECT d.company_id AS id,
         SUM(CAST(julianday(d.won_at) - julianday(d.created_at) AS REAL)) AS cycle_sum,
         COUNT(*) AS cycle_n
       FROM crm_deals d
       WHERE d.stage = 'won' AND d.won_at IS NOT NULL
       GROUP BY d.company_id`,
    ).all<{ id: string; cycle_sum: number; cycle_n: number }>();
    const cycleByCompany = new Map<string, { cycle_sum: number; cycle_n: number }>();
    for (const row of cycles.results) cycleByCompany.set(row.id, row);

    // 联系人采购角色（⑦ 图谱）→ 角色维度的公司集合。
    const roles = await env.DB.prepare(
      `SELECT DISTINCT ct.company_id AS id, ct.procurement_role AS role
       FROM crm_contacts ct
       WHERE ct.procurement_role IS NOT NULL`,
    ).all<{ id: string; role: string }>();

    // 序列报名（③ 多步序列）→ 序列维度：报名数/状态计数 + 公司漏斗。
    const enrollments = await env.DB.prepare(
      `SELECT e.sequence_id, s.name, e.company_id, e.status
       FROM crm_sequence_enrollments e
       JOIN crm_sequences s ON s.id = e.sequence_id`,
    ).all<{ sequence_id: string; name: string; company_id: string; status: string }>();

    const metrics = new Map<string, CompanyMetricsRow>();
    for (const row of perCompany.results) metrics.set(row.id, row);

    const sources = new Map<string, DimAcc>();
    const countries = new Map<string, DimAcc>();
    const industries = new Map<string, DimAcc>();
    const roleAccs = new Map<string, DimAcc>();

    const addCompany = (acc: DimAcc, row: CompanyMetricsRow): void => {
      acc.companies++;
      acc.contacts += row.contacts;
      acc.replies += row.replies;
      acc.deals += row.deals;
      acc.quoted += row.quoted;
      acc.won += row.won;
      acc.revenue += row.revenue;
      const cycle = cycleByCompany.get(row.id);
      if (cycle) {
        acc.cycle_sum += cycle.cycle_sum;
        acc.cycle_n += cycle.cycle_n;
      }
    };

    for (const row of perCompany.results) {
      const src = sources.get(row.source) ?? newAcc(row.source, sourceLabel(row.source));
      addCompany(src, row);
      sources.set(row.source, src);

      const countryKey = row.country?.trim() || "(未填写)";
      const ctry = countries.get(countryKey) ?? newAcc(countryKey, countryKey);
      addCompany(ctry, row);
      countries.set(countryKey, ctry);

      const industryKey = row.industry?.trim() || "(未填写)";
      const ind = industries.get(industryKey) ?? newAcc(industryKey, industryKey);
      addCompany(ind, row);
      industries.set(industryKey, ind);
    }

    for (const roleRow of roles.results) {
      const row = metrics.get(roleRow.id);
      if (!row) continue;
      const acc = roleAccs.get(roleRow.role) ?? newAcc(roleRow.role, roleLabel(roleRow.role));
      // 角色查询按 (公司, 角色) DISTINCT —— 一家公司对每个角色只计一次。
      addCompany(acc, row);
      roleAccs.set(roleRow.role, acc);
    }

    const sequences = new Map<string, DimAcc>();
    const companiesBySequence = new Map<string, Set<string>>();
    for (const enr of enrollments.results) {
      const acc = sequences.get(enr.sequence_id) ?? newAcc(enr.sequence_id, enr.name);
      acc.enrolled++;
      if (enr.status === "active") acc.active++;
      else if (enr.status === "stopped") acc.stopped++;
      else if (enr.status === "completed") acc.completed++;
      const seen = companiesBySequence.get(enr.sequence_id) ?? new Set<string>();
      if (!seen.has(enr.company_id)) {
        seen.add(enr.company_id);
        const row = metrics.get(enr.company_id);
        if (row) addCompany(acc, row);
      }
      companiesBySequence.set(enr.sequence_id, seen);
      sequences.set(enr.sequence_id, acc);
    }

    return jsonResponse({
      available: true,
      sources: [...sources.values()].map(toResult).sort(byRevenue),
      countries: [...countries.values()].map(toResult).sort(byRevenue),
      industries: [...industries.values()].map(toResult).sort(byRevenue),
      roles: [...roleAccs.values()].map(toResult).sort(byRevenue),
      sequences: [...sequences.values()].map(toResult).sort(byRevenue),
    });
  } catch (error) {
    // 迁移 0038 未应用（source 列缺失）→ fail-open，面板提示应用迁移。
    safeLog("warn", "[crm-attribution] 归因统计不可用（fail-open）", error);
    return jsonResponse({
      available: false,
      sources: [],
      countries: [],
      industries: [],
      roles: [],
      sequences: [],
    });
  }
}
