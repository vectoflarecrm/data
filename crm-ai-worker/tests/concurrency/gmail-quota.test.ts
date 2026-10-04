import { describe, expect, it } from "vitest";
import { releaseReservation, reserveQuota } from "../../src/gmail-quota";
import {
  CONCURRENCY_LEVELS,
  PAST,
  d1env,
  fulfilledValues,
  rejectionMessages,
  runTasks,
  sqlUtc,
  stormDb,
} from "./_helpers";

/* Security V2 Stage 23 (spec §24) — gmail-quota concurrency.
 *
 * reserveQuota is one INSERT…SELECT guarded by two count subqueries
 * (src/gmail-quota.ts:88): D1 executes single statements atomically, so
 * N workers racing the last slots can never overshoot the daily cap —
 * overshooting a Gmail pool cap means account suspension. The UNIQUE
 * idempotency key (email:<id>) additionally means one outreach email can
 * never hold two slots.
 */

const ACCOUNT = "pool@test.example";

function seedSentToday(db: any, n: number, account: string = ACCOUNT): void {
  const stmt = db.prepare(
    "INSERT INTO gmail_send_log (outreach_email_id, recipient, status, sender_client_email) VALUES (?, ?, 'sent', ?)",
  );
  for (let i = 0; i < n; i++) stmt.run(9000 + i, "rcpt@test.example", account);
}

describe("gmail-quota under concurrency", () => {
  it.each(CONCURRENCY_LEVELS)("N=%i concurrent reserves: exactly the daily limit win", async (n) => {
    const db = stormDb();
    const env = d1env(db);
    const limit = Math.ceil(n / 2); // 5 / 25 / 50 — half the storm fits
    const results = await runTasks(n, (i) =>
      reserveQuota(env, { accountEmail: ACCOUNT, dailyLimit: limit, outreachEmailId: i + 1 }),
    );
    const wins = fulfilledValues(results);
    const rejections = rejectionMessages(results);
    expect(wins).toHaveLength(limit);
    expect(rejections).toHaveLength(n - limit);
    for (const msg of rejections) expect(msg).toContain("配额");
    const held = db.prepare(
      "SELECT COUNT(*) AS c FROM gmail_send_reservations WHERE status = 'reserved'",
    ).get() as { c: number };
    expect(held.c).toBe(limit);
  });

  it.each(CONCURRENCY_LEVELS)("N=%i concurrent reserves of the SAME email: exactly one slot", async (n) => {
    const db = stormDb();
    const env = d1env(db);
    const results = await runTasks(n, () =>
      reserveQuota(env, { accountEmail: ACCOUNT, dailyLimit: n, outreachEmailId: 42 }),
    );
    expect(fulfilledValues(results)).toHaveLength(1);
    const rejections = rejectionMessages(results);
    expect(rejections).toHaveLength(n - 1);
    for (const msg of rejections) expect(msg).toContain("配额预留冲突");
  });

  it.each(CONCURRENCY_LEVELS)("N=%i concurrent reserves with S sends already logged: limit-S win", async (n) => {
    const db = stormDb();
    // sender_client_email is the column a fresh schema.sql install lacked
    // before the Stage 23 drift fix — seeding it here also proves the
    // repaired schema carries it (reserveQuota fails closed without it).
    const alreadySent = Math.floor(n / 4);
    seedSentToday(db, alreadySent);
    const env = d1env(db);
    const limit = Math.ceil(n / 2);
    const results = await runTasks(n, (i) =>
      reserveQuota(env, { accountEmail: ACCOUNT, dailyLimit: limit, outreachEmailId: i + 1 }),
    );
    expect(fulfilledValues(results)).toHaveLength(limit - alreadySent);
  });

  it("release returns the slot to the pool", async () => {
    const db = stormDb();
    const env = d1env(db);
    await reserveQuota(env, { accountEmail: ACCOUNT, dailyLimit: 1, outreachEmailId: 1 });
    await expect(
      reserveQuota(env, { accountEmail: ACCOUNT, dailyLimit: 1, outreachEmailId: 2 }),
    ).rejects.toThrow("配额");
    await releaseReservation(env, 1);
    await expect(
      reserveQuota(env, { accountEmail: ACCOUNT, dailyLimit: 1, outreachEmailId: 3 }),
    ).resolves.toBeUndefined();
  });

  it("expired reservations are reaped before counting, freeing both slot and key", async () => {
    const db = stormDb();
    const staleExpires = sqlUtc(new Date(Date.now() - 60 * 60 * 1000));
    db.prepare(
      "INSERT INTO gmail_send_reservations (id, gmail_account_id, idempotency_key, reserved_at, expires_at, status, outreach_email_id) VALUES (?, ?, ?, ?, ?, 'reserved', ?)",
    ).run("stale-1", ACCOUNT, "email:7", PAST, staleExpires, 7);
    const env = d1env(db);
    // Same limit and same email id as the dead reservation: the reaper must
    // free the slot AND the unique key, or this reserve throws either way.
    await expect(
      reserveQuota(env, { accountEmail: ACCOUNT, dailyLimit: 1, outreachEmailId: 7 }),
    ).resolves.toBeUndefined();
    const held = db.prepare(
      "SELECT idempotency_key FROM gmail_send_reservations WHERE status = 'reserved'",
    ).all() as Array<{ idempotency_key: string }>;
    expect(held).toHaveLength(1);
    expect(held[0].idempotency_key).toBe("email:7");
  });
});
