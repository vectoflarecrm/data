/* 触达质量闭环（功能审查建议 P0-2 + P1-6）：
 *
 * 1. 回复分类（classifyInboundEmail）：Gmail 入站来信按证据分类为
 *    退信 / 退订 / 自动回复 / 疑似意向 / 普通回复 —— 供 crm-gmail-sync
 *    写时间线与触发抑制动作。
 * 2. 发送前统一策略检查（isContactBlocked）：所有出站营销邮件（手动批量、
 *    群发、自动推进共用 sendOutreachEmail 单一出口）在实际发送前重新检查
 *    退订 / 禁止联系状态 —— 不能只在创建名单时检查一次。
 *    拦截发生在配额预留之前，不浪费 Gmail 配额与上游 token。
 * 3. 抑制动作（markContactUnsubscribed / markEmailInvalid）：退订 →
 *    unsubscribed_at + do_not_contact；退信 → email_status='invalid'。
 *
 * 全部 fail-open：CRM 表缺失/查询失败时放行（老库、最小化测试 schema），
 * 抑制是增强不是依赖；但抑制状态一旦写入就 fail-closed 拦截。
 */

import { safeLog } from "./security/safe-log";

export interface ContactabilityEnv {
  DB: D1Database;
}

export type InboundKind = "bounce" | "unsubscribe" | "auto_reply" | "interest" | "reply";

export interface InboundClass {
  kind: InboundKind;
  /** 人类可读分类标签（写入时间线 summary 前缀）。 */
  label: string;
}

const AUTO_REPLY_RE = /(自动回复|不在办公室|out\s*of\s*office|vacation\s*(?:reply|notice)|away\s*from)/i;
const AUTO_SUBJECT_RE = /^(auto(?:matic)?[-:\s]?reply|自动回复)/i;
const UNSUBSCRIBE_RE = /(退订|取消订阅|不要再[发寄]|请勿再次?发送|不再接收|移除我|remove\s+me|stop\s+(?:emailing|messaging|sending)|don'?t\s+(?:email|contact|send)|unsubscribe|不希望再收到)/i;
const INTEREST_RE = /(报价|询价|价格表?|产品目录|目录|样品|订单|合作|有意|感兴趣|quotation|quote|price\s*list|interested|catalog(ue)?|sample|proforma|\bPI\b|合作意向|采购)/i;
const QUOTE_RE = /(报价|询价|价格表?|quotation|quote|price\s*list|proforma|\bPI\b)/i;

/** P1-6 细分：兴趣回复里是否明确要求报价/价格/PI —— 任务文案用「报价跟进」。 */
export function isQuoteRequest(subject: string, snippet: string): boolean {
  return QUOTE_RE.test(`${subject}\n${snippet}`);
}

/** 按邮件证据分类。头部证据（Auto-Submitted/Precedence）最可靠，先于
 * 正文关键词判定；正文里显式退订词优先于弱关键词的自动回复猜测。 */
export function classifyInboundEmail(options: {
  fromEmail: string;
  subject: string;
  autoSubmitted?: string;
  precedence?: string;
  snippet?: string;
}): InboundClass {
  const { fromEmail, subject, autoSubmitted = "", precedence = "", snippet = "" } = options;

  if (/^(mailer-daemon|postmaster)@/i.test(fromEmail) || /mailer-daemon|postmaster@/i.test(fromEmail)) {
    return { kind: "bounce", label: "退信" };
  }
  const haystack = `${subject}\n${snippet}`;
  // RFC 3834：Auto-Submitted 除 "no" 外均为自动回复；Precedence auto/bulk/junk 同理。
  if ((autoSubmitted.trim() && autoSubmitted.trim().toLowerCase() !== "no") ||
    /^(auto|bulk|junk)$/i.test(precedence.trim()) ||
    AUTO_SUBJECT_RE.test(subject)) {
    return { kind: "auto_reply", label: "自动回复" };
  }
  if (UNSUBSCRIBE_RE.test(haystack)) {
    return { kind: "unsubscribe", label: "退订请求" };
  }
  if (AUTO_REPLY_RE.test(haystack)) {
    return { kind: "auto_reply", label: "自动回复" };
  }
  if (INTEREST_RE.test(haystack)) {
    return { kind: "interest", label: "疑似意向" };
  }
  return { kind: "reply", label: "" };
}

/** 从退信通知的正文/主题里提取被退回的原始收件地址（'' = 提取不到）。 */
export function extractBouncedAddress(snippet: string): string {
  const matches = snippet.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? [];
  for (const m of matches) {
    if (/^(mailer-daemon|postmaster)@/i.test(m)) continue;
    return m.toLowerCase();
  }
  return "";
}

export interface BlockedResult {
  blocked: boolean;
  reason: string;
}

/** 发送前统一策略检查：联系人退订/禁联 → 公司禁联（邮箱 → 域名两级）。
 * fail-open：表缺失/查询失败放行 —— 但状态一旦能读到就如实拦截。 */
export async function isContactBlocked(env: ContactabilityEnv, email: string): Promise<BlockedResult> {
  const addr = email.trim().toLowerCase();
  if (!addr) return { blocked: false, reason: "" };
  try {
    const contact = await env.DB.prepare(
      `SELECT ct.unsubscribed_at, ct.do_not_contact, ct.email_status, cc.do_not_contact AS company_dnc
       FROM crm_contacts ct JOIN crm_companies cc ON cc.id = ct.company_id
       WHERE lower(IFNULL(ct.email, '')) = ?1
       ORDER BY CASE WHEN ct.do_not_contact = 1 OR ct.unsubscribed_at IS NOT NULL THEN 0 ELSE 1 END
       LIMIT 1`,
    )
      .bind(addr)
      .first<{ unsubscribed_at: string | null; do_not_contact: number; email_status: string | null; company_dnc: number }>();
    if (contact) {
      if (contact.do_not_contact) return { blocked: true, reason: "联系人已标记禁止联系" };
      if (contact.unsubscribed_at) {
        const day = String(contact.unsubscribed_at).slice(0, 10);
        return { blocked: true, reason: `联系人已于 ${day} 退订` };
      }
      if (contact.company_dnc) return { blocked: true, reason: "公司已标记禁止联系" };
      if (contact.email_status === "invalid") return { blocked: true, reason: "邮箱已退信（invalid）" };
      return { blocked: false, reason: "" };
    }
    const domain = addr.split("@")[1] ?? "";
    if (domain) {
      const company = await env.DB.prepare(
        `SELECT id FROM crm_companies WHERE lower(IFNULL(domain, '')) = ?1 AND do_not_contact = 1 LIMIT 1`,
      )
        .bind(domain)
        .first<{ id: string }>();
      if (company) return { blocked: true, reason: "公司已标记禁止联系（域名匹配）" };
    }
  } catch (error) {
    safeLog("warn", "[contactability] 抑制状态检查失败（fail-open 放行）", error);
  }
  return { blocked: false, reason: "" };
}

/** 退订动作：该邮箱的所有联系人生效（保留 unsubscribed_at 首次退订时间）。
 * 返回是否有行被更新。 */
export async function markContactUnsubscribed(env: ContactabilityEnv, fromEmail: string): Promise<boolean> {
  const addr = fromEmail.trim().toLowerCase();
  if (!addr) return false;
  try {
    const r = await env.DB.prepare(
      `UPDATE crm_contacts
       SET unsubscribed_at = COALESCE(unsubscribed_at, ?1), do_not_contact = 1
       WHERE lower(IFNULL(email, '')) = ?2`,
    )
      .bind(new Date().toISOString(), addr)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  } catch (error) {
    safeLog("warn", "[contactability] 退订标记失败（fail-open）", error);
    return false;
  }
}

/** 退信动作：邮箱标记 invalid（幂等，已是 invalid 不重复盖时间戳）。 */
export async function markEmailInvalid(env: ContactabilityEnv, email: string): Promise<boolean> {
  const addr = email.trim().toLowerCase();
  if (!addr) return false;
  try {
    const r = await env.DB.prepare(
      `UPDATE crm_contacts
       SET email_status = 'invalid', email_verified_at = ?1
       WHERE lower(IFNULL(email, '')) = ?2 AND IFNULL(email_status, 'unknown') != 'invalid'`,
    )
      .bind(new Date().toISOString(), addr)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  } catch (error) {
    safeLog("warn", "[contactability] 退信标记失败（fail-open）", error);
    return false;
  }
}
