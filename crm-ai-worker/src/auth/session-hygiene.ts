/*
 * Post-V2 improvement — expired-session hygiene.
 *
 * `admin_sessions` only ever grows: rows are inserted at login and flipped
 * to `revoked_at` or silently time out, but nothing deleted them. Expired
 * and revoked rows are dead state — authenticate() rejects them — yet they
 * accumulate in D1 forever and keep the unique token-hash index bloated.
 *
 * The cron tick (every 5 min, src/index.ts scheduled) deletes rows whose
 * expiry is older than a fixed 7-day grace window. The grace exists so a
 * just-expired session stays inspectable in the /admin/sessions inventory
 * during an incident; 7 days later it is noise and goes.
 *
 * Deliberately NOT configurable: this is vacuum, not policy. Retention
 * policy knobs (AUDIT_RETENTION_DAYS) exist only where the operator has a
 * compliance reason to tune them.
 *
 * Same error contract as pruneAuditLogs: a missing table is a silent 0
 * (pre-migration window); other D1 errors propagate to the cron caller,
 * which owns the fail-open policy.
 */

export const SESSION_PRUNE_GRACE_DAYS = 7;

export interface SessionHygieneEnv {
  DB: D1Database;
}

/** UTC "YYYY-MM-DD HH:MM:SS", the format admin_sessions uses. */
function toSqlUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** Deletes sessions that expired more than the grace window ago; returns
 * how many. Revoked-but-unexpired rows are bounded by the 1-hour session
 * TTL and disappear when their original expiry passes the grace. */
export async function pruneExpiredSessions(env: SessionHygieneEnv, now: Date = new Date()): Promise<number> {
  const cutoff = toSqlUtc(new Date(now.getTime() - SESSION_PRUNE_GRACE_DAYS * 86_400_000));
  try {
    const result = await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").bind(cutoff).run();
    return result.meta.changes ?? 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("no such table")) return 0;
    throw e;
  }
}
