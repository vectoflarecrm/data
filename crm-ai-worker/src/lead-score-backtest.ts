/* 更新.txt 四.4 + 模块 D「评分模型的历史效果校准」（0041）：
 *
 * 用真实销售结果回测 lead_score 的区分度——各分段（≥80 / 60-79 / 40-59 /
 * <40）的触达、人工回复、意向、商机、成交对比 + 六维度分与结果的相关性，
 * 输出权重校准建议。纯只读计算（零迁移、零写入）：
 *
 *   触达   outreach_emails(customer_id, status='sent') —— 所有出站邮件
 *          （手动批量 / 群发 / 序列）共用这一草稿表；
 *   回复   crm_activities(type='email_received')，排除【退信】与
 *          【自动回复】（mailer-daemon 与 OOF 不是人写的）；
 *   意向   同上但前缀【疑似意向】（contactability.ts 分类）；
 *   商机/成交 crm_deals(company_id='c_'||customers.id)，成交 stage='won'
 *          （promoteLead 保留 customers 行，'c_' 前缀 join 恒有效）；
 *   维度分 customers.lead_score_breakdown（lead-score-v2 JSON）。
 *
 * 口径注意：lead_score 是「当前值」——重算/重新研究会改写历史客户的分数，
 * 回测结果是与当前评分口径的对比，不是发信那一刻的前瞻预测（面板文案已注明）。
 */

import { LEAD_SCORE_DIMENSIONS } from "./lead-score-dims";

export interface LeadScoreBacktestEnv {
  DB: D1Database;
}

/** 中文标签（面板/建议文案用），键序与 LEAD_SCORE_DIMENSIONS 一致。 */
export const BACKTEST_DIM_LABELS: Record<string, string> = {
  icp_fit: "ICP 匹配",
  product_fit: "产品匹配",
  buyer_role: "买家角色",
  buying_signal: "采购信号",
  reachability: "可触达性",
  strategic_value: "战略价值",
};

/** 样本量门槛：低于此值不产出区分度结论（避免小样本误判）。 */
export const BACKTEST_MIN_SAMPLE = 30;

export interface BacktestTierRow {
  tier: string;
  scored: number;
  contacted: number;
  replied: number;
  interested: number;
  deals: number;
  won: number;
}

export interface BacktestDimensionRow {
  dim: string;
  label: string;
  avg_all: number;
  avg_won: number;
  avg_replied: number;
  avg_not_replied: number;
}

export interface LeadScoreBacktestReport {
  generated_at: string;
  total_scored: number;
  tiers: BacktestTierRow[];
  dimensions: BacktestDimensionRow[];
  /** 一句话结论（样本是否足够、评分是否有效区分结果）。 */
  verdict: string;
  /** 权重校准建议（可为空数组——样本不足时不硬凑建议）。 */
  advice: string[];
}

interface OutcomeRow {
  id: number;
  lead_score: number;
  lead_score_breakdown: string | null;
  contacted: number;
  replies: number;
  interests: number;
  has_deal: number;
  won: number;
}

const TIER_DEFS: Array<{ tier: string; min: number; max: number }> = [
  { tier: "≥80 高优先", min: 80, max: 100000 },
  { tier: "60-79 优质", min: 60, max: 79 },
  { tier: "40-59 观察", min: 40, max: 59 },
  { tier: "<40 低分", min: -1, max: 39 },
];

const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);

/** 解析 lead_score_breakdown JSON（容错：旧库/损坏行返回 null）。 */
function parseBreakdown(raw: string | null): Record<string, number> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const out: Record<string, number> = {};
    for (const dim of LEAD_SCORE_DIMENSIONS) {
      const v = (parsed as Record<string, unknown>)[dim];
      if (typeof v === "number" && Number.isFinite(v)) out[dim] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** 维度均值辅助：返回 (dim → 均值，保留 1 位小数)。 */
function dimAverages(rows: Array<Record<string, number>>): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const dim of LEAD_SCORE_DIMENSIONS) sums[dim] = 0;
  for (const r of rows) for (const dim of LEAD_SCORE_DIMENSIONS) sums[dim] += r[dim] ?? 0;
  const out: Record<string, number> = {};
  for (const dim of LEAD_SCORE_DIMENSIONS) out[dim] = rows.length > 0 ? Math.round((sums[dim] / rows.length) * 10) / 10 : 0;
  return out;
}

/** 计算 + 汇总评分回测报告。调用方负责错误处理（路由层 500 带 detail，
 * 面板显示错误——缺表属于部署异常，不该静默成全零报表）。 */
export async function getLeadScoreBacktest(env: LeadScoreBacktestEnv): Promise<LeadScoreBacktestReport> {
  const rows = await env.DB.prepare(
    `SELECT cu.id, cu.lead_score, cu.lead_score_breakdown,
       EXISTS(SELECT 1 FROM outreach_emails oe WHERE oe.customer_id = cu.id AND oe.status = 'sent') AS contacted,
       (SELECT COUNT(*) FROM crm_activities a WHERE a.company_id = 'c_' || cu.id AND a.type = 'email_received'
          AND a.summary NOT LIKE '【退信】%' AND a.summary NOT LIKE '【自动回复】%') AS replies,
       (SELECT COUNT(*) FROM crm_activities a WHERE a.company_id = 'c_' || cu.id AND a.type = 'email_received'
          AND a.summary LIKE '【疑似意向】%') AS interests,
       EXISTS(SELECT 1 FROM crm_deals d WHERE d.company_id = 'c_' || cu.id) AS has_deal,
       EXISTS(SELECT 1 FROM crm_deals d WHERE d.company_id = 'c_' || cu.id AND d.stage = 'won') AS won
     FROM customers cu
     WHERE cu.status = 'completed' AND cu.lead_score IS NOT NULL`,
  ).all<OutcomeRow>();
  const outcomes = rows.results ?? [];
  const totalScored = outcomes.length;

  // 分段漏斗
  const tiers: BacktestTierRow[] = TIER_DEFS.map((t) => {
    const bucket = outcomes.filter((o) => o.lead_score >= t.min && o.lead_score <= t.max);
    return {
      tier: t.tier,
      scored: bucket.length,
      contacted: bucket.filter((o) => o.contacted === 1).length,
      replied: bucket.filter((o) => o.replies > 0).length,
      interested: bucket.filter((o) => o.interests > 0).length,
      deals: bucket.filter((o) => o.has_deal === 1).length,
      won: bucket.filter((o) => o.won === 1).length,
    };
  });

  // 维度均值：全体 / 已成交 / 已回复 / 未回复（有人工回复证据的客户）
  const breakdownRows = outcomes
    .map((o) => parseBreakdown(o.lead_score_breakdown))
    .filter((b): b is Record<string, number> => b !== null);
  const withFlag = outcomes.filter((o) => parseBreakdown(o.lead_score_breakdown) !== null);
  const wonRows: Array<Record<string, number>> = [];
  const repliedRows: Array<Record<string, number>> = [];
  const notRepliedRows: Array<Record<string, number>> = [];
  withFlag.forEach((o, i) => {
    const b = breakdownRows[i];
    if (o.won === 1) wonRows.push(b);
    if (o.replies > 0) repliedRows.push(b);
    else notRepliedRows.push(b);
  });
  const allAvg = dimAverages(breakdownRows);
  const wonAvg = dimAverages(wonRows);
  const repliedAvg = dimAverages(repliedRows);
  const notRepliedAvg = dimAverages(notRepliedRows);
  const dimensions: BacktestDimensionRow[] = LEAD_SCORE_DIMENSIONS.map((dim) => ({
    dim,
    label: BACKTEST_DIM_LABELS[dim] ?? dim,
    avg_all: allAvg[dim],
    avg_won: wonAvg[dim],
    avg_replied: repliedAvg[dim],
    avg_not_replied: notRepliedAvg[dim],
  }));

  // 结论与建议
  const { verdict, advice } = buildVerdict(totalScored, tiers, dimensions, wonRows.length);
  return {
    generated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
    total_scored: totalScored,
    tiers,
    dimensions,
    verdict,
    advice,
  };
}

function buildVerdict(
  totalScored: number,
  tiers: BacktestTierRow[],
  dimensions: BacktestDimensionRow[],
  wonCount: number,
): { verdict: string; advice: string[] } {
  const advice: string[] = [];
  if (totalScored < BACKTEST_MIN_SAMPLE) {
    return {
      verdict: `样本不足：仅 ${totalScored} 家已评分客户（建议 ≥${BACKTEST_MIN_SAMPLE} 家）。先运行发现规则/导入补充线索并完成研究，再回测。`,
      advice,
    };
  }
  const totalWon = tiers.reduce((acc, t) => acc + t.won, 0);
  const totalDeals = tiers.reduce((acc, t) => acc + t.deals, 0);
  const totalReplied = tiers.reduce((acc, t) => acc + t.replied, 0);
  if (totalWon === 0 && totalDeals === 0 && totalReplied === 0) {
    return {
      verdict: `已评分 ${totalScored} 家，但还没有回复/商机/成交事件——评分的有效性无法验证。触达积累结果后重新回测。`,
      advice,
    };
  }
  // 主指标优先级：成交 > 商机 > 回复（有更接近钱的结果就不看浅层指标）。
  const metric = totalWon > 0 ? "won" : totalDeals > 0 ? "deals" : "replied";
  const metricLabel = metric === "won" ? "成交率" : metric === "deals" ? "商机率" : "回复率";
  const rateOf = (t: BacktestTierRow): number =>
    metric === "replied" ? pct(t.replied, t.contacted) : pct(t[metric], t.scored);
  const high = tiers[0];
  const low = tiers[tiers.length - 1];
  const highRate = rateOf(high);
  const lowRate = rateOf(low);
  if (highRate > lowRate) {
    const ratio = lowRate > 0 ? Math.round((highRate / lowRate) * 10) / 10 : 0;
    advice.push(
      `高分段${metricLabel} ${highRate}%${lowRate > 0 ? ` ≈ 低分段的 ${ratio} 倍` : "（低分段为 0）"}——评分方向有效，维持当前权重结构，优先触达高分客户。`,
    );
  } else if (highRate === lowRate) {
    advice.push(`高低分段${metricLabel}相同（${highRate}%）——当前评分对${metricLabel}没有区分度，建议调整维度权重后「重算存量评分」再回测对比。`);
  } else {
    advice.push(`高分段${metricLabel}（${highRate}%）反而低于低分段（${lowRate}%）——评分与真实结果反向，优先核查权重配置或样本构成，再考虑重算。`);
  }
  // 维度建议：成交样本 ≥5 时，对比成交客户与全体的维度均值。
  if (wonCount >= 5) {
    const sorted = [...dimensions].sort((a, b) => b.avg_won - b.avg_all - (a.avg_won - a.avg_all));
    const top = sorted[0];
    const bottom = sorted[sorted.length - 1];
    if (top.avg_won - top.avg_all > 0.5) {
      advice.push(`「${top.label}」维度在成交客户中均值最高（${top.avg_won} vs 全体 ${top.avg_all}）——与成交正相关，可考虑上调权重。`);
    }
    if (bottom.avg_won - bottom.avg_all < -0.5) {
      advice.push(`「${bottom.label}」维度在成交客户中反而更低（${bottom.avg_won} vs 全体 ${bottom.avg_all}）——与成交负相关，可考虑下调权重。`);
    }
  }
  advice.push("口径说明：lead_score 为当前值（重算会改写历史分数），回测对比的是当前评分口径与历史结果的匹配度。调整权重后先「重算存量评分」再回测，才能看到新口径的效果。");
  return {
    verdict: `已评分 ${totalScored} 家：回复 ${totalReplied}、商机 ${totalDeals}、成交 ${totalWon}。按${metricLabel}对比各分段见下表。`,
    advice,
  };
}
