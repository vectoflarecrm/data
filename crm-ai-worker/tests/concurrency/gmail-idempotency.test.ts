import { describe, expect, it } from "vitest";
import {
  CONCURRENCY_LEVELS,
  d1env,
  fulfilledValues,
  rejectionMessages,
  runTasks,
  stormDb,
} from "./_helpers";

/* Security V2 Stage 23 (spec 搂24) 鈥?gmail idempotency under concurrency.
 *
 * sendWithStateMachine (src/outreach-send.ts:193) claims a draft with one
 * conditional UPDATE (status IN ('draft','failed') guards the write), and
 * idx_outreach_idempotency (schema.sql:144) is a UNIQUE partial index over
 * idempotency_key 鈥?the same logical message (campaign + customer +
 * content hash) can only ever exist once. Together they are the hard
 * double-send guarantee; the storm tests below drive the exact production
 * statements. If the claim ever regresses to read-then-write, or the
 * unique index is dropped, a storm of retries double-sends customer email.
 */

/** The production claim (mirror of src/outreach-send.ts:193-198). */
function claimDraft(db: any, emailId: number, workerId: string, key: string): Promise<number> {
  const env = d1env(db);
  return env.DB.prepare(
    `UPDATE outreach_emails
     SET status = 'reserved', idempotency_key = ?, send_attempts = send_attempts + 1,
         locked_at = '2026-10-04 00:00:00', locked_by = ?, last_error = NULL
     WHERE id = ? AND status IN ('draft', 'failed')`,
  )
    .bind(key, workerId, emailId)
    .run()
    .then((r: { meta: { changes: number } }) => r.meta.changes ?? 0);
}

function seedEmails(db: any, n: number, status: string = "draft"): void {
  // customer_id is nullable in the DDL and irrelevant to the claim guard;
  // node:sqlite enforces FKs by default, so real customer rows are seeded
  // to keep the fixture valid rather than fighting the constraint.
  const cust = db.prepare(
    "INSERT OR IGNORE INTO customers (id, company_id, domain, status, company_name) VALUES (?, ?, ?, 'completed', ?)",
  );
  const stmt = db.prepare(
    "INSERT INTO outreach_emails (customer_id, company_id, email_to, subject, body, status) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < n; i++) {
    cust.run(i + 1, `co-${i}`, `d${i}.test.example`, `Customer ${i}`);
    stmt.run(i + 1, `c${i}`, `to${i}@test.example`, "s", "b", status);
  }
}

describe("gmail idempotency under concurrency", () => {
  it.each(CONCURRENCY_LEVELS)("N=%i workers claim one draft: exactly one wins", async (n) => {
    const db = stormDb();
    seedEmails(db, 1);
    const changes = await runTasks(n, (i) => claimDraft(db, 1, `worker-${i}`, `key-${i}`));
    const winners = fulfilledValues(changes).filter((c) => c === 1);
    expect(winners).toHaveLength(1);
    expect(fulfilledValues(changes).filter((c) => c === 0)).toHaveLength(n - 1);
    const row = db.prepare("SELECT status, send_attempts, locked_by FROM outreach_emails WHERE id = 1").get() as {
      status: string;
      send_attempts: number;
      locked_by: string;
    };
    expect(row.status).toBe("reserved");
    expect(row.send_attempts).toBe(1); // incremented exactly once
    expect(row.locked_by).toMatch(/^worker-\d+$/);
  });

  it.each(CONCURRENCY_LEVELS)(
    "N=%i rows collide on one idempotency key: exactly one survives (no double-send)",
    async (n) => {
      const db = stormDb();
      seedEmails(db, n);
      // Every worker stamps the SAME logical message key on its own row 鈥?      // what a retry storm does when the generator regenerates the same
      // content. The unique partial index must keep exactly one.
      const results = await runTasks(n, (i) =>
        d1env(db).DB.prepare("UPDATE outreach_emails SET idempotency_key = ? WHERE id = ?")
          .bind("email:logical-1", i + 1)
          .run(),
      );
      const ok = fulfilledValues(results as PromiseSettledResult<unknown>[]);
      const rejected = rejectionMessages(results as PromiseSettledResult<unknown>[]);
      expect(ok).toHaveLength(1);
      expect(rejected).toHaveLength(n - 1);
      for (const msg of rejected) expect(msg).toContain("UNIQUE");
      const survivors = db.prepare(
        "SELECT COUNT(*) AS c FROM outreach_emails WHERE idempotency_key = 'email:logical-1'",
      ).get() as { c: number };
      expect(survivors.c).toBe(1);
    },
  );

  it.each(CONCURRENCY_LEVELS)("N=%i concurrent reservation inserts for one email: exactly one lands", async (n) => {
    const db = stormDb();
    const results = await runTasks(n, (i) =>
      d1env(db).DB.prepare(
        `INSERT INTO gmail_send_reservations
           (id, gmail_account_id, idempotency_key, reserved_at, expires_at, status, outreach_email_id)
         VALUES (?, 'pool@test.example', 'email:9', '2026-10-04 00:00:00', '2026-10-04 00:15:00', 'reserved', 9)`,
      )
        .bind(`res-${i}`)
        .run(),
    );
    const ok = fulfilledValues(results as PromiseSettledResult<unknown>[]);
    const rejected = rejectionMessages(results as PromiseSettledResult<unknown>[]);
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(n - 1);
    for (const msg of rejected) expect(msg).toContain("UNIQUE");
  });

  it("a lost claimant sees a foreign status, never a second send", async () => {
    const db = stormDb();
    seedEmails(db, 1);
    await claimDraft(db, 1, "winner", "key-w");
    // A late claimant runs the exact production claim after the winner:
    const changes = await claimDraft(db, 1, "latecomer", "key-l");
    expect(changes).toBe(0);
    const row = db.prepare("SELECT status, idempotency_key, locked_by FROM outreach_emails WHERE id = 1").get() as {
      status: string;
      idempotency_key: string;
      locked_by: string;
    };
    expect(row.status).toBe("reserved");
    expect(row.idempotency_key).toBe("key-w");
    expect(row.locked_by).toBe("winner");
  });
});
