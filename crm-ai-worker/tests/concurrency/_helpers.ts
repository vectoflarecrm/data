import { FakeD1, makeDb } from "../security/_helpers";

/* Security V2 Stage 23 (spec §24) — shared fixtures for tests/concurrency/.
 *
 * Concurrency model: the suites launch N parallel async tasks against the
 * real SQL statements over the FakeD1 shim (node:sqlite + schema.sql, same
 * trick as the stage suites and tests/security/). node:sqlite is
 * synchronous, so tasks interleave at await boundaries rather than on
 * threads — which is exactly the property under test: every primitive
 * protected here is ONE atomic SQL statement (INSERT…SELECT guard, ON
 * CONFLICT … WHERE, UPDATE … RETURNING), so no interleaving can split its
 * check from its write. If a primitive ever regresses to read-then-write,
 * these tests fail under maximal interleaving.
 *
 * Spec §24: every file drives its core invariant at 10 / 50 / 100
 * concurrent tasks.
 */

export { makeDb };

/** Concurrency levels mandated by spec §24. */
export const CONCURRENCY_LEVELS = [10, 50, 100] as const;

/** Minimal env: only DB, which is all these primitives touch. */
export function d1env(db: any, explodeOn: string | null = null): any {
  return { DB: new FakeD1(db, explodeOn) };
}

/** Launch `n` tasks in parallel and settle them all — a storm never
 * aborts the test; assertions inspect the distribution of outcomes. */
export async function runTasks<T>(
  n: number,
  task: (i: number) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(Array.from({ length: n }, (_, i) => task(i)));
}

export function fulfilledValues<T>(results: PromiseSettledResult<T>[]): T[] {
  return results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

export function rejectionMessages(results: PromiseSettledResult<unknown>[]): string[] {
  return results.flatMap((r) =>
    r.status === "rejected" ? [r.reason instanceof Error ? r.reason.message : String(r.reason)] : [],
  );
}

/** Fresh db per storm: invariants must hold from ANY starting state, so
 * each concurrency level gets its own seeded database. */
export function stormDb(): any {
  return makeDb();
}

/** sqlUtc-compatible "now" for seeding rows the primitives will compare
 * against (schema timestamps are UTC text). */
export function sqlUtc(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

export const PAST = "2020-01-01 00:00:00";
