/*
 * Post-V2 improvement (final report Remaining Risks #5) — audit retention.
 *
 * `audit_logs` grew without bound: every login, denial, credential change
 * and cron research claim adds a row and nothing ever removed them. The
 * trail is append-only by design (tamper-evident history), so the prune is
 * deliberately blunt: a time-window DELETE of rows older than the retention
 * horizon, and every non-empty prune writes its own audit row — the trail
 * records its own maintenance, so silent mass deletion is impossible.
 *
 * Policy — `AUDIT_RETENTION_DAYS` (optional Wrangler var):
 *   - unset / empty       → default 180 days
 *   - "0"                 → retention disabled (prune is a no-op)
 *   - "N" (positive int)  → N days
 *   - anything else       → default 180. A typo must fail SAFE, i.e. never
 *                           prune MORE aggressively than the default.
 *
 * Fail-open like the rest of the audit module: a missing `audit_logs` table
 * (pre-migration window, bare test fixtures) is a silent 0, and any other
 * D1 failure propagates to the caller, which logs and continues — a broken
 * prune must never take down the research tick that hosts it.
 */

import { safeLog } from "../security/safe-log";

export const DEFAULT_AUDIT_RETENTION_DAYS = 180;

export interface AuditRetentionEnv {
  AUDIT_RETENTION_DAYS?: string;
  [key: string]: unknown;
}

/** Same format writeAuditLog uses for created_at: UTC "YYYY-MM-DD HH:MM:SS". */
export function toSqlUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** Resolves the retention horizon in days, or null when pruning is
 * explicitly disabled with "0". */
export function resolveAuditRetentionDays(env: AuditRetentionEnv): number | null {
  const raw = env.AUDIT_RETENTION_DAYS;
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_AUDIT_RETENTION_DAYS;
  const days = Math.floor(Number(raw.trim()));
  if (!Number.isFinite(days) || days < 0) {
    safeLog("warn", `[audit-retention] AUDIT_RETENTION_DAYS=${raw} 无法解析，回退默认 ${DEFAULT_AUDIT_RETENTION_DAYS} 天`);
    return DEFAULT_AUDIT_RETENTION_DAYS;
  }
  if (days === 0) return null;
  return days;
}

/** Deletes audit rows strictly older than `days`, returns how many. A
 * missing table is a silent 0 (pre-migration stance of writeAuditLog);
 * other D1 errors propagate — the cron caller owns the fail-open policy. */
export async function pruneAuditLogs(env: { DB: D1Database }, days: number, now: Date = new Date()): Promise<number> {
  const cutoff = toSqlUtc(new Date(now.getTime() - days * 86_400_000));
  try {
    const result = await env.DB.prepare("DELETE FROM audit_logs WHERE created_at < ?").bind(cutoff).run();
    return result.meta.changes ?? 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("no such table")) return 0;
    throw e;
  }
}
