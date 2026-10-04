import { describe, expect, it } from "vitest";
import { acquireCampaignLock } from "../../src/campaign-lock";
import { CONCURRENCY_LEVELS, PAST, d1env, runTasks, stormDb } from "./_helpers";

/* Security V2 Stage 23 (spec 搂24) 鈥?campaign lock under concurrency.
 *
 * acquireCampaignLock (src/campaign-lock.ts:59) is one INSERT 鈥?ON
 * CONFLICT(campaign_id) DO UPDATE 鈥?WHERE expires_at <= now: the WHERE on
 * the upsert makes a live lock unstealable and an expired lock stealable,
 * atomically. Release is token-guarded (DELETE 鈥?WHERE lock_token = ?),
 * so a thief that later releases can never delete a NEWER holder's row.
 * The lock only serializes campaign batches (fail-open if the table is
 * missing 鈥?per-email claims remain the hard guarantee); what must hold
 * under any interleaving is: exactly one runner per campaign at a time.
 */

function winners<T>(results: PromiseSettledResult<T>[]): T[] {
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

function nonNullLocks<T extends object | null>(locks: T[]): T[] {
  return locks.filter((l) => l !== null);
}

describe("campaign lock under concurrency", () => {
  it.each(CONCURRENCY_LEVELS)("N=%i workers race one campaign: exactly one holds the lock", async (n) => {
    const db = stormDb();
    const env = d1env(db);
    const locks = winners(await runTasks(n, () => acquireCampaignLock(env, 1)));
    expect(locks).toHaveLength(n); // no worker crashed on contention
    expect(nonNullLocks(locks)).toHaveLength(1);
    await nonNullLocks(locks)[0].release();
    // After release the lock is free again:
    const next = await acquireCampaignLock(env, 1);
    expect(next).not.toBeNull();
    await next!.release();
  });

  it.each(CONCURRENCY_LEVELS)("N=%i workers steal an EXPIRED lock: exactly one steals", async (n) => {
    const db = stormDb();
    db.prepare(
      "INSERT INTO campaign_locks (campaign_id, lock_token, locked_at, expires_at) VALUES (1, 'dead-token', ?, ?)",
    ).run(PAST, PAST); // long expired
    const env = d1env(db);
    const locks = winners(await runTasks(n, () => acquireCampaignLock(env, 1)));
    expect(nonNullLocks(locks)).toHaveLength(1); // the steal, once
    const row = db.prepare("SELECT lock_token FROM campaign_locks WHERE campaign_id = 1").get() as {
      lock_token: string;
    };
    expect(row.lock_token).not.toBe("dead-token"); // the thief replaced it
    await nonNullLocks(locks)[0].release();
  });

  it.each(CONCURRENCY_LEVELS)("N=%i workers across 5 campaigns: each campaign gets exactly one runner", async (n) => {
    const db = stormDb();
    const env = d1env(db);
    const locks = winners(await runTasks(n, (i) => acquireCampaignLock(env, (i % 5) + 1)));
    const held = nonNullLocks(locks);
    expect(held).toHaveLength(5); // one per campaign, no more
    for (const lock of held) await lock.release();
    const remaining = db.prepare("SELECT COUNT(*) AS c FROM campaign_locks").get() as { c: number };
    expect(remaining.c).toBe(0); // token-guarded release cleaned every row
  });

  it("release is token-guarded: a stale holder cannot delete a newer lock", async () => {
    const db = stormDb();
    const env = d1env(db);
    const first = await acquireCampaignLock(env, 1);
    expect(first).not.toBeNull();
    // Simulate a thief taking over an expired lock with a different token:
    db.prepare("UPDATE campaign_locks SET lock_token = 'thief-token' WHERE campaign_id = 1").run();
    await first!.release(); // stale token 鈥?must be a no-op
    const row = db.prepare("SELECT lock_token FROM campaign_locks WHERE campaign_id = 1").get() as {
      lock_token: string;
    };
    expect(row.lock_token).toBe("thief-token"); // the newer holder survived
  });

  it("a busy campaign surfaces null (caller reports busy, nothing breaks)", async () => {
    const db = stormDb();
    const env = d1env(db);
    const held = await acquireCampaignLock(env, 1);
    expect(held).not.toBeNull();
    const second = await acquireCampaignLock(env, 1);
    expect(second).toBeNull();
    await held!.release();
  });
});
