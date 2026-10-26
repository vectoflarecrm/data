// CRM ↔ pipeline 状态联动 (合并.txt §二): CRM 销售层与研究/开发信流水线
// 共享同一个 D1。本模块是流水线侧的挂钩，规则只有两条：
//   1. CRM 里标记 disqualified（淘汰）的客户不再被开发信流水线触碰
//      （快照筛选、生成、发送都会跳过）；
//   2. 流水线的关键事件（开发信发出、AI 调研完成）回写 CRM 时间线，
//      发信成功同时把 lead_status 推进到 contacted。
//
// 一切 fail-open：CRM 表缺失（旧库/最小化测试 schema）或写入失败时，
// 绝不影响研究/发信主流程 —— 联动是增强，不是依赖。

import { safeLog } from "./security/safe-log";

/** Structurally the D1 binding — decoupled from AdminEnv so campaigns.ts
 * and index.ts can pass their env without importing admin.ts. */
export interface CrmHookEnv {
  DB: D1Database;
}

/** True when the CRM sales layer exists in this database. One indexed
 * sqlite_master read; false (never throws) on old databases and minimal
 * test schemas so callers can compose the exclusion SQL safely. */
export async function hasCrmCompaniesTable(env: CrmHookEnv): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'crm_companies'",
    ).first();
    return !!row;
  } catch {
    return false;
  }
}

/** SQL fragment (no binds): true when the pipeline row identified by
 * `idExpr` HAS been marked disqualified in the CRM — the positive form,
 * for UPDATE … SET status = 'skipped' sweeps. Compose ONLY after
 * hasCrmCompaniesTable(). */
export function crmDisqualifiedSql(idExpr: string): string {
  return `EXISTS (SELECT 1 FROM crm_companies cc WHERE cc.id = 'c_' || ${idExpr} AND cc.lead_status = 'disqualified')`;
}

/** SQL fragment (no binds): true when the pipeline row identified by
 * `idExpr` (e.g. "c.id" for an aliased customers scan, or the bare
 * "customer_id" column of outreach_campaign_members) has NOT been marked
 * disqualified in the CRM. Compose ONLY after hasCrmCompaniesTable(). */
export function crmNotDisqualifiedSql(idExpr: string): string {
  return `NOT EXISTS (SELECT 1 FROM crm_companies cc WHERE cc.id = 'c_' || ${idExpr} AND cc.lead_status = 'disqualified')`;
}

/** 开发信发送成功 → CRM 时间线 cold_email_sent + lead_status → contacted
 * (only new/enriched are promoted; contacted/qualified/disqualified keep
 * their state). No-op when the company was never promoted. */
export async function noteOutreachSent(
  env: CrmHookEnv,
  customerId: number,
  info: { emailId: number | null; emailTo: string | null; subject: string | null },
): Promise<void> {
  try {
    const company = await env.DB.prepare(
      "SELECT id, lead_status FROM crm_companies WHERE id = ?1",
    )
      .bind(`c_${customerId}`)
      .first<{ id: string; lead_status: string }>();
    if (!company) return;
    const stmts: D1PreparedStatement[] = [];
    if (company.lead_status === "new" || company.lead_status === "enriched") {
      stmts.push(
        env.DB.prepare(
          "UPDATE crm_companies SET lead_status = 'contacted', updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        ).bind(company.id),
      );
    }
    const summary =
      `开发信已发送: ${info.subject ?? "(无主题)"} → ${info.emailTo ?? "(无收件人)"}` +
      (info.emailId !== null ? `（outreach_emails#${info.emailId}）` : "");
    stmts.push(
      env.DB.prepare(
        `INSERT INTO crm_activities (id, company_id, type, summary)
         VALUES (?1, ?2, 'cold_email_sent', ?3)`,
      ).bind(crypto.randomUUID(), company.id, summary),
    );
    await env.DB.batch(stmts);
  } catch (error) {
    safeLog("warn", "[crm-hooks] noteOutreachSent failed (fail-open)", error);
  }
}

/** AI 调研完成 → CRM 时间线 ai_enrichment。INSERT…SELECT：公司未提升时
 * 静默无操作。 */
export async function noteResearchEnriched(
  env: CrmHookEnv,
  customerId: number,
  summary?: string,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO crm_activities (id, company_id, type, summary)
       SELECT ?1, id, 'ai_enrichment', ?2 FROM crm_companies WHERE id = ?3`,
    )
      .bind(
        crypto.randomUUID(),
        summary ?? "AI 调研完成，客户数据已更新（研究管线）",
        `c_${customerId}`,
      )
      .run();
  } catch (error) {
    safeLog("warn", "[crm-hooks] noteResearchEnriched failed (fail-open)", error);
  }
}

/** 逾期未完成任务列表（最早的在前，最多 `limit` 条），供 cron 日志汇总与
 * 面板逾期提醒。fail-open: 表缺失/查询失败返回空数组。 */
export async function listOverdueTasks(
  env: CrmHookEnv,
  limit = 20,
): Promise<Array<{ summary: string; due_date: string; company_name: string | null }>> {
  try {
    const rows = await env.DB.prepare(
      `SELECT a.summary, a.due_date, c.name AS company_name
       FROM crm_activities a LEFT JOIN crm_companies c ON c.id = a.company_id
       WHERE a.type = 'task' AND a.is_completed = 0 AND a.due_date IS NOT NULL AND a.due_date < date('now')
       ORDER BY a.due_date ASC LIMIT ?1`,
    )
      .bind(Math.min(Math.max(limit, 1), 100))
      .all<{ summary: string; due_date: string; company_name: string | null }>();
    return rows.results;
  } catch {
    return [];
  }
}
