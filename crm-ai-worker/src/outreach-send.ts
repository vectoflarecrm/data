/* Security V2 Stage 10 (spec §11) — Gmail sending state machine.
 *
 * Before this stage the send path went straight from "row is draft" to the
 * Gmail API and only wrote the DB afterwards. Two workers (or two clicks)
 * could both see a draft and double-send it, and a crash between Gmail's
 * acceptance and the DB write left the row looking unsent — the worst
 * possible lie, because retrying would email the customer twice.
 *
 * The machine gives every send attempt a durable paper trail:
 *
 *   draft ──claim──▶ reserved ──▶ sending ──▶ Gmail API ──▶ sent
 *                      │             │
 *                      │             ├── definite rejection ──▶ failed
 *                      │             └── unknown outcome ─────▶ uncertain
 *                      └── pre-send abort (quota/config) ──▶ back to draft
 *
 * Transitions out of draft/failed are single conditional UPDATEs, so they
 * are atomic in D1: exactly one contender can flip a row, and everyone
 * else sees "not mine" and skips. Stale locks (worker died mid-send) are
 * reaped conservatively:
 *   - stale 'reserved' (the Gmail API call never started) → back to draft;
 *   - stale 'sending'  (the call may have reached Gmail)  → uncertain,
 *     which NEVER auto-resends — the operator verifies the mailbox and,
 *     if needed, resets the row to draft via the panel's edit endpoint.
 */

import {
  sendOutreachEmail,
  gmailSendTimeoutMs,
  GmailTransportError,
  type GmailEnv,
  type SendResult,
} from "./gmail";

export type OutreachSendStatus =
  | "draft"
  | "reserved"
  | "sending"
  | "sent"
  | "failed"
  | "uncertain"
  | "cancelled";

export type SendOutcome =
  | "sent"           // this call delivered the mail
  | "already_sent"   // a previous attempt sent it — idempotent success
  | "skipped_locked" // another in-flight attempt owns the row
  | "failed"         // definite rejection (or blocked from starting)
  | "uncertain"      // delivery unknown — past or present; never auto-retry
  | "duplicate";     // idempotency-key collision with another row

export interface StateSendResult extends SendResult {
  outcome: SendOutcome;
}

export interface SendMachineDeps {
  /** The raw Gmail transport. Injectable for tests; defaults to the real one. */
  transport?: typeof sendOutreachEmail;
  /** Injectable clock (tests pin lock age). Defaults to real time. */
  now?: () => Date;
}

/** How long a reserved/sending lock is trusted before it is considered dead
 * (worker crash or platform kill). Generous by design: a live send with the
 * 3s inter-send delay plus a 30s Gmail timeout stays far below it. */
const LOCK_TTL_MS = 10 * 60 * 1000;

function sqlUtc(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Quota errors must keep propagating so campaign batches can stop and leave
 * members 'generated' for tomorrow (runCampaignSend detects them by message). */
function isQuotaStopError(message: string): boolean {
  return message.includes("配额") || message.includes("quota") || message.includes("Quota");
}

/* ── Stale lock recovery ──────────────────────────────────────────────────
 * Called before every claim. 'reserved' rows died before the Gmail call
 * started (nothing was sent) → safe to retry. 'sending' rows died with the
 * request in flight (Gmail may have accepted it) → uncertain, never retried
 * automatically. A migration-pending database (no state columns) is a silent
 * no-op — nothing could have entered these states without the columns. */

export async function reapStaleSends(env: GmailEnv, now: Date = new Date()): Promise<void> {
  const cutoff = sqlUtc(new Date(now.getTime() - LOCK_TTL_MS));
  try {
    await env.DB.prepare(
      `UPDATE outreach_emails
       SET status = 'draft', locked_at = NULL, locked_by = NULL,
           last_error = '上次发送在调用 Gmail 前中断，已自动恢复可发送'
       WHERE status = 'reserved' AND locked_at IS NOT NULL AND locked_at < ?`,
    ).bind(cutoff).run();
    await env.DB.prepare(
      `UPDATE outreach_emails
       SET status = 'uncertain', locked_at = NULL, locked_by = NULL,
           last_error = '发送中途中断（Worker 崩溃或超时），送达状态未知；确认未送达后可在面板改回草稿重发'
       WHERE status = 'sending' AND locked_at IS NOT NULL AND locked_at < ?`,
    ).bind(cutoff).run();
  } catch (e) {
    const msg = errorMessage(e);
    if (msg.includes("no such column")) return; // migration pending — nothing to reap
    console.error("[outreach-send] reap failed", msg);
  }
}

/* ── Idempotency key (spec §11.3) ─────────────────────────────────────────
 * Stable hash over the logical message identity: campaign (or 'ad' for
 * panel-generated drafts), customer, and a content digest standing in for
 * the message version. Retrying the same row yields the same key; editing
 * the subject/body yields a new one (a changed message is a new version).
 * The unique partial index on idempotency_key turns "two rows for the same
 * logical message" into a claim-time refusal instead of a double send. */

async function sha256HexPrefix(input: string, length: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, length);
}

async function idempotencyKeyFor(
  env: GmailEnv,
  row: { id: number; customer_id: number | null; subject: string | null; body: string | null },
): Promise<string> {
  let campaignTag = "ad";
  try {
    const member = await env.DB.prepare(
      "SELECT campaign_id FROM outreach_campaign_members WHERE outreach_email_id = ? LIMIT 1",
    ).bind(row.id).first<{ campaign_id: number }>();
    if (member) campaignTag = `campaign:${member.campaign_id}`;
  } catch { /* table may not exist for panel-only deployments — 'ad' is right */}
  const contentHash = await sha256HexPrefix(`${row.subject ?? ""}\n${row.body ?? ""}`, 16);
  const customerTag = row.customer_id != null ? `customer:${row.customer_id}` : `email:${row.id}`;
  return `im-${await sha256HexPrefix(`${campaignTag}|${customerTag}|v:${contentHash}`, 24)}`;
}

/* ── Row classification for claims that did not win ─────────────────────── */

function classifyForeignStatus(status: string): StateSendResult {
  switch (status) {
    case "sent":
      return { ok: true, outcome: "already_sent" };
    case "reserved":
    case "sending":
      return { ok: false, outcome: "skipped_locked", error: "该邮件正在被另一个发送任务处理，已跳过" };
    case "uncertain":
      return {
        ok: false,
        outcome: "uncertain",
        error: "该邮件上次发送结果未知（可能已送达），已阻止自动重发；请核实收件箱后手动处理",
      };
    default: // 'cancelled' or anything unknown — refuse to touch it
      return { ok: false, outcome: "failed", error: `该邮件状态为 ${status}，不能发送` };
  }
}

/* ── The machine ────────────────────────────────────────────────────────── */

export async function sendWithStateMachine(
  env: GmailEnv,
  email: { id: number; email_to: string; subject: string | null; body: string | null },
  options?: Parameters<typeof sendOutreachEmail>[2],
  deps?: SendMachineDeps,
): Promise<StateSendResult> {
  const transport = deps?.transport ?? sendOutreachEmail;
  const now = deps?.now ?? (() => new Date());
  const workerId = `worker-${crypto.randomUUID().slice(0, 8)}`;

  await reapStaleSends(env, now());

  const row = await env.DB.prepare(
    "SELECT id, status, customer_id, subject, body FROM outreach_emails WHERE id = ?",
  ).bind(email.id).first<{ id: number; status: string; customer_id: number | null; subject: string | null; body: string | null }>();
  if (!row) {
    return { ok: false, outcome: "failed", error: "邮件记录不存在" };
  }
  if (row.status !== "draft" && row.status !== "failed") {
    return classifyForeignStatus(row.status);
  }

  const idempotencyKey = await idempotencyKeyFor(env, row);

  // Claim: atomic draft/failed → reserved. Exactly one contender wins.
  try {
    const claim = await env.DB.prepare(
      `UPDATE outreach_emails
       SET status = 'reserved', idempotency_key = ?, send_attempts = send_attempts + 1,
           locked_at = ?, locked_by = ?, last_error = NULL
       WHERE id = ? AND status IN ('draft', 'failed')`,
    ).bind(idempotencyKey, sqlUtc(now()), workerId, email.id).run();
    if ((claim.meta.changes ?? 0) === 0) {
      // Lost the race — re-read to tell the caller why in honest terms.
      const current = await env.DB.prepare("SELECT status FROM outreach_emails WHERE id = ?")
        .bind(email.id).first<{ status: string }>();
      return classifyForeignStatus(current?.status ?? row.status);
    }
  } catch (e) {
    const msg = errorMessage(e);
    if (msg.includes("UNIQUE") || msg.includes("unique") || msg.includes("constraint")) {
      // Another row already owns this logical message (same campaign +
      // customer + content). Refuse rather than double-send.
      return { ok: false, outcome: "duplicate", error: "检测到相同内容的历史发送记录（idempotency 冲突），已跳过" };
    }
    throw e; // e.g. missing state columns → fail closed, do NOT silently degrade
  }

  await env.DB.prepare(
    "UPDATE outreach_emails SET status = 'sending' WHERE id = ? AND status = 'reserved'",
  ).bind(email.id).run();

  try {
    const result = await transport(env, email, options);

    if (result.ok) {
      // Transport already flipped the row to 'sent'; this update adds the
      // Gmail message id and clears the lock. If it fails, the stale-lock
      // reaper later marks the row 'uncertain' — and the mail really did go
      // out, so uncertain is the honest status for a human to verify.
      await env.DB.prepare(
        `UPDATE outreach_emails
         SET status = 'sent', sent_at = CURRENT_TIMESTAMP, gmail_message_id = ?,
             locked_at = NULL, locked_by = NULL, last_error = NULL
         WHERE id = ?`,
      ).bind(result.gmail_message_id ?? null, email.id).run();
      return { ok: true, outcome: "sent", gmail_message_id: result.gmail_message_id };
    }

    // Definite rejection: Gmail answered "no" (HTTP error, invalid
    // recipient…). §11.1: sending → failed. Manual or batch retry may follow.
    await env.DB.prepare(
      `UPDATE outreach_emails
       SET status = 'failed', last_error = ?, locked_at = NULL, locked_by = NULL
       WHERE id = ?`,
    ).bind((result.error ?? "发送失败").slice(0, 300), email.id).run();
    return { ok: false, outcome: "failed", error: result.error };
  } catch (e) {
    const msg = errorMessage(e);

    if (isQuotaStopError(msg)) {
      // Pre-send abort: the Gmail API was never called. Back to draft so
      // campaign batches can pick the member up again tomorrow, and let the
      // error propagate for batch-level quota-stop detection.
      await env.DB.prepare(
        `UPDATE outreach_emails
         SET status = 'draft', locked_at = NULL, locked_by = NULL, last_error = ?
         WHERE id = ?`,
      ).bind(msg.slice(0, 300), email.id).run();
      throw e;
    }

    // Unknown delivery (network error, timeout, post-success DB hiccup inside
    // the transport…): §11.1's "网络未知" branch. Never auto-resend.
    const uncertain = e instanceof GmailTransportError
      ? msg
      : `发送过程出现未知错误（送达状态未知）：${msg}`;
    await env.DB.prepare(
      `UPDATE outreach_emails
       SET status = 'uncertain', last_error = ?, locked_at = NULL, locked_by = NULL
       WHERE id = ?`,
    ).bind(uncertain.slice(0, 300), email.id).run();
    return { ok: false, outcome: "uncertain", error: uncertain };
  }
}

/* Timeout policy mirrors the transport's own bound (kept in one place so the
 * machine's lock TTL and the transport timeout cannot drift apart). */
export { gmailSendTimeoutMs };
