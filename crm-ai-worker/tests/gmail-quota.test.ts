import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { GmailEnv } from "../src/gmail";
import { getQuota, accountRemainingQuota, chooseGmailAccount } from "../src/gmail";
import {
  reserveQuota,
  releaseReservation,
  reapExpiredReservations,
  activeReservations,
  RESERVATION_TTL_MS,
} from "../src/gmail-quota";

/* Security V2 Stage 11 — Gmail quota atomic reservation (spec §12).
 *
 * §12.3's concurrency proof is the core: 100 simultaneous reservations
 * against a daily limit of 10 must land at most 10 — never 11, 12 or 20 —
 * because the capacity check and the slot take are one atomic statement.
 */

class FakeD1 {
  constructor(private db: any) {}
  prepare(sql: string) {
    const db = this.db;
    let bound: unknown[] = [];
    const stmt: any = {
      bind(...args: unknown[]) { bound = args; return stmt; },
      all: async () => ({ results: db.prepare(sql).all(...bound), success: true }),
      first: async () => db.prepare(sql).get(...bound) ?? undefined,
      run: async () => {
        const info = db.prepare(sql).run(...bound);
        return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
      },
    };
    return stmt;
  }
  async batch(stmts: any[]) {
    for (const s of stmts) await s.run();
    return [];
  }
}

function makeEnv(overrides: Record<string, unknown> = {}): { db: any; env: GmailEnv } {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE gmail_send_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, outreach_email_id INTEGER,
      recipient TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'sent',
      detail TEXT, sender_client_email TEXT,
      sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE gmail_send_reservations (
      id TEXT PRIMARY KEY,
      gmail_account_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      reserved_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL,
      outreach_email_id TEXT NOT NULL
    );
    CREATE INDEX idx_reservations_account ON gmail_send_reservations(gmail_account_id, status);
    CREATE TABLE gmail_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT, credential_type TEXT,
      client_email TEXT NOT NULL UNIQUE, private_key TEXT NOT NULL,
      delegated_domain TEXT, daily_limit INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
      last_error TEXT, cooldown_until TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return { db, env: { DB: new FakeD1(db), ...overrides } as unknown as GmailEnv };
}

function seedSent(db: any, accountEmail: string, n: number): void {
  for (let i = 0; i < n; i++) {
    db.prepare(
      "INSERT INTO gmail_send_log (outreach_email_id, recipient, status, sender_client_email) VALUES (?, ?, 'sent', ?)",
    ).run(i, "r@x.com", accountEmail);
  }
}

const reserve = (env: GmailEnv, emailId: number, accountEmail = "sa@pool.iam", dailyLimit = 10) =>
  reserveQuota(env, { accountEmail, dailyLimit, outreachEmailId: emailId });

/* ── §12.2/§12.3: the atomic guard ──────────────────────────────────────── */

describe("stage 11: atomic quota reservation (spec §12.2/§12.3)", () => {
  it("100 concurrent reservations against a limit of 10 land exactly 10 — never 11, 12 or 20", async () => {
    const { db, env } = makeEnv();
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, (_, i) => reserve(env, i + 1)),
    );
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(10);
    expect(lost).toHaveLength(90);
    for (const r of lost) expect(String(r.reason)).toMatch(/配额/);
    expect(activeReservationsCount(db)).toBe(10);
    // The guard counted what it wrote: no phantom capacity left.
    await expect(reserve(env, 999)).rejects.toThrow(/配额/);
  });

  it("sent_today from gmail_send_log is part of the guard (7 sent + limit 10 → 3 slots)", async () => {
    const { db, env } = makeEnv();
    seedSent(db, "sa@pool.iam", 7);
    await reserve(env, 101);
    await reserve(env, 102);
    await reserve(env, 103);
    await expect(reserve(env, 104)).rejects.toThrow(/配额/);
    expect(activeReservationsCount(db)).toBe(3);
  });

  it("reservations are per account: exhausting A leaves B untouched (§12.2)", async () => {
    const { db, env } = makeEnv();
    for (let i = 1; i <= 10; i++) await reserve(env, i, "a@pool.iam", 10);
    await expect(reserve(env, 11, "a@pool.iam", 10)).rejects.toThrow(/配额/);
    await expect(reserve(env, 12, "b@pool.iam", 10)).resolves.toBeUndefined();
    seedSent(db, "a@pool.iam", 5); // A's history must not leak into B's guard
    await expect(reserve(env, 13, "b@pool.iam", 10)).resolves.toBeUndefined();
  });

  it("one email can never hold two slots (UNIQUE idempotency key)", async () => {
    const { env } = makeEnv();
    await reserve(env, 7);
    await expect(reserve(env, 7)).rejects.toThrow(/配额预留冲突/);
  });

  it("release frees the slot and the key: the same email can reserve again", async () => {
    const { env } = makeEnv();
    await reserve(env, 7);
    await releaseReservation(env, 7);
    await expect(reserve(env, 7)).resolves.toBeUndefined();
  });
});

/* ── §12.4: TTL recovery ────────────────────────────────────────────────── */

describe("stage 11: reservation TTL recovery (spec §12.4)", () => {
  it("a reservation whose holder died releases its slot at the TTL", async () => {
    const { db, env } = makeEnv();
    const past = new Date(Date.now() - RESERVATION_TTL_MS - 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const stale = `${past.getUTCFullYear()}-${pad(past.getUTCMonth() + 1)}-${pad(past.getUTCDate())} ${pad(past.getUTCHours())}:${pad(past.getUTCMinutes())}:${pad(past.getUTCSeconds())}`;
    db.prepare(
      `INSERT INTO gmail_send_reservations (id, gmail_account_id, idempotency_key, reserved_at, expires_at, status, outreach_email_id)
       VALUES ('r-stale', 'sa@pool.iam', 'email:50', ?, ?, 'reserved', 50)`,
    ).run(stale, stale);

    // The reaper (run inside every reserve) frees the stale slot…
    await reapExpiredReservations(env);
    expect(activeReservationsCount(db)).toBe(0);
    // …so new sends get capacity even though the dead holder "used" one.
    await expect(reserve(env, 51)).resolves.toBeUndefined();
  });

  it("fresh reservations are NOT reaped (a live send keeps its slot)", async () => {
    const { db, env } = makeEnv();
    await reserve(env, 1, "sa@pool.iam", 10);
    await reapExpiredReservations(env);
    expect(activeReservationsCount(db)).toBe(1);
  });
});

/* ── Quota visibility: picks and panel numbers account for holds ────────── */

describe("stage 11: quota views subtract held slots", () => {
  it("getQuota reports reserved_today and a remaining that never promises taken slots", async () => {
    const { db, env } = makeEnv({ GMAIL_DAILY_LIMIT: "10" });
    seedSent(db, "legacy@x", 2);
    await reserve(env, 31);
    await reserve(env, 32);
    await reserve(env, 33);
    const q = await getQuota(env);
    expect(q.sent_today).toBe(2);
    expect(q.reserved_today).toBe(3);
    expect(q.remaining).toBe(5); // 10 - 2 sent - 3 held
  });

  it("accountRemainingQuota subtracts reservations, so account picking prefers free capacity", async () => {
    const { db, env } = makeEnv();
    db.prepare(
      `INSERT INTO gmail_accounts (client_email, private_key, daily_limit, enabled)
       VALUES ('a@pool.iam', 'plain-key-a', 10, 1), ('b@pool.iam', 'plain-key-b', 10, 1)`,
    ).run();
    seedSent(db, "a@pool.iam", 8);
    await reserve(env, 61, "a@pool.iam", 10); // A: 10 - 8 sent - 1 held = 1
    expect(await accountRemainingQuota(env, poolAccount(db, "a@pool.iam"))).toBe(1);
    expect(await accountRemainingQuota(env, poolAccount(db, "b@pool.iam"))).toBe(10);
    const chosen = await chooseGmailAccount(env, null, null);
    expect(chosen.clientEmail).toBe("b@pool.iam");
    expect(chosen.daily_limit).toBe(10); // per-account limit rides on the choice
  });
});

function activeReservationsCount(db: any): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM gmail_send_reservations WHERE status = 'reserved'").get() as { n: number }).n;
}

function poolAccount(db: any, clientEmail: string) {
  const row = db.prepare(
    `SELECT id, label, credential_type, client_email, private_key, delegated_domain,
            daily_limit, enabled, last_error, cooldown_until
     FROM gmail_accounts WHERE client_email = ?`,
  ).get(clientEmail) as Record<string, unknown>;
  return {
    id: row.id as number,
    label: row.label as string | null,
    credential_type: row.credential_type as string | null,
    client_email: row.client_email as string,
    private_key: row.private_key as string,
    delegated_domain: row.delegated_domain as string | null,
    daily_limit: row.daily_limit as number | null,
    enabled: row.enabled as number,
    last_error: row.last_error as string | null,
    cooldown_until: row.cooldown_until as string | null,
  };
}
