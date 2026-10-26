/* 多步销售序列引擎（更新.txt 第 3 项 / 审查报告 P0-3）。
 *
 * 现有「群发自动推进」是一次性草稿→发送状态机；本模块把触达升级为
 * 时间驱动的序列：入册（公司+联系人邮箱）后按步骤 day_offset 天数依次
 * 发送模板邮件（占位符 {{company}}/{{contact_name}}/{{country}}/
 * {{domain}}/{{sender_name}} 渲染），cron 空闲 tick 推进到期步骤。
 *
 * 终止规则（更新.txt：「等待指定天数、客户回复后停止、退信后退出」）：
 *   - 客户回复（入册后该公司出现 email_received 时间线）→ 自动停止；
 *   - 退订 / 禁止联系 / invalid 邮箱（isContactBlocked）→ 自动停止；
 *   - 连续 MAX_SEND_FAILURES 次发送失败 → 自动停止；
 *   - 全部步骤发完 → completed；
 *   - 人工暂停 / 恢复 / 停止走 API（面板按钮）。
 *
 * 复用现有保证：实际发送走 sendOutreachEmail 单一出口（配额预留 +
 * 发送前统一策略检查 + gmail_send_log 审计），序列引擎绝不旁路发信。
 * 全部 fail-open：序列表缺失时 tick 直接跳过，不影响 cron 主流程。
 */

import {
  jsonResponse,
  type AdminEnv,
} from "./admin";
import { sendOutreachEmail } from "./gmail";
import { isContactBlocked } from "./contactability";
import { safeLog } from "./security/safe-log";

export interface SequenceTickReport {
  sent: number;
  stopped: number;
  completed: number;
  deferred: number;
  errors: number;
}

/** 每 tick 最多推进的入册数：免费版 Worker 子请求预算友好。 */
const TICK_BATCH = 8;
/** 连续发送失败达到该值 → 终止序列（保留已发步骤，不再重试）。 */
const MAX_SEND_FAILURES = 3;
/** 发送失败后的重试间隔（毫秒）。 */
const RETRY_DELAY_MS = 30 * 60 * 1000;
/** 序列被停用（enabled=0）时入册的延后间隔，避免占满 tick 批次。 */
const DISABLED_DEFER_MS = 6 * 3600 * 1000;
/** 单序列最多步骤数。 */
const MAX_STEPS = 10;

interface EnrollmentRow {
  id: string;
  sequence_id: string;
  company_id: string;
  contact_id: string | null;
  contact_email: string;
  current_step: number;
  next_due_at: string;
  status: string;
  stop_reason: string | null;
  send_failures: number;
  enrolled_at: string;
  brand_name: string;
  sequence_enabled: number;
}

interface StepRow {
  step_no: number;
  day_offset: number;
  subject: string;
  body: string;
}

/* ── 模板渲染 ────────────────────────────────────────────────────────────── */

export function renderSequenceTemplate(
  template: string,
  vars: { company: string; contact_name: string; country: string; domain: string; sender_name: string },
): string {
  return template
    .replace(/\{\{\s*company\s*\}\}/g, vars.company)
    .replace(/\{\{\s*contact_name\s*\}\}/g, vars.contact_name)
    .replace(/\{\{\s*country\s*\}\}/g, vars.country)
    .replace(/\{\{\s*domain\s*\}\}/g, vars.domain)
    .replace(/\{\{\s*sender_name\s*\}\}/g, vars.sender_name);
}

function dueFromEnrollment(enrolledAt: string, dayOffset: number): string {
  const base = Date.parse(enrolledAt);
  return new Date((Number.isFinite(base) ? base : Date.now()) + dayOffset * 24 * 3600 * 1000).toISOString();
}

/* ── 序列 CRUD（供 crm.ts 的 HTTP handler 调用） ────────────────────────── */

export interface SequenceStepInput {
  day_offset: number;
  subject: string;
  body: string;
}

function reqSteps(value: unknown): SequenceStepInput[] {
  if (!Array.isArray(value) || !value.length) throw new Error("steps 不能为空（至少 1 步）");
  if (value.length > MAX_STEPS) throw new Error(`steps 最多 ${MAX_STEPS} 步`);
  const steps: SequenceStepInput[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) throw new Error("steps 每项必须是对象");
    const r = raw as Record<string, unknown>;
    const dayOffset = Number(r.day_offset ?? 0);
    if (!Number.isInteger(dayOffset) || dayOffset < 0 || dayOffset > 90) {
      throw new Error("day_offset 需为 0-90 的整数（入册后第 N 天发送）");
    }
    const subject = typeof r.subject === "string" ? r.subject.trim() : "";
    if (!subject || subject.length > 200) throw new Error("每步 subject 必填（≤200 字符）");
    const body = typeof r.body === "string" ? r.body.trim() : "";
    if (!body || body.length > 8000) throw new Error("每步 body 必填（≤8000 字符）");
    steps.push({ day_offset: dayOffset, subject, body });
  }
  steps.sort((a, b) => a.day_offset - b.day_offset);
  return steps;
}

export async function createSequenceInDb(
  env: AdminEnv,
  input: { name: string; brand_name: string; steps: SequenceStepInput[] },
): Promise<{ id: string; steps: number }> {
  const steps = reqSteps(input.steps);
  const id = crypto.randomUUID();
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("INSERT INTO crm_sequences (id, name, brand_name) VALUES (?1, ?2, ?3)")
      .bind(id, input.name, input.brand_name),
  ];
  for (let i = 0; i < steps.length; i++) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO crm_sequence_steps (id, sequence_id, step_no, day_offset, subject, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ).bind(crypto.randomUUID(), id, i, steps[i].day_offset, steps[i].subject, steps[i].body),
    );
  }
  await env.DB.batch(stmts);
  return { id, steps: steps.length };
}

export async function listSequencesWithCounts(env: AdminEnv): Promise<Response> {
  const sequences = await env.DB.prepare(
    `SELECT s.id, s.name, s.brand_name, s.enabled, s.created_at,
       (SELECT COUNT(*) FROM crm_sequence_steps st WHERE st.sequence_id = s.id) AS step_count,
       (SELECT COUNT(*) FROM crm_sequence_enrollments e WHERE e.sequence_id = s.id AND e.status = 'active') AS active_count,
       (SELECT COUNT(*) FROM crm_sequence_enrollments e WHERE e.sequence_id = s.id) AS total_count
     FROM crm_sequences s ORDER BY s.created_at DESC`,
  ).all<{
    id: string; name: string; brand_name: string; enabled: number; created_at: string;
    step_count: number; active_count: number; total_count: number;
  }>();
  const steps = await env.DB.prepare(
    "SELECT sequence_id, step_no, day_offset, subject FROM crm_sequence_steps ORDER BY sequence_id, step_no",
  ).all<{ sequence_id: string; step_no: number; day_offset: number; subject: string }>();
  const bySeq = new Map<string, Array<{ step_no: number; day_offset: number; subject: string }>>();
  for (const st of steps.results) {
    const list = bySeq.get(st.sequence_id) ?? [];
    list.push({ step_no: st.step_no, day_offset: st.day_offset, subject: st.subject });
    bySeq.set(st.sequence_id, list);
  }
  return jsonResponse({
    sequences: sequences.results.map((s) => ({ ...s, steps: bySeq.get(s.id) ?? [] })),
  });
}

export async function setSequenceEnabledInDb(env: AdminEnv, id: string, enabled: boolean): Promise<void> {
  const r = await env.DB.prepare("UPDATE crm_sequences SET enabled = ?1 WHERE id = ?2").bind(enabled ? 1 : 0, id).run();
  if (!(r.meta?.changes ?? 0)) throw new Error("序列不存在");
}

export async function deleteSequenceInDb(env: AdminEnv, id: string): Promise<void> {
  const r = await env.DB.prepare("DELETE FROM crm_sequences WHERE id = ?1").bind(id).run();
  if (!(r.meta?.changes ?? 0)) throw new Error("序列不存在");
}

export async function listEnrollmentsFor(env: AdminEnv, sequenceId: string): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT e.*, c.name AS company_name
     FROM crm_sequence_enrollments e LEFT JOIN crm_companies c ON c.id = e.company_id
     WHERE e.sequence_id = ?1
     ORDER BY CASE e.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, e.next_due_at`,
  )
    .bind(sequenceId)
    .all<{ id: string; company_id: string; company_name: string | null; contact_email: string; current_step: number; next_due_at: string; status: string; stop_reason: string | null; send_failures: number; enrolled_at: string }>();
  return jsonResponse({ enrollments: rows.results });
}

/* ── 入册 ────────────────────────────────────────────────────────────────── */

export async function enrollInSequence(
  env: AdminEnv,
  sequenceId: string,
  companyId: string,
  requested: { contact_id?: string; contact_email?: string },
): Promise<{ enrollment: { id: string; contact_email: string }; reEnrolled: boolean }> {
  const sequence = await env.DB.prepare(
    "SELECT id, enabled, name FROM crm_sequences WHERE id = ?1",
  ).bind(sequenceId).first<{ id: string; enabled: number; name: string }>();
  if (!sequence) throw new Error("序列不存在");
  if (!sequence.enabled) throw new Error("序列已停用，无法入册");

  const company = await env.DB.prepare(
    "SELECT id, name FROM crm_companies WHERE id = ?1",
  ).bind(companyId).first<{ id: string; name: string }>();
  if (!company) throw new Error("公司不存在");

  // 联系人解析：显式 contact_id / contact_email → 主联系人 → 第一个有邮箱的联系人。
  let contactId: string | null = null;
  let contactEmail: string | null = null;
  if (requested.contact_id) {
    const c = await env.DB.prepare(
      "SELECT id, email FROM crm_contacts WHERE id = ?1 AND company_id = ?2",
    ).bind(requested.contact_id, companyId).first<{ id: string; email: string | null }>();
    if (!c) throw new Error("联系人不存在或不属于该公司");
    contactId = c.id;
    contactEmail = c.email?.trim().toLowerCase() ?? null;
  } else if (requested.contact_email) {
    contactEmail = requested.contact_email.trim().toLowerCase();
    const c = await env.DB.prepare(
      "SELECT id FROM crm_contacts WHERE company_id = ?1 AND lower(IFNULL(email, '')) = ?2",
    ).bind(companyId, contactEmail).first<{ id: string }>();
    contactId = c?.id ?? null;
  } else {
    const c = await env.DB.prepare(
      `SELECT id, email FROM crm_contacts
       WHERE company_id = ?1 AND email IS NOT NULL AND TRIM(email) != ''
       ORDER BY is_primary DESC, created_at LIMIT 1`,
    ).bind(companyId).first<{ id: string; email: string | null }>();
    if (!c) throw new Error("公司没有带邮箱的联系人，无法入册");
    contactId = c.id;
    contactEmail = (c.email ?? "").trim().toLowerCase();
  }
  if (!contactEmail) throw new Error("联系人没有邮箱，无法入册");

  const steps = await env.DB.prepare(
    "SELECT step_no, day_offset FROM crm_sequence_steps WHERE sequence_id = ?1 ORDER BY step_no LIMIT 1",
  ).bind(sequenceId).all<{ day_offset: number }>();
  const firstOffset = steps.results[0]?.day_offset ?? 0;
  const now = new Date().toISOString();

  const existing = await env.DB.prepare(
    "SELECT id, status FROM crm_sequence_enrollments WHERE sequence_id = ?1 AND contact_email = ?2",
  ).bind(sequenceId, contactEmail).first<{ id: string; status: string }>();
  if (existing) {
    if (existing.status === "active") throw new Error("该联系人已在此序列中（进行中），请先停止或暂停");
    // 重新入册：终止/完成/暂停状态一律从头开始。
    await env.DB.prepare(
      `UPDATE crm_sequence_enrollments
       SET company_id = ?1, contact_id = ?2, current_step = 0, next_due_at = ?3, status = 'active',
           stop_reason = NULL, send_failures = 0, enrolled_at = ?4, updated_at = ?4
       WHERE id = ?5`,
    ).bind(companyId, contactId, dueFromEnrollment(now, firstOffset), now, existing.id).run();
    await noteTimeline(env, companyId, `重新加入销售序列「${sequence.name}」（${contactEmail}）`);
    return { enrollment: { id: existing.id, contact_email: contactEmail }, reEnrolled: true };
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO crm_sequence_enrollments
       (id, sequence_id, company_id, contact_id, contact_email, current_step, next_due_at, status, enrolled_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 'active', ?7, ?7)`,
  ).bind(id, sequenceId, companyId, contactId, contactEmail, dueFromEnrollment(now, firstOffset), now).run();
  await noteTimeline(env, companyId, `加入销售序列「${sequence.name}」（${contactEmail}）`);
  return { enrollment: { id, contact_email: contactEmail }, reEnrolled: false };
}

export async function setEnrollmentStatusInDb(
  env: AdminEnv,
  enrollmentId: string,
  status: "active" | "paused" | "stopped",
  reason: string | null,
): Promise<void> {
  const existing = await env.DB.prepare(
    "SELECT id, company_id FROM crm_sequence_enrollments WHERE id = ?1",
  ).bind(enrollmentId).first<{ id: string; company_id: string }>();
  if (!existing) throw new Error("入册记录不存在");
  const sets = ["status = ?2", "updated_at = ?3"];
  const binds: unknown[] = [enrollmentId, status, new Date().toISOString()];
  if (status === "stopped") {
    sets.push("stop_reason = ?4");
    binds.push(reason ?? "人工停止");
  } else if (status === "active") {
    // 恢复：清掉终止原因；仍处于原步骤，到期时间顺延到「现在 + 1 分钟」。
    sets.push("stop_reason = NULL", "next_due_at = ?4");
    binds.push(new Date(Date.now() + 60_000).toISOString());
  }
  await env.DB.prepare(`UPDATE crm_sequence_enrollments SET ${sets.join(", ")} WHERE id = ?1`)
    .bind(...binds)
    .run();
  if (status === "stopped") {
    await noteTimeline(env, existing.company_id, `销售序列人工停止${reason ? `：${reason}` : ""}`);
  }
}

async function noteTimeline(env: AdminEnv, companyId: string, summary: string): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO crm_activities (id, company_id, type, summary) VALUES (?1, ?2, 'note', ?3)",
    ).bind(crypto.randomUUID(), companyId, summary).run();
  } catch (error) {
    safeLog("warn", "[sequences] 时间线写入失败（fail-open）", error);
  }
}

/* ── Cron tick：推进到期步骤 ─────────────────────────────────────────────── */

export async function runSequenceTick(env: AdminEnv): Promise<SequenceTickReport> {
  const report: SequenceTickReport = { sent: 0, stopped: 0, completed: 0, deferred: 0, errors: 0 };
  let rows: { results: EnrollmentRow[] };
  try {
    rows = await env.DB.prepare(
      `SELECT e.*, s.brand_name, s.enabled AS sequence_enabled
       FROM crm_sequence_enrollments e JOIN crm_sequences s ON s.id = e.sequence_id
       WHERE e.status = 'active' AND e.next_due_at <= ?1
       ORDER BY e.next_due_at LIMIT ${TICK_BATCH}`,
    ).bind(new Date().toISOString()).all<EnrollmentRow>();
  } catch (error) {
    safeLog("warn", "[sequences] 序列表不可用，跳过本 tick（fail-open）", error);
    return report;
  }
  const stepCache = new Map<string, StepRow[]>();
  for (const en of rows.results) {
    try {
      await processEnrollment(env, en, stepCache, report);
    } catch (error) {
      report.errors++;
      safeLog("warn", `[sequences] 入册 ${en.id} 处理失败（跳过，下 tick 重试）`, error);
    }
  }
  if (report.sent || report.stopped || report.completed || report.errors) {
    safeLog(
      "log",
      `[sequences] tick: sent=${report.sent} stopped=${report.stopped} completed=${report.completed} deferred=${report.deferred} errors=${report.errors}`,
    );
  }
  return report;
}

async function loadSteps(env: AdminEnv, sequenceId: string, cache: Map<string, StepRow[]>): Promise<StepRow[]> {
  const hit = cache.get(sequenceId);
  if (hit) return hit;
  const rows = await env.DB.prepare(
    "SELECT step_no, day_offset, subject, body FROM crm_sequence_steps WHERE sequence_id = ?1 ORDER BY step_no",
  ).bind(sequenceId).all<StepRow>();
  const steps = rows.results;
  cache.set(sequenceId, steps);
  return steps;
}

async function stopEnrollment(
  env: AdminEnv,
  en: EnrollmentRow,
  reason: string,
  report: SequenceTickReport,
  timelineNote: boolean,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE crm_sequence_enrollments SET status = 'stopped', stop_reason = ?2, updated_at = ?3 WHERE id = ?1`,
  ).bind(en.id, reason, new Date().toISOString()).run();
  report.stopped++;
  if (timelineNote) {
    await noteTimeline(env, en.company_id, `销售序列自动终止：${reason}（${en.contact_email}）`);
  }
}

async function processEnrollment(
  env: AdminEnv,
  en: EnrollmentRow,
  stepCache: Map<string, StepRow[]>,
  report: SequenceTickReport,
): Promise<void> {
  // 序列被停用：入册延后，避免占满 tick 批次。
  if (!en.sequence_enabled) {
    await env.DB.prepare("UPDATE crm_sequence_enrollments SET next_due_at = ?2 WHERE id = ?1")
      .bind(en.id, new Date(Date.now() + DISABLED_DEFER_MS).toISOString()).run();
    report.deferred++;
    return;
  }

  // 终止规则 1：客户已回复（入册后该公司出现该联系人的 email_received）。
  // datetime(?2) 把 ISO（带 T/Z）的 enrolled_at 归一成 created_at 的
  // "YYYY-MM-DD HH:MM:SS" 格式再比较，避免两种格式字符串直接比较恒假。
  const replied = await env.DB.prepare(
    `SELECT id FROM crm_activities
     WHERE company_id = ?1 AND type = 'email_received' AND created_at >= datetime(?2)
       AND summary LIKE '%' || ?3 || '%' LIMIT 1`,
  ).bind(en.company_id, en.enrolled_at, en.contact_email).first<{ id: string }>();
  if (replied) {
    await stopEnrollment(env, en, "客户已回复，转人工跟进", report, true);
    return;
  }

  // 终止规则 2：退订 / 禁止联系 / invalid 邮箱（发送前检查同一套规则）。
  const blocked = await isContactBlocked(env, en.contact_email);
  if (blocked.blocked) {
    await stopEnrollment(env, en, `触达抑制：${blocked.reason}`, report, true);
    return;
  }

  const steps = await loadSteps(env, en.sequence_id, stepCache);
  if (!steps.length) {
    await stopEnrollment(env, en, "序列没有任何步骤（配置错误）", report, false);
    return;
  }
  if (en.current_step >= steps.length) {
    // 兜底：状态机异常时收敛为 completed，绝不无限重发。
    await env.DB.prepare(
      "UPDATE crm_sequence_enrollments SET status = 'completed', updated_at = ?2 WHERE id = ?1",
    ).bind(en.id, new Date().toISOString()).run();
    report.completed++;
    return;
  }

  const step = steps[en.current_step];
  const company = await env.DB.prepare(
    "SELECT name, country, domain FROM crm_companies WHERE id = ?1",
  ).bind(en.company_id).first<{ name: string; country: string | null; domain: string | null }>();
  if (!company) {
    await stopEnrollment(env, en, "公司已删除", report, false);
    return;
  }
  const contact = en.contact_id
    ? await env.DB.prepare("SELECT full_name FROM crm_contacts WHERE id = ?1")
        .bind(en.contact_id).first<{ full_name: string }>()
    : null;
  const settings = await env.DB.prepare(
    "SELECT sender_email, sender_name, gmail_account FROM outreach_settings WHERE brand_name = ?1",
  ).bind(en.brand_name).first<{ sender_email: string | null; sender_name: string | null; gmail_account: string | null }>();

  const vars = {
    company: company.name,
    contact_name: contact?.full_name ?? en.contact_email,
    country: company.country ?? "",
    domain: company.domain ?? "",
    sender_name: settings?.sender_name ?? "",
  };
  const subject = renderSequenceTemplate(step.subject, vars);
  const body = renderSequenceTemplate(step.body, vars);

  // 与群发共用 outreach_emails 表：草稿 → sendOutreachEmail（配额预留 +
  // 发送前拦截 + gmail_send_log 审计 + status='sent' 翻转）。
  const inserted = await env.DB.prepare(
    `INSERT INTO outreach_emails (company_id, email_to, brand_name, subject, body, status)
     VALUES (?1, ?2, ?3, ?4, ?5, 'draft')`,
  ).bind(en.company_id, en.contact_email, en.brand_name, subject, body).run();
  const emailId = inserted.meta?.last_row_id ?? 0;

  const res = await sendOutreachEmail(
    env,
    { id: emailId, email_to: en.contact_email, subject, body },
    {
      fromEmail: settings?.sender_email ?? null,
      fromName: settings?.sender_name ?? null,
      brandName: en.brand_name,
      gmailAccount: settings?.gmail_account ?? null,
      requestId: null,
    },
  );

  if (res.ok) {
    const now = new Date().toISOString();
    await noteTimeline(
      env,
      en.company_id,
      `序列邮件已发送（第 ${en.current_step + 1}/${steps.length} 步，D+${step.day_offset}）至 ${en.contact_email}：${subject}`,
    );
    const nextStep = en.current_step + 1;
    if (nextStep >= steps.length) {
      await env.DB.prepare(
        "UPDATE crm_sequence_enrollments SET status = 'completed', current_step = ?2, send_failures = 0, updated_at = ?3 WHERE id = ?1",
      ).bind(en.id, nextStep, now).run();
      report.completed++;
    } else {
      await env.DB.prepare(
        `UPDATE crm_sequence_enrollments
         SET current_step = ?2, next_due_at = ?3, send_failures = 0, updated_at = ?4 WHERE id = ?1`,
      ).bind(en.id, nextStep, dueFromEnrollment(en.enrolled_at, steps[nextStep].day_offset), now).run();
    }
    report.sent++;
    return;
  }

  // 发送失败：重试有限次；连续失败达到阈值 → 终止（更新.txt「退信后退出」
  // 的保守实现：具体退信原因由 gmail 同步分类回写，这里只管有限重试）。
  const failures = en.send_failures + 1;
  if (failures >= MAX_SEND_FAILURES) {
    await stopEnrollment(env, en, `连续 ${failures} 次发送失败：${res.error ?? "未知错误"}`.slice(0, 300), report, true);
    return;
  }
  await env.DB.prepare(
    "UPDATE crm_sequence_enrollments SET send_failures = ?2, next_due_at = ?3, updated_at = ?4 WHERE id = ?1",
  ).bind(en.id, failures, new Date(Date.now() + RETRY_DELAY_MS).toISOString(), new Date().toISOString()).run();
  safeLog("warn", `[sequences] 步骤发送失败（第 ${failures}/${MAX_SEND_FAILURES} 次，稍后重试）: ${res.error ?? ""}`);
}
