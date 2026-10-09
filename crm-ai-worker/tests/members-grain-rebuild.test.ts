import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";

/* Phase 9 Stage 53 — outreach_campaign_members grain rebuild
 * (migrations/0028_campaign_members_grain.sql).
 *
 * The Phase 8 PK (campaign_id, customer_id) hard-codes "one member row per
 * company", which is what forced per-person campaigns to pick exactly one
 * contact. Phase 9 (docs/phase9 §3, operator sign-off 2026-10-09) allows up
 * to contacts_per_company (cap 3) picked contacts per company, so the table
 * must accept several rows per company while still allowing only ONE row
 * per grain. These tests execute the real migration file against a
 * Phase-8-shape database and pin that contract:
 *
 *  1. rows survive with their statuses/errors and contact_norm is computed
 *     (NULL → 0, contact id preserved);
 *  2. the grain UNIQUE index rejects duplicates on BOTH grains — a second
 *     company row (contact_id NULL) AND a repeated contact row — while a
 *     second, different contact of the same company inserts cleanly (the
 *     whole point of the rebuild);
 *  3. the queue index is back (DROP TABLE took it) and the status CHECK
 *     survived the rebuild;
 *  4. the file tolerates re-execution (leading DROP IF EXISTS + INSERT
 *     SELECT from the already-rebuilt table, no explicit PK to collide).
 */

const MIGRATION_SQL = readFileSync(
  new URL("../migrations/0028_campaign_members_grain.sql", import.meta.url),
  "utf8",
);

/* Phase 8 shape: explicit PRIMARY KEY (campaign_id, customer_id), contact_id
 * column, no contact_norm. This is what every production database looks
 * like the moment 0028 runs. */
const LEGACY_SQL = `
CREATE TABLE outreach_campaign_members (
  campaign_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  contact_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'generated', 'sent', 'skipped', 'failed')),
  outreach_email_id INTEGER,
  error TEXT,
  PRIMARY KEY (campaign_id, customer_id)
);
CREATE INDEX idx_campaign_members_queue ON outreach_campaign_members(campaign_id, status);
INSERT INTO outreach_campaign_members (campaign_id, customer_id, contact_id, status, outreach_email_id, error) VALUES
  (1, 10, NULL, 'sent', 4100, NULL),
  (1, 20, 21, 'generated', 4101, NULL),
  (1, 30, 31, 'failed', NULL, 'AI 生成失败'),
  (2, 10, 11, 'pending', NULL, NULL);
`;

function makeLegacyDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(LEGACY_SQL);
  return db;
}

function runMigration(db: DatabaseSync): void {
  /* D1 executes the whole --file as one implicit transaction; the explicit
   * BEGIN/COMMIT here reproduces that contract under node:sqlite. */
  db.exec("BEGIN");
  db.exec(MIGRATION_SQL);
  db.exec("COMMIT");
}

describe("stage 53: outreach_campaign_members grain rebuild (migrations/0028)", () => {
  it("preserves rows, computes contact_norm, and restores the queue index + status CHECK", () => {
    const db = makeLegacyDb();
    runMigration(db);

    const rows = db
      .prepare("SELECT campaign_id, customer_id, contact_id, contact_norm, status, outreach_email_id, error FROM outreach_campaign_members ORDER BY campaign_id, customer_id")
      .all() as Array<{
        campaign_id: number; customer_id: number; contact_id: number | null;
        contact_norm: number; status: string; outreach_email_id: number | null; error: string | null;
      }>;
    expect(rows).toEqual([
      { campaign_id: 1, customer_id: 10, contact_id: null, contact_norm: 0, status: "sent", outreach_email_id: 4100, error: null },
      { campaign_id: 1, customer_id: 20, contact_id: 21, contact_norm: 21, status: "generated", outreach_email_id: 4101, error: null },
      { campaign_id: 1, customer_id: 30, contact_id: 31, contact_norm: 31, status: "failed", outreach_email_id: null, error: "AI 生成失败" },
      { campaign_id: 2, customer_id: 10, contact_id: 11, contact_norm: 11, status: "pending", outreach_email_id: null, error: null },
    ]);

    /* DROP TABLE takes a table's indexes with it — the queue index must be
     * back, alongside the new grain index. */
    const indexes = (db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'outreach_campaign_members' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>)
      .map((r) => r.name)
      .sort();
    expect(indexes).toEqual(["idx_campaign_members_grain", "idx_campaign_members_queue"]);

    /* The status CHECK survived the rebuild — an invalid status is still
     * rejected, so the rebuilt table is not a CHECK-free regression. */
    expect(() =>
      db.prepare("INSERT INTO outreach_campaign_members (campaign_id, customer_id, status) VALUES (9, 90, 'bogus')").run()
    ).toThrow(/CHECK constraint failed/);

    /* No explicit PK anymore (platform limit), no leftover temp table. */
    const pk = db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('outreach_campaign_members') WHERE pk > 0").get() as { n: number };
    expect(pk.n).toBe(0);
    const leftover = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'outreach_campaign_members_new'").get() as { n: number };
    expect(leftover.n).toBe(0);
  });

  it("enforces one row per grain on BOTH grains while allowing sibling contacts", () => {
    const db = makeLegacyDb();
    runMigration(db);

    /* Company grain: (campaign 1, customer 10, NULL) already exists — a
     * second NULL row must now violate the grain index. Under the Phase 8
     * PK this was the only protection; it must not be lost. */
    expect(() =>
      db.prepare("INSERT INTO outreach_campaign_members (campaign_id, customer_id, contact_id, status) VALUES (1, 10, NULL, 'pending')").run()
    ).toThrow(/UNIQUE constraint failed/);

    /* The multi-touch unlock: a second, DIFFERENT contact of the same
     * company inserts cleanly — this is the row shape Phase 8's PK made
     * impossible and Phase 9 exists to allow. */
    db.prepare("INSERT INTO outreach_campaign_members (campaign_id, customer_id, contact_id, status) VALUES (1, 20, 22, 'pending')").run();

    /* Contact grain: repeating the same contact of the same company is
     * still a duplicate. */
    expect(() =>
      db.prepare("INSERT INTO outreach_campaign_members (campaign_id, customer_id, contact_id, status) VALUES (1, 20, 21, 'pending')").run()
    ).toThrow(/UNIQUE constraint failed/);
    /* …and so is repeating the newly inserted sibling. */
    expect(() =>
      db.prepare("INSERT INTO outreach_campaign_members (campaign_id, customer_id, contact_id, status) VALUES (1, 20, 22, 'pending')").run()
    ).toThrow(/UNIQUE constraint failed/);

    /* Company grain of one campaign and contact grain of another coexist:
     * (1, 10, NULL) and (2, 10, NULL) are different campaigns. */
    db.prepare("INSERT INTO outreach_campaign_members (campaign_id, customer_id, contact_id, status) VALUES (2, 10, NULL, 'pending')").run();

    const siblings = db
      .prepare("SELECT contact_id, contact_norm FROM outreach_campaign_members WHERE campaign_id = 1 AND customer_id = 20 ORDER BY contact_norm")
      .all() as Array<{ contact_id: number; contact_norm: number }>;
    expect(siblings).toEqual([
      { contact_id: 21, contact_norm: 21 },
      { contact_id: 22, contact_norm: 22 },
    ]);
  });

  it("tolerates re-execution of the migration file", () => {
    const db = makeLegacyDb();
    runMigration(db);

    /* The file must stay safe to run again: leading DROP IF EXISTS on the
     * temp table, INSERT SELECT from the already-rebuilt table, index
     * creation guarded by IF NOT EXISTS. */
    runMigration(db);

    const count = db.prepare("SELECT COUNT(*) AS n FROM outreach_campaign_members").get() as { n: number };
    expect(count.n).toBe(4);
    const leftover = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'outreach_campaign_members_new'").get() as { n: number };
    expect(leftover.n).toBe(0);
    /* The grain guarantee still holds after the re-run. */
    expect(() =>
      db.prepare("INSERT INTO outreach_campaign_members (campaign_id, customer_id, contact_id, status) VALUES (1, 10, NULL, 'pending')").run()
    ).toThrow(/UNIQUE constraint failed/);
  });
});
