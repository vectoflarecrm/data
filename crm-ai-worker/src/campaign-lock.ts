/* Security V2 Stage 12 (spec §13) — campaign concurrency lock.
 *
 * Stages 10/11 already make the per-email and per-slot claims atomic, so no
 * matter how many workers run, an email is sent at most once and the quota
 * cannot be overshot. What remains is the campaign-level race: two workers
 * executing the SAME campaign interleave their loops — double-spending AI
 * tokens in the generate step and burning the daily quota on competing
 * batches. This lock makes campaign execution single-flight.
 *
 * The claim is one atomic upsert (spec §13.1's "UPDATE … WHERE + affected
 * rows / claim token, must be atomic"): the INSERT lands when no row exists,
 * and the ON CONFLICT branch steals only an EXPIRED lock — a live lock
 * yields zero changes and the caller is told the campaign is busy.
 *
 * Failure policy: a missing campaign_locks table (migration-pending window,
 * test fixtures predating this stage) proceeds UNLOCKED rather than breaking
 * sends — the lock is a campaign-level optimization layered on top of the
 * hard per-email guarantees, so fail-open here cannot cause a double send.
 * Any other DB error throws.
 */

export class CampaignLockedError extends Error {}

export interface CampaignLockEnv {
  DB: D1Database;
  /** Optional lock TTL override in ms (default 30 min, floor 60s). */
  CAMPAIGN_LOCK_TTL_MS?: string;
}

export interface CampaignLock {
  release(): Promise<void>;
}

/** How long a dead worker's lock holds the campaign. Generous on purpose:
 * a full send batch is up to 50 sends × (3s delay + 30s Gmail timeout) ≈
 * 28 minutes — a TTL shorter than the worst legal batch would let a second
 * worker start while the first is still running. */
const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000;

function lockTtlMs(env: CampaignLockEnv): number {
  const parsed = Number(env.CAMPAIGN_LOCK_TTL_MS);
  return Number.isSafeInteger(parsed) && parsed >= 60_000 ? parsed : DEFAULT_LOCK_TTL_MS;
}

function sqlUtc(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/**
 * Atomically claim execution of one campaign. Returns null when a live lock
 * is held (caller should surface "busy"), and a lock whose `release()` must
 * run in a finally — release is token-guarded, so an expired-lock thief can
 * never delete a newer holder's row.
 */
export async function acquireCampaignLock(env: CampaignLockEnv, campaignId: number): Promise<CampaignLock | null> {
  const token = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + lockTtlMs(env));
  try {
    const result = await env.DB.prepare(
      `INSERT INTO campaign_locks (campaign_id, lock_token, locked_at, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(campaign_id) DO UPDATE SET
         lock_token = excluded.lock_token,
         locked_at = excluded.locked_at,
         expires_at = excluded.expires_at
       WHERE campaign_locks.expires_at <= ?`,
    ).bind(campaignId, token, sqlUtc(now), sqlUtc(expiresAt), sqlUtc(now)).run();
    if ((result.meta.changes ?? 0) === 0) return null;
    return {
      release: async () => {
        await env.DB.prepare(
          "DELETE FROM campaign_locks WHERE campaign_id = ? AND lock_token = ?",
        ).bind(campaignId, token).run().catch(() => {});
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("no such table")) {
      // Migration pending: proceed unlocked (see header) — per-email claims
      // remain the hard guarantee; this lock only serializes campaigns.
      return { release: async () => {} };
    }
    throw e;
  }
}
