/* ⑦ Gmail 入站同步（对照 OpenCRM 的 Gmail Sync）：cron 空闲 tick 顺带读取
 * 各品牌发件邮箱的收件箱，把客户回复匹配到 CRM 时间线
 * （crm_activities type='email_received'，联系人邮箱 → 公司域名两级匹配）。
 *
 * 链路复用发信解析：outreach_settings.sender_email + gmail_account →
 * chooseGmailAccount（与 sendOutreachEmail 完全一致的凭据/邮箱解析），
 * 读取的就是客户实际回复的那个邮箱。
 *
 * 一切 fail-open：outreach_settings / gmail_accounts / crm 表缺失、scope 未
 * 授权（gmail.readonly）、Gmail API 失败 —— 都只记录到 crm_mail_sync 的
 * 退避计数，绝不影响 cron 主流程。
 *
 * 幂等：crm_mail_seen（mailbox, Gmail message id）去重 + crm_mail_sync 的
 * internalDate 游标，交叠 cron tick 不会产生重复时间线。
 */

import { safeLog } from "./security/safe-log";
import { chooseGmailAccount, getAccessToken, type ChosenAccount, type GmailEnv } from "./gmail";

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
/** 免费版 Worker 每次 invocation 的子请求预算有限：入站同步只占用空闲
 * tick 的一小块（每邮箱 1 次 list + 最多 SYNC_MAX_MESSAGES 次取信）。 */
const SYNC_MAX_MAILBOXES = 3;
const SYNC_MAX_MESSAGES = 5;
const LIST_PAGE_SIZE = 25;
/** 首次同步的回溯窗口（毫秒）：只拉最近几天的收件，避免老邮箱一次倾倒。 */
const INITIAL_BACKFILL_MS = 3 * 24 * 3600 * 1000;
/** 连续失败 ERROR_BACKOFF_THRESHOLD 次后，暂停该邮箱 ERROR_BACKOFF_MS。 */
const ERROR_BACKOFF_THRESHOLD = 5;
const ERROR_BACKOFF_MS = 6 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 12_000;

export interface GmailSyncReport {
  mailboxes: number;
  processed: number;
  matched: number;
  errors: number;
}

interface MailboxPlan {
  mailbox: string; // lowercased sender mailbox (sync state key)
  account: ChosenAccount;
}

interface GmailMessage {
  id: string;
  internalDate?: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
}

/** Parse an RFC 5322 From header into a lowercase address ('' when absent). */
export function parseFromAddress(from: string): string {
  const angled = /<([^<>@\s]+@[^<>\s]+)>/.exec(from);
  const candidate = angled ? angled[1] : from;
  const bare = /[^\s<>@]+@[^\s<>@]+/.exec(candidate);
  return bare ? bare[0].toLowerCase() : "";
}

export async function syncInboundGmail(env: GmailEnv): Promise<GmailSyncReport> {
  const report: GmailSyncReport = { mailboxes: 0, processed: 0, matched: 0, errors: 0 };

  let rows: Array<{ sender_email: string | null; gmail_account: string | null }> = [];
  try {
    const res = await env.DB.prepare(
      "SELECT sender_email, gmail_account FROM outreach_settings",
    ).all<{ sender_email: string | null; gmail_account: string | null }>();
    rows = res.results;
  } catch (error) {
    safeLog("warn", "[crm-gmail-sync] outreach_settings 不可用，跳过本 tick（fail-open）", error);
    return report;
  }

  // 每个品牌的发件邮箱去重后逐一解析凭据（与发信完全相同的链路）。
  const plans: MailboxPlan[] = [];
  const deduped = new Set<string>();
  for (const row of rows) {
    const sender = row.sender_email?.trim().toLowerCase();
    if (!sender || deduped.has(sender)) continue;
    deduped.add(sender);
    try {
      const account = await chooseGmailAccount(env, sender, row.gmail_account);
      if (account.credentialType === "service_account" && sender === account.clientEmail.trim().toLowerCase()) {
        continue; // 服务账号本身没有收件箱，无从读取
      }
      plans.push({ mailbox: sender, account });
    } catch (error) {
      safeLog("warn", `[crm-gmail-sync] 解析 ${sender} 的发信凭据失败，跳过该邮箱`, error);
    }
    if (plans.length >= SYNC_MAX_MAILBOXES) break;
  }

  for (const plan of plans) {
    try {
      const r = await syncMailbox(env, plan);
      report.mailboxes++;
      report.processed += r.processed;
      report.matched += r.matched;
    } catch (error) {
      report.errors++;
      await recordSyncError(env, plan.mailbox, error instanceof Error ? error.message : String(error));
    }
  }

  if (report.processed || report.errors) {
    safeLog(
      "log",
      `[crm-gmail-sync] mailboxes=${report.mailboxes} processed=${report.processed} matched=${report.matched} errors=${report.errors}`,
    );
  }
  return report;
}

async function syncMailbox(env: GmailEnv, plan: MailboxPlan): Promise<{ processed: number; matched: number }> {
  const { mailbox, account } = plan;

  const state = await loadSyncState(env, mailbox);
  if (state && state.error_count >= ERROR_BACKOFF_THRESHOLD && state.last_run_at) {
    const since = Date.parse(state.last_run_at);
    if (Number.isFinite(since) && Date.now() - since < ERROR_BACKOFF_MS) {
      return { processed: 0, matched: 0 }; // 退避窗口内：本 tick 不再请求 Gmail
    }
  }

  // 读取需要 gmail.readonly：服务账号在 Workspace 管理后台授权该 scope；
  // OAuth 令牌邮箱需要授权时勾选读取权限（未授权时 403 → 退避计数）。
  const token = await getAccessToken(
    env,
    account.clientEmail,
    account.privateKeyPem,
    account.senderEmail,
    account.credentialType,
    GMAIL_READONLY_SCOPE,
  );

  const afterSec = state && state.last_internal_date > 0
    ? Math.floor(state.last_internal_date / 1000)
    : Math.floor((Date.now() - INITIAL_BACKFILL_MS) / 1000);
  const userPath = encodeURIComponent(account.senderEmail);

  const listResp = await fetchGmail(
    `${GMAIL_API_BASE}/users/${userPath}/messages?maxResults=${LIST_PAGE_SIZE}&q=${encodeURIComponent(`in:inbox after:${afterSec}`)}`,
    token,
  );
  const listData = (await listResp.json()) as { messages?: Array<{ id: string }> };
  const ids = listData.messages ?? [];

  const seenIds = await loadSeenIds(env, mailbox);
  let processed = 0;
  let matched = 0;
  let cursor = state ? state.last_internal_date : 0;

  // Gmail list 由新到旧返回；从旧往新处理，游标只前进到已处理的最新的那条，
  // 剩余未处理的下一 tick 继续（每 tick 消化 SYNC_MAX_MESSAGES 条）。
  for (let i = ids.length - 1; i >= 0 && processed < SYNC_MAX_MESSAGES; i--) {
    const id = ids[i].id;
    if (seenIds.has(id)) continue;
    const msgResp = await fetchGmail(
      `${GMAIL_API_BASE}/users/${userPath}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      token,
    );
    const msg = (await msgResp.json()) as GmailMessage;
    const internalDate = Number(msg.internalDate);
    if (Number.isFinite(internalDate) && internalDate > cursor) cursor = internalDate;
    const didMatch = await recordMessage(env, mailbox, id, msg);
    if (didMatch) matched++;
    processed++;
  }

  await saveSyncState(env, mailbox, cursor);
  return { processed, matched };
}

/** 把一封来信匹配到 CRM（联系人邮箱 → 公司域名），写入时间线 + 去重行。
 * 匹配成功时两个写入放在一个 D1 batch 里（原子）；没匹配上只记去重行。
 * 返回是否匹配到了 CRM 记录。 */
async function recordMessage(env: GmailEnv, mailbox: string, messageId: string, msg: GmailMessage): Promise<boolean> {
  const headers = msg.payload?.headers ?? [];
  const fromValue = headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
  const subject = (headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const fromEmail = parseFromAddress(fromValue);
  const internalDate = Number(msg.internalDate);
  const receivedMs = Number.isFinite(internalDate) ? internalDate : Date.now();
  const receivedIso = new Date(receivedMs).toISOString();
  const dateLabel = receivedIso.slice(0, 10);
  const summary = `收到来信: ${subject || "(无主题)"}（来自 ${fromEmail || fromValue.slice(0, 120)}，${dateLabel}）`;

  if (fromEmail) {
    try {
      // 1. 联系人邮箱精确匹配（跨公司也可，来信人即决策人）。
      const contact = await env.DB.prepare(
        `SELECT id, full_name, company_id FROM crm_contacts
         WHERE lower(IFNULL(email, '')) = ?1 LIMIT 1`,
      )
        .bind(fromEmail)
        .first<{ id: string; full_name: string; company_id: string }>();
      if (contact) {
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO crm_activities (id, company_id, type, summary)
             VALUES (?1, ?2, 'email_received', ?3)`,
          ).bind(
            crypto.randomUUID(),
            contact.company_id,
            contact.full_name ? `${summary}，联系人 ${contact.full_name}` : summary,
          ),
          seenInsert(env, mailbox, messageId, receivedIso),
        ]);
        return true;
      }

      // 2. 公司域名匹配（未见过的邮箱，但域名是 CRM 里的公司）。
      const domain = fromEmail.split("@")[1] ?? "";
      if (domain) {
        const company = await env.DB.prepare(
          `SELECT id FROM crm_companies WHERE lower(IFNULL(domain, '')) = ?1 LIMIT 1`,
        )
          .bind(domain)
          .first<{ id: string }>();
        if (company) {
          await env.DB.batch([
            env.DB.prepare(
              `INSERT INTO crm_activities (id, company_id, type, summary)
               VALUES (?1, ?2, 'email_received', ?3)`,
            ).bind(crypto.randomUUID(), company.id, summary),
            seenInsert(env, mailbox, messageId, receivedIso),
          ]);
          return true;
        }
      }
    } catch (error) {
      // 时间线写入失败：不记去重行，下一 tick 重试（不会丢来信）。
      safeLog("warn", `[crm-gmail-sync] 收件时间线写入失败（下 tick 重试）`, error);
      return false;
    }
  }

  // 与 CRM 无关的来信：只记去重行，不写时间线。
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO crm_mail_seen (mailbox, message_id, received_at) VALUES (?1, ?2, ?3)`,
    )
      .bind(mailbox, messageId, receivedIso)
      .run();
  } catch (error) {
    safeLog("warn", "[crm-gmail-sync] 去重行写入失败（fail-open）", error);
  }
  return false;
}

function seenInsert(env: GmailEnv, mailbox: string, messageId: string, receivedIso: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO crm_mail_seen (mailbox, message_id, received_at) VALUES (?1, ?2, ?3)`,
  ).bind(mailbox, messageId, receivedIso);
}

async function fetchGmail(url: string, token: string): Promise<Response> {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const detail = (await resp.text()).replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`Gmail API HTTP ${resp.status}: ${detail}`);
  }
  return resp;
}

async function loadSyncState(env: GmailEnv, mailbox: string): Promise<{ last_internal_date: number; last_run_at: string | null; error_count: number } | null> {
  try {
    return await env.DB.prepare(
      "SELECT last_internal_date, last_run_at, error_count FROM crm_mail_sync WHERE mailbox = ?1",
    )
      .bind(mailbox)
      .first<{ last_internal_date: number; last_run_at: string | null; error_count: number }>();
  } catch {
    return null;
  }
}

async function loadSeenIds(env: GmailEnv, mailbox: string): Promise<Set<string>> {
  const seen = new Set<string>();
  try {
    const rows = await env.DB.prepare(
      "SELECT message_id FROM crm_mail_seen WHERE mailbox = ?1",
    )
      .bind(mailbox)
      .all<{ message_id: string }>();
    for (const r of rows.results) seen.add(r.message_id);
  } catch {
    // 表缺失时视为全部未见 —— 单条消息因 PK 冲突会被 OR IGNORE 兜住。
  }
  return seen;
}

async function saveSyncState(env: GmailEnv, mailbox: string, cursor: number): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO crm_mail_sync (mailbox, last_internal_date, last_run_at, error_count)
       VALUES (?1, ?2, ?3, 0)
       ON CONFLICT(mailbox) DO UPDATE SET
         last_internal_date = excluded.last_internal_date,
         last_run_at = excluded.last_run_at,
         last_error = NULL,
         error_count = 0`,
    )
      .bind(mailbox, Math.max(cursor, 0), new Date().toISOString())
      .run();
  } catch (error) {
    safeLog("warn", "[crm-gmail-sync] 同步游标写入失败（fail-open）", error);
  }
}

async function recordSyncError(env: GmailEnv, mailbox: string, message: string): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO crm_mail_sync (mailbox, last_internal_date, last_run_at, last_error, error_count)
       VALUES (?1, 0, ?2, ?3, 1)
       ON CONFLICT(mailbox) DO UPDATE SET
         last_run_at = excluded.last_run_at,
         last_error = excluded.last_error,
         error_count = crm_mail_sync.error_count + 1`,
    )
      .bind(mailbox, new Date().toISOString(), message.slice(0, 300))
      .run();
  } catch (error) {
    safeLog("warn", "[crm-gmail-sync] 错误记录写入失败（fail-open）", error);
  }
}
