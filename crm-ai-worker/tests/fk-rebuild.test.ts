import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";

/* Post-V2 Stage 34 — legacy-database outreach_emails FK rebuild
 * (migrations/0019_outreach_emails_fk_rebuild.sql).
 *
 * SQLite cannot ALTER a table to add a FOREIGN KEY, so the fix for legacy
 * databases (whose outreach_emails predates the schema.sql FK declaration)
 * is a single-transaction table rebuild. These tests execute the real
 * migration file against a legacy-shape database and pin the contract:
 *
 *  1. rows / indexes / AUTOINCREMENT sequence survive the rebuild and the
 *     rebuilt table enforces the FK (node:sqlite enforces foreign keys by
 *     default, matching D1's default-on enforcement);
 *  2. the file tolerates re-execution (CI gates on FK presence, but the
 *     file itself must stay safe to run again);
 *  3. orphaned drafts abort the migration right at the INSERT SELECT
 *     (immediate FK enforcement — the file deliberately avoids
 *     defer_foreign_keys, which was observed to let violations slip
 *     through when reset before commit) and the transaction rolls back
 *     fully — the CI orphan gate is a real defense line, not decoration.
 */

const MIGRATION_SQL = readFileSync(
  new URL("../migrations/0019_outreach_emails_fk_rebuild.sql", import.meta.url),
  "utf8",
);

/* Legacy pre-FK shape: the original CREATE (no FOREIGN KEY, no request_id)
 * followed by the historical ALTERs that appended columns — so the physical
 * column order differs from the rebuilt table's. The migration's INSERT
 * SELECT lists columns explicitly, which is what makes that safe. */
const LEGACY_SQL = `
CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT,
  company_id TEXT
);
CREATE TABLE outreach_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER,
  company_id TEXT,
  display_id TEXT,
  company_name TEXT,
  email_to TEXT,
  product_category TEXT,
  brand_name TEXT,
  subject TEXT,
  body TEXT,
  status TEXT DEFAULT 'draft',
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE outreach_emails ADD COLUMN idempotency_key TEXT;
ALTER TABLE outreach_emails ADD COLUMN send_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outreach_emails ADD COLUMN locked_at TEXT;
ALTER TABLE outreach_emails ADD COLUMN locked_by TEXT;
ALTER TABLE outreach_emails ADD COLUMN last_error TEXT;
ALTER TABLE outreach_emails ADD COLUMN gmail_message_id TEXT;
ALTER TABLE outreach_emails ADD COLUMN request_id TEXT;
CREATE INDEX idx_outreach_customer_id ON outreach_emails(customer_id);
CREATE INDEX idx_outreach_status ON outreach_emails(status);
CREATE INDEX idx_outreach_product ON outreach_emails(product_category);
CREATE UNIQUE INDEX idx_outreach_idempotency ON outreach_emails(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_outreach_send_lock ON outreach_emails(status, locked_at);
INSERT INTO customers (id, company_name) VALUES (1, 'Acme'), (2, 'Globex');
INSERT INTO outreach_emails (id, customer_id, email_to, status, idempotency_key, request_id)
  VALUES (4100, 1, 'a@example.com', 'sent', 'idem-1', 'req-1'),
         (4101, 2, 'b@example.com', 'draft', 'idem-2', NULL),
         (4102, NULL, 'c@example.com', 'failed', NULL, 'req-3');
`;

function makeLegacyDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(LEGACY_SQL);
  return db;
}

describe("stage 34: outreach_emails FK rebuild (migrations/0019)", () => {
  it("rebuilds the legacy table with the FK, preserving rows, indexes and sequence", () => {
    const db = makeLegacyDb();

    /* D1 executes the whole --file as one implicit transaction; the explicit
     * BEGIN/COMMIT here reproduces that contract under node:sqlite. */
    db.exec("BEGIN");
    db.exec(MIGRATION_SQL);
    db.exec("COMMIT");

    const rows = db
      .prepare("SELECT id, customer_id, email_to, status, request_id FROM outreach_emails ORDER BY id")
      .all() as Array<{ id: number; customer_id: number | null; email_to: string; status: string; request_id: string | null }>;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ id: 4100, customer_id: 1, email_to: "a@example.com", status: "sent", request_id: "req-1" });
    expect(rows[1]).toMatchObject({ id: 4101, customer_id: 2, status: "draft", request_id: null });
    expect(rows[2]).toMatchObject({ id: 4102, customer_id: null, status: "failed", request_id: "req-3" });

    /* The rebuilt table declares and enforces the FK — both directions:
     * no orphaned drafts, and referenced customers cannot be deleted. */
    const fk = db.prepare("SELECT COUNT(*) AS n FROM pragma_foreign_key_list('outreach_emails')").get() as { n: number };
    expect(fk.n).toBe(1);
    expect(() =>
      db.prepare("INSERT INTO outreach_emails (customer_id, email_to) VALUES (999, 'orphan@example.com')").run()
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => db.prepare("DELETE FROM customers WHERE id = 1").run()).toThrow(/FOREIGN KEY constraint failed/);
    /* NULL customer_id remains allowed (FK semantics: NULL passes). */
    db.prepare("INSERT INTO outreach_emails (customer_id, email_to) VALUES (NULL, 'no-cust@example.com')").run();

    /* AUTOINCREMENT sequence carried over — generated ids never regress
     * below the historical max (production relies on monotonic ids for
     * idempotency-key uniqueness windows). */
    db.prepare("INSERT INTO outreach_emails (email_to) VALUES ('seq@example.com')").run();
    const generated = db.prepare("SELECT id FROM outreach_emails WHERE email_to = 'seq@example.com'").get() as { id: number };
    expect(generated.id).toBeGreaterThan(4102);

    /* DROP TABLE takes a table's indexes with it — all five must be back. */
    const indexes = (db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'outreach_emails' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>)
      .map((r) => r.name)
      .sort();
    expect(indexes).toEqual([
      "idx_outreach_customer_id",
      "idx_outreach_idempotency",
      "idx_outreach_product",
      "idx_outreach_send_lock",
      "idx_outreach_status",
    ]);
  });

  it("tolerates re-execution of the migration file", () => {
    const db = makeLegacyDb();
    db.exec("BEGIN");
    db.exec(MIGRATION_SQL);
    db.exec("COMMIT");

    /* CI gates on FK presence before running the file, but the file itself
     * must stay safe to run again (leading DROP TABLE IF EXISTS + INSERT
     * SELECT from the already-rebuilt table). */
    db.exec(MIGRATION_SQL);

    const count = db.prepare("SELECT COUNT(*) AS n FROM outreach_emails").get() as { n: number };
    expect(count.n).toBe(3);
    const fk = db.prepare("SELECT COUNT(*) AS n FROM pragma_foreign_key_list('outreach_emails')").get() as { n: number };
    expect(fk.n).toBe(1);
    const leftover = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'outreach_emails_new'").get() as { n: number };
    expect(leftover.n).toBe(0);
  });

  it("aborts atomically on orphaned drafts — the orphan gate is a real defense line", () => {
    const db = makeLegacyDb();
    db.exec("INSERT INTO outreach_emails (id, customer_id, email_to) VALUES (4103, 999, 'orphan@example.com')");

    /* No PRAGMA defer_foreign_keys in the migration: the orphan fails the
     * rebuilt FK right at the INSERT SELECT (immediate enforcement —
     * stricter than deferring to commit, and empirically the only form
     * that reliably rejects across engines; resetting defer before commit
     * was observed to let violations through). D1 runs the file as one
     * implicit transaction, so the whole rebuild rolls back. */
    db.exec("BEGIN");
    expect(() => db.exec(MIGRATION_SQL)).toThrow(/FOREIGN KEY constraint failed/);
    db.exec("ROLLBACK");

    const count = db.prepare("SELECT COUNT(*) AS n FROM outreach_emails").get() as { n: number };
    expect(count.n).toBe(4);
    const fk = db.prepare("SELECT COUNT(*) AS n FROM pragma_foreign_key_list('outreach_emails')").get() as { n: number };
    expect(fk.n).toBe(0);
    const leftover = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'outreach_emails_new'").get() as { n: number };
    expect(leftover.n).toBe(0);
  });
});
