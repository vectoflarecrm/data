import { describe, expect, it } from "vitest";
import { claimCustomers } from "../../src/index";
import { CONCURRENCY_LEVELS, PAST, d1env, runTasks, sqlUtc, stormDb } from "./_helpers";

/* Security V2 Stage 23 (spec 搂24) 鈥?research claim under concurrency.
 *
 * Overlapping Cron invocations used to SELECT-then-UPDATE and could take
 * the same pending customers twice (double AI spend). claimCustomers
 * (src/index.ts) now claims with ONE atomic UPDATE 鈥?WHERE id IN (SELECT
 * 鈥?LIMIT ?) RETURNING, after re-queueing stale processing rows.
 *
 * BATCH_SIZE = 3 and STALE_PROCESSING_MINUTES = 30 in src/index.ts: the
 * tests assert against those constants on purpose 鈥?if either changes,
 * these tests fail loudly instead of silently trusting new numbers.
 */

const BATCH_SIZE = 3;

function seedCustomers(
  db: any,
  n: number,
  status: string = "pending",
  updated: string | null = null,
  startId: number = 1,
): void {
  // updated_at is NOT NULL: fresh rows get "now", stale recovery fixtures
  // pass an old timestamp explicitly.
  const stamp = updated ?? sqlUtc(new Date());
  const stmt = db.prepare(
    "INSERT INTO customers (id, company_id, domain, status, company_name, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < n; i++) {
    stmt.run(startId + i, `co-${status}-${startId + i}`, `d${startId + i}.test.example`, status, `Customer ${startId + i}`, stamp);
  }
}

function claimOnce(env: any): Promise<Array<{ id: number }>> {
  return claimCustomers(env) as Promise<Array<{ id: number }>>;
}

describe("research claim under concurrency", () => {
  it.each(CONCURRENCY_LEVELS)("N=%i parallel claims over 3N pending: no customer claimed twice", async (n) => {
    const db = stormDb();
    seedCustomers(db, n * BATCH_SIZE);
    const env = d1env(db);
    const batches = (await runTasks(n, () => claimOnce(env))).flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    expect(batches).toHaveLength(n); // every claim succeeded
    for (const batch of batches) expect(batch).toHaveLength(BATCH_SIZE); // full batches
    const ids = batches.flatMap((b) => b.map((row) => row.id));
    expect(new Set(ids).size).toBe(n * BATCH_SIZE); // THE invariant: disjoint
    const left = db.prepare("SELECT COUNT(*) AS c FROM customers WHERE status = 'pending'").get() as { c: number };
    expect(left.c).toBe(0); // queue fully drained
  });

  it.each(CONCURRENCY_LEVELS)("N=%i parallel claims over a shrinking queue: totals stay exact", async (n) => {
    const db = stormDb();
    seedCustomers(db, n); // fewer customers than 3N 鈥?later claims get short batches
    const env = d1env(db);
    const batches = (await runTasks(n, () => claimOnce(env))).flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    const ids = batches.flatMap((b) => b.map((row) => row.id));
    expect(ids).toHaveLength(n); // every customer taken
    expect(new Set(ids).size).toBe(n); // none taken twice
  });

  it.each(CONCURRENCY_LEVELS)("N=%i parallel claims recover stale processing jobs exactly once", async (n) => {
    const db = stormDb();
    const staleCount = Math.max(2, Math.floor(n / 10));
    seedCustomers(db, n * BATCH_SIZE); // fresh pending work
    // Stale rows continue the id space after the pending batch; ids are
    // hardcoded below to match.
    seedCustomers(db, staleCount, "processing", PAST, n * BATCH_SIZE + 1);
    const env = d1env(db);
    const batches = (await runTasks(n, () => claimOnce(env))).flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    const ids = batches.flatMap((b) => b.map((row) => row.id));
    expect(new Set(ids).size).toBe(ids.length); // nobody double-claimed
    // The stale rows were re-queued by the recovery UPDATE and claimed like
    // any pending row 鈥?at most once across the whole storm:
    const staleIds = Array.from({ length: staleCount }, (_, i) => n * BATCH_SIZE + i + 1);
    const claimedStale = staleIds.filter((id) => ids.includes(id));
    expect(new Set(claimedStale).size).toBe(claimedStale.length);
    const notProcessing = db.prepare(
      "SELECT COUNT(*) AS c FROM customers WHERE status = 'processing' AND updated_at < datetime('now', '-30 minutes')",
    ).get() as { c: number };
    expect(notProcessing.c).toBe(0); // no stale row left behind
  });

  it("parallel claims on an empty queue return empty batches, never errors", async () => {
    const db = stormDb();
    const env = d1env(db);
    const batches = (await runTasks(10, () => claimOnce(env))).flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    expect(batches).toHaveLength(10);
    for (const batch of batches) expect(batch).toHaveLength(0);
  });
});
