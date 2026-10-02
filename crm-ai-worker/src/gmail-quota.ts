/* Security V2 Stage 11 (spec §12) — Gmail quota atomic reservation.
 *
 * The old flow was check → send → increment: the "check" read a count that
 * 99 concurrent workers could all read as "1 slot left" before any of them
 * incremented. Batches racing the daily cap could overshoot it, which for a
 * Gmail sending pool means account suspension.
 *
 * The new flow is reserve → send → commit:
 *   reserve  one atomic INSERT…SELECT that only lands when
 *            sent_today + reserved_today < daily_limit (D1 runs single
 *            statements atomically, so there is no read-then-write gap)
 *   send     the Gmail API call, holding one reserved slot
 *   commit   success → the slot is released and the send is instead counted
 *            by gmail_send_log's 'sent' row (the unchanged source of truth);
 *            definite failure → the slot is released immediately;
 *            unknown outcome → the slot stays reserved until the TTL reaper
 *            frees it (conservative: an uncertain send may have consumed
 *            Gmail-side quota even though nothing was logged).
 *
 * Reservations are per sender account (spec §12.2), keyed uniquely by the
 * outreach email, so the same email can never hold two slots. Rows exist
 * only while a slot is HELD: commit/release/expiry DELETE the row rather
 * than flipping a status, because a lingering row would block the UNIQUE
 * key when the email is legitimately retried. The `status` column from the
 * spec's DDL is kept ('reserved') for schema parity.
 */

import type { GmailEnv } from "./gmail";

/** How long a reservation may hold a slot before the reaper frees it.
 * Generous: a live send (token + 30s Gmail timeout + logging) finishes far
 * below this; only a dead worker holds a slot to the TTL. */
export const RESERVATION_TTL_MS = 15 * 60 * 1000;

function sqlUtc(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

export interface QuotaReservation {
  /** gmail_accounts.client_email (or the env-secret account's email). */
  accountEmail: string;
  /** This account's daily limit (pool override or env default). */
  dailyLimit: number;
  /** The outreach email this slot is for — also the unique reservation key. */
  outreachEmailId: number;
}

/** Active (slot-holding) reservations for one account, or all accounts. */
export async function activeReservations(env: GmailEnv, accountEmail?: string): Promise<number> {
  const row = accountEmail
    ? await env.DB.prepare(
        "SELECT COUNT(*) AS cnt FROM gmail_send_reservations WHERE gmail_account_id = ? AND status = 'reserved'",
      ).bind(accountEmail).first<{ cnt: number }>()
    : await env.DB.prepare(
        "SELECT COUNT(*) AS cnt FROM gmail_send_reservations WHERE status = 'reserved'",
      ).first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

/** §12.4: reservations whose holder died hold their slot only until the TTL.
 * Deleting (not expiring) frees both the slot and the unique key for a
 * legitimate later retry of the same email. Called on every reserve. */
export async function reapExpiredReservations(env: GmailEnv, now: Date = new Date()): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM gmail_send_reservations WHERE status = 'reserved' AND expires_at < ?",
  ).bind(sqlUtc(now)).run();
}

/**
 * Atomically reserve one send slot (spec §12.2). Throws a quota error when
 * the account is out — the message keeps the 配额 wording batch code uses to
 * distinguish quota stops from per-customer failures. A UNIQUE violation
 * (same email already holds a slot) is treated the same way: nothing was
 * sent, so the caller must treat it as a retriable stop, not a failure of
 * this customer.
 */
export async function reserveQuota(env: GmailEnv, req: QuotaReservation, now: Date = new Date()): Promise<void> {
  await reapExpiredReservations(env, now);
  const id = crypto.randomUUID();
  const key = `email:${req.outreachEmailId}`;
  const reservedAt = sqlUtc(now);
  const expiresAt = sqlUtc(new Date(now.getTime() + RESERVATION_TTL_MS));
  try {
    const result = await env.DB.prepare(
      `INSERT INTO gmail_send_reservations
         (id, gmail_account_id, idempotency_key, reserved_at, expires_at, status, outreach_email_id)
       SELECT ?, ?, ?, ?, ?, 'reserved', ?
       WHERE (
         (SELECT COUNT(*) FROM gmail_send_log
          WHERE date(sent_at) = date('now') AND status = 'sent' AND sender_client_email = ?)
         + (SELECT COUNT(*) FROM gmail_send_reservations
            WHERE gmail_account_id = ? AND status = 'reserved')
       ) < ?`,
    ).bind(
      id, req.accountEmail, key, reservedAt, expiresAt, req.outreachEmailId,
      req.accountEmail, req.accountEmail, req.dailyLimit,
    ).run();
    if ((result.meta.changes ?? 0) === 0) {
      throw new Error(
        `今日 Gmail 发送配额已用完（账号 ${req.accountEmail} 上限 ${req.dailyLimit} 封/天），请明天再试、调高账号 daily_limit 或在面板添加更多发信账号`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE") || msg.includes("unique") || msg.includes("constraint")) {
      throw new Error("配额预留冲突：该邮件已有进行中的预留，请勿并发重发");
    }
    throw e; // missing table etc. → fail closed: a quota control must not degrade
  }
}

/** Release a slot without a send being logged: definite Gmail rejection, or
 * the send succeeded and gmail_send_log's 'sent' row is now the quota truth. */
export async function releaseReservation(env: GmailEnv, outreachEmailId: number): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM gmail_send_reservations WHERE idempotency_key = ?",
  ).bind(`email:${outreachEmailId}`).run();
}
