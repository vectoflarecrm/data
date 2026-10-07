/*
 * Post-V2 Stage 31 — business-data retention.
 *
 * Stage 25 bounded `audit_logs`; four more tables grow without bound with
 * ordinary activity and one accumulates stale throttle state:
 *
 *   - gmail_send_log      one row per send attempt; every reader is a
 *                         today-scoped quota count, old rows are pure log.
 *   - research_runs       one row per research run; written by
 *                         research-run.ts, read by NOTHING in src (pure
 *                         bookkeeping — the evidence rows carry their own
 *                         research_run_id for traceability).
 *   - evidence            append-only trail, displayed in the customer
 *                         modal (top 30 per company). Pruned SUPERSEDED-ONLY
 *                         (is_current = 0): the live chain of every field
 *                         survives forever, only expired history is cut.
 *   - research_sources    raw crawl segments per run (Phase 3). Same
 *                         superseded-only policy as evidence: the current
 *                         snapshot of every company survives, expired raw
 *                         history is cut. Runs themselves are pruned above;
 *                         source rows keep their own customer_id /
 *                         fetched_at so they stay meaningful without the
 *                         run row.
 *   - research_facts      typed fact substrate per run (Phase 3). Same
 *                         superseded-only policy: the current facts of
 *                         every company survive for Phase 4 consumers;
 *                         expired history is cut.
 *   - research_signals    buying-signal layer per run (Phase 4 Stage 40).
 *                         Same superseded-only policy: the current signal
 *                         set survives for the panel (and later campaign
 *                         targeting); expired history is cut.
 *   - customer_imports    the raw import layer (docx 建议三). Written on
 *                         every CSV import, read by nothing today; rows carry
 *                         the full raw_json so this is the heaviest table
 *                         per row. Deleting old rows forfeits the ability to
 *                         re-process imports older than the horizon — the
 *                         normalized customers themselves always survive.
 *   - admin_login_attempts per-ident throttle buckets; pure bookkeeping
 *                         (lock window is 900 s), swept at a FIXED 30 days,
 *                         not governed by DATA_RETENTION_DAYS.
 *
 * Deliberately NOT pruned (documented exclusions):
 *   - contacts / outreach_emails / outreach_campaign_members — live business
 *     data, not time-series; bounded by campaign/customer activity.
 *   - api_key_usage — one tiny row per key per day and the panel's "累计"
 *     stat sums the whole table; pruning would silently redefine the
 *     displayed semantics for negligible space.
 *   - rate_limit_windows (rolls forward in place), campaign_locks (rows are
 *     reused/stolen per campaign), gmail_send_reservations (release is a
 *     DELETE plus an expiry sweeper) — none of them grow.
 *
 * Policy — `DATA_RETENTION_DAYS` (optional Wrangler var), same shape as
 * AUDIT_RETENTION_DAYS:
 *   - unset / empty       → default 180 days
 *   - "0"                 → retention disabled (business-data prunes are
 *                           no-ops; the fixed login-attempt sweep still runs)
 *   - "N" (positive int)  → N days
 *   - anything else       → default 180. A typo must fail SAFE, i.e. never
 *                           prune MORE aggressively than the default.
 *
 * Fail-open exactly like audit retention: a missing table (pre-migration
 * window, bare test fixtures) is a silent 0 and any other D1 failure
 * propagates to the cron caller, which logs and continues — a broken prune
 * must never take down the research tick that hosts it.
 *
 * Every non-empty prune is recorded by the cron caller as a DATA_PRUNE audit
 * row with per-table counts, so silent mass deletion is impossible.
 */

import { safeLog } from "./security/safe-log";
import { toSqlUtc } from "./audit/audit-retention";

export const DEFAULT_DATA_RETENTION_DAYS = 180;

/** Fixed sweep horizon for admin_login_attempts (throttle bookkeeping). */
export const LOGIN_ATTEMPTS_RETENTION_DAYS = 30;

export interface DataRetentionEnv {
  DATA_RETENTION_DAYS?: string;
  [key: string]: unknown;
}

/** Resolves the retention horizon in days, or null when pruning is
 * explicitly disabled with "0". */
export function resolveDataRetentionDays(env: DataRetentionEnv): number | null {
  const raw = env.DATA_RETENTION_DAYS;
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_DATA_RETENTION_DAYS;
  const days = Math.floor(Number(raw.trim()));
  if (!Number.isFinite(days) || days < 0) {
    safeLog("warn", `[data-retention] DATA_RETENTION_DAYS=${raw} 无法解析，回退默认 ${DEFAULT_DATA_RETENTION_DAYS} 天`);
    return DEFAULT_DATA_RETENTION_DAYS;
  }
  if (days === 0) return null;
  return days;
}

/** Shared DELETE-with-missing-table-tolerance. Returns deleted row count. */
async function pruneBefore(
  env: { DB: D1Database },
  sql: string,
  cutoff: string,
): Promise<number> {
  try {
    const result = await env.DB.prepare(sql).bind(cutoff).run();
    return result.meta.changes ?? 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("no such table")) return 0;
    throw e;
  }
}

/** Pure log: every reader of this table is today-scoped. */
export async function pruneGmailSendLog(
  env: { DB: D1Database },
  days: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = toSqlUtc(new Date(now.getTime() - days * 86_400_000));
  return pruneBefore(env, "DELETE FROM gmail_send_log WHERE sent_at < ?", cutoff);
}

/** Bookkeeping: nothing in src reads research_runs; a run still marked
 * 'running' after the horizon is a crashed run, safe to drop. */
export async function pruneResearchRuns(
  env: { DB: D1Database },
  days: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = toSqlUtc(new Date(now.getTime() - days * 86_400_000));
  return pruneBefore(env, "DELETE FROM research_runs WHERE started_at < ?", cutoff);
}

/** Superseded evidence only: is_current = 1 rows are never touched, so the
 * live chain of every field survives regardless of age. Legacy superseded
 * rows without valid_until fall back to collected_at. */
export async function pruneSupersededEvidence(
  env: { DB: D1Database },
  days: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = toSqlUtc(new Date(now.getTime() - days * 86_400_000));
  return pruneBefore(
    env,
    "DELETE FROM evidence WHERE is_current = 0 AND COALESCE(valid_until, collected_at) < ?",
    cutoff,
  );
}

/** Superseded research sources only (is_current = 0): the current raw
 * snapshot of every company survives regardless of age — identical policy
 * to the superseded half of evidence. Fallback timestamp mirrors evidence
 * (valid_until, else the row's own fetched_at). */
export async function pruneSupersededResearchSources(
  env: { DB: D1Database },
  days: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = toSqlUtc(new Date(now.getTime() - days * 86_400_000));
  return pruneBefore(
    env,
    "DELETE FROM research_sources WHERE is_current = 0 AND COALESCE(valid_until, fetched_at) < ?",
    cutoff,
  );
}

/** Superseded research facts only (is_current = 0): the current typed
 * facts of every company survive regardless of age (Phase 4 consumers
 * read them); expired history is cut with the same policy and fallback
 * timestamp as evidence/sources. */
export async function pruneSupersededResearchFacts(
  env: { DB: D1Database },
  days: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = toSqlUtc(new Date(now.getTime() - days * 86_400_000));
  return pruneBefore(
    env,
    "DELETE FROM research_facts WHERE is_current = 0 AND COALESCE(valid_until, fetched_at) < ?",
    cutoff,
  );
}

/** Superseded buying signals only (is_current = 0): the current signal set
 * of every company survives for the panel's signal section (and later
 * campaign targeting); expired history is cut with the same policy and
 * fallback timestamp as evidence/sources/facts (Phase 4 Stage 40). */
export async function pruneSupersededResearchSignals(
  env: { DB: D1Database },
  days: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = toSqlUtc(new Date(now.getTime() - days * 86_400_000));
  return pruneBefore(
    env,
    "DELETE FROM research_signals WHERE is_current = 0 AND COALESCE(valid_until, created_at) < ?",
    cutoff,
  );
}

/** Raw import layer: the heaviest per-row table and read by nothing today;
 * normalized customers always survive independently. */
export async function pruneCustomerImports(
  env: { DB: D1Database },
  days: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = toSqlUtc(new Date(now.getTime() - days * 86_400_000));
  return pruneBefore(env, "DELETE FROM customer_imports WHERE created_at < ?", cutoff);
}

/** Fixed 30-day sweep of throttle buckets (lock window is 900 s). Not
 * governed by DATA_RETENTION_DAYS — "0" only opts out of business-data
 * pruning, never out of hygiene. */
export async function pruneLoginAttempts(
  env: { DB: D1Database },
  now: Date = new Date(),
): Promise<number> {
  const cutoff = toSqlUtc(new Date(now.getTime() - LOGIN_ATTEMPTS_RETENTION_DAYS * 86_400_000));
  return pruneBefore(env, "DELETE FROM admin_login_attempts WHERE updated_at < ?", cutoff);
}
