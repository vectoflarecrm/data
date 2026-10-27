// 0038 ⑧ 销售任务与日历执行闭环（更新.txt 第 8 项，开发顺序阶段五）。
//
// 让销售人员每天打开系统就能看到最值得处理的客户：
//   - GET /admin/api/crm/calendar?month=YYYY-MM
//     月视图（按天分组的任务网格）+ 逾期任务（按公司价值排序，超时升级展示）
//     + 今日待办。
//   - GET /admin/api/crm/calendar.ics
//     RFC 5545 日历订阅源 —— 未结任务按 due_date 输出 VEVENT，
//     可导入 Google Calendar / 系统日历（日历同步，零 key）。
// 任务负责人（crm_activities.owner，0038）随任务展示；
// 自动下一步行动（阶段推进自动建任务）在 src/crm.ts updateDeal 里生成。

import { jsonResponse, type AdminEnv } from "./admin";
import { safeLog } from "./security/safe-log";

/** 公司价值权重：逾期/今日任务的排序依据（「最值得处理」）。 */
const TIER_WEIGHT: Record<string, number> = { VIP: 5, A: 4, B: 3, C: 2 };

export interface CalendarTask {
  id: string;
  company_id: string;
  company_name: string;
  tier: string;
  summary: string;
  due_date: string;
  owner: string | null;
  /** 逾期天数（due_date 早于今天的未完成任务）。 */
  overdue_days: number;
}

interface TaskQueryRow {
  id: string;
  company_id: string;
  company_name: string;
  tier: string;
  summary: string;
  due_date: string;
  owner: string | null;
  pipeline_amount: number;
}

const TASK_SELECT = `SELECT a.id, a.company_id, c.name AS company_name, c.tier,
       a.summary, a.due_date, a.owner,
       (SELECT IFNULL(SUM(d.amount), 0) FROM crm_deals d
        WHERE d.company_id = a.company_id AND d.archived_at IS NULL
          AND d.stage NOT IN ('won', 'lost')) AS pipeline_amount
  FROM crm_activities a
  JOIN crm_companies c ON c.id = a.company_id
 WHERE a.type = 'task' AND a.is_completed = 0 AND a.due_date IS NOT NULL`;

function toTask(row: TaskQueryRow, today: string): CalendarTask {
  return {
    id: row.id,
    company_id: row.company_id,
    company_name: row.company_name,
    tier: row.tier,
    summary: row.summary,
    due_date: row.due_date,
    owner: row.owner,
    overdue_days: row.due_date < today ? daysBetween(row.due_date, today) : 0,
  };
}

function daysBetween(fromIsoDate: string, toIsoDate: string): number {
  const from = Date.parse(`${fromIsoDate}T00:00:00Z`);
  const to = Date.parse(`${toIsoDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86400000));
}

/** 「最值得处理」排序：逾期久 → 公司分级高 → 未结商机金额大 → 到期早。 */
function byValue(a: TaskQueryRow, b: TaskQueryRow): number {
  return (
    (TIER_WEIGHT[b.tier] ?? 1) - (TIER_WEIGHT[a.tier] ?? 1) ||
    b.pipeline_amount - a.pipeline_amount ||
    (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0)
  );
}

/** GET /admin/api/crm/calendar?month=YYYY-MM：月网格 + 逾期 + 今日待办。 */
export async function getTaskCalendar(env: AdminEnv, url: URL): Promise<Response> {
  const today = new Date().toISOString().slice(0, 10);
  const monthParam = (url.searchParams.get("month") ?? "").trim();
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam)
    ? monthParam
    : today.slice(0, 7);
  const monthStart = `${month}-01`;
  // 次月 1 号（字符串比较边界，含当月最后一天）。
  const [year, mon] = month.split("-").map(Number);
  const next = mon === 12 ? `${year + 1}-01-01` : `${year}-${String(mon + 1).padStart(2, "0")}-01`;

  try {
    const rows = (
      await env.DB.prepare(`${TASK_SELECT} ORDER BY a.due_date ASC LIMIT 1000`).all<TaskQueryRow>()
    ).results;

    const days: Record<string, CalendarTask[]> = {};
    const overdue: CalendarTask[] = [];
    const todayList: CalendarTask[] = [];
    let monthOpen = 0;
    for (const row of rows) {
      // 每个视图独立 toTask 实例：同一任务会同时出现在 overdue/today/days，
      // jsonResponse 的 sanitizeResponse 用共享 WeakSet 做环检测，共享同一
      // 对象引用会被误判成循环 → 第二处整体变 "[REDACTED]"。
      if (row.due_date < today) overdue.push(toTask(row, today));
      if (row.due_date === today) todayList.push(toTask(row, today));
      if (row.due_date >= monthStart && row.due_date < next) {
        monthOpen++;
        const list = days[row.due_date] ?? [];
        list.push(toTask(row, today));
        days[row.due_date] = list;
      }
    }
    // 逾期与今日按公司价值排序（超时升级：逾期置顶，按逾期天数展示）。
    overdue.sort(
      (a, b) =>
        b.overdue_days - a.overdue_days ||
        (TIER_WEIGHT[b.tier] ?? 1) - (TIER_WEIGHT[a.tier] ?? 1),
    );
    const sortRows = (list: CalendarTask[]): CalendarTask[] =>
      [...list].sort(
        (a, b) => (TIER_WEIGHT[b.tier] ?? 1) - (TIER_WEIGHT[a.tier] ?? 1) || a.due_date.localeCompare(b.due_date),
      );

    return jsonResponse({
      month,
      today,
      days,
      overdue,
      today_tasks: sortRows(todayList),
      counts: { month_open: monthOpen, overdue: overdue.length, today: todayList.length },
    });
  } catch (error) {
    safeLog("warn", "[crm-calendar] 日历不可用（fail-open）", error);
    return jsonResponse(
      { month, today, days: {}, overdue: [], today_tasks: [], counts: { month_open: 0, overdue: 0, today: 0 } },
    );
  }
}

/* ── ICS 订阅源（RFC 5545） ──────────────────────────────────────────────── */

/** RFC 5545 TEXT 转义：反斜杠/分号/逗号/换行。 */
export function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** RFC 5545 行序列化：CRLF 行尾（§3.1），超长行 75 字节折叠省略（任务标题短）。 */
function icsLines(lines: string[]): string {
  return `${lines.join("\r\n")}\r\n`;
}

/** GET /admin/api/crm/calendar.ics：未结任务（含逾期）的 VEVENT 订阅源。 */
export async function buildIcsFeed(env: AdminEnv): Promise<Response> {
  const now = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//VectoflareCRM//Task Calendar//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:CRM 销售任务",
  ];
  try {
    const rows = (
      await env.DB.prepare(`${TASK_SELECT} ORDER BY a.due_date ASC LIMIT 500`).all<TaskQueryRow>()
    ).results;
    for (const row of rows) {
      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${row.id}@vectoflarecrm`);
      lines.push(`DTSTAMP:${now}`);
      lines.push(`DTSTART;VALUE=DATE:${row.due_date.replace(/-/g, "")}`);
      lines.push(`SUMMARY:${escapeIcsText(`[${row.company_name}] ${row.summary}`)}`);
      lines.push(
        `DESCRIPTION:${escapeIcsText(
          `公司: ${row.company_name}${row.owner ? `；负责人: ${row.owner}` : ""}；状态: 未完成`,
        )}`,
      );
      lines.push("END:VEVENT");
    }
  } catch (error) {
    safeLog("warn", "[crm-calendar] ICS 生成失败（fail-open，输出空日历）", error);
  }
  lines.push("END:VCALENDAR");
  return new Response(icsLines(lines), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
