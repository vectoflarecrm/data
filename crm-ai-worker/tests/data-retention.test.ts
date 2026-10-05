import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index";
import {
  DEFAULT_DATA_RETENTION_DAYS,
  LOGIN_ATTEMPTS_RETENTION_DAYS,
  pruneCustomerImports,
  pruneGmailSendLog,
  pruneLoginAttempts,
  pruneResearchRuns,
  pruneSupersededEvidence,
  resolveDataRetentionDays,
} from "../src/data-retention";
import { toSqlUtc } from "../src/audit/audit-retention";
import { makeDb, FakeD1 } from "./security/_helpers";

/* Post-V2 Stage 31 — business-data retention.
 *
 * Stage 25 bounded audit_logs; this stage bounds gmail_send_log /
 * research_runs / superseded evidence history / customer_imports under
 * DATA_RETENTION_DAYS (same policy shape), plus a fixed 30-day sweep of
 * admin_login_attempts throttle buckets that runs even when the var is "0".
 */

const NOW = new Date("2026-10-05T12:00:00Z");
const DAY = 86_400_000;

function ts(offsetDays: number): string {
  return toSqlUtc(new Date(NOW.getTime() + offsetDays * DAY));
}

function insertSendLog(db: any, recipient: string, sentAt: string): void {
  db.prepare(
    "INSERT INTO gmail_send_log (recipient, status, sent_at) VALUES (?, 'sent', ?)",
  ).run(recipient, sentAt);
}

function insertRun(db: any, id: string, startedAt: string, status = "completed"): void {
  db.prepare(
    "INSERT INTO research_runs (id, customer_id, status, started_at, completed_at) VALUES (?, 'c1', ?, ?, ?)",
  ).run(id, status, startedAt, status === "running" ? null : startedAt);
}

function insertEvidence(
  db: any,
  id: number,
  isCurrent: number,
  collectedAt: string,
  validUntil: string | null,
): void {
  db.prepare(
    "INSERT INTO evidence (id, company_id, field_name, is_current, collected_at, valid_until) VALUES (?, 'c1', 'industry', ?, ?, ?)",
  ).run(id, isCurrent, collectedAt, validUntil);
}

function insertImport(db: any, importId: string, createdAt: string): void {
  db.prepare(
    "INSERT INTO customer_imports (import_id, file_name, row_number, raw_json, dedup_status, created_at) VALUES (?, 'f.csv', 1, '{\"x\":1}', 'inserted', ?)",
  ).run(importId, createdAt);
}

function insertAttempt(db: any, ident: string, updatedAt: string): void {
  db.prepare(
    "INSERT INTO admin_login_attempts (scope, ident, failures, updated_at) VALUES ('ip', ?, 1, ?)",
  ).run(ident, updatedAt);
}

describe("resolveDataRetentionDays", () => {
  it("unset / empty falls back to the 180-day default", () => {
    expect(resolveDataRetentionDays({})).toBe(DEFAULT_DATA_RETENTION_DAYS);
    expect(resolveDataRetentionDays({ DATA_RETENTION_DAYS: "" })).toBe(DEFAULT_DATA_RETENTION_DAYS);
    expect(resolveDataRetentionDays({ DATA_RETENTION_DAYS: "   " })).toBe(DEFAULT_DATA_RETENTION_DAYS);
  });

  it('"0" disables business-data pruning (explicit opt-out)', () => {
    expect(resolveDataRetentionDays({ DATA_RETENTION_DAYS: "0" })).toBeNull();
  });

  it("positive integers are honored, with whitespace tolerated", () => {
    expect(resolveDataRetentionDays({ DATA_RETENTION_DAYS: "90" })).toBe(90);
    expect(resolveDataRetentionDays({ DATA_RETENTION_DAYS: "  60 " })).toBe(60);
  });

  it("garbage and negatives fail SAFE: default, never more aggressive", () => {
    expect(resolveDataRetentionDays({ DATA_RETENTION_DAYS: "abc" })).toBe(DEFAULT_DATA_RETENTION_DAYS);
    expect(resolveDataRetentionDays({ DATA_RETENTION_DAYS: "-5" })).toBe(DEFAULT_DATA_RETENTION_DAYS);
  });
});

describe("pruneGmailSendLog", () => {
  it("deletes rows strictly older than the horizon and reports the count", async () => {
    const db = makeDb();
    insertSendLog(db, "old@x.com", ts(-31));
    insertSendLog(db, "edge@x.com", ts(-30)); // exactly at cutoff
    insertSendLog(db, "new@x.com", ts(-29));
    const env = { DB: new FakeD1(db) };
    expect(await pruneGmailSendLog(env, 30, NOW)).toBe(1);
    const left = db.prepare("SELECT recipient FROM gmail_send_log ORDER BY recipient").all().map((r: any) => r.recipient);
    expect(left).toEqual(["edge@x.com", "new@x.com"]); // boundary survives: strict <
  });

  it("missing table is a silent no-op; other D1 failures propagate", async () => {
    const bare = new DatabaseSync(":memory:");
    expect(await pruneGmailSendLog({ DB: new FakeD1(bare as any) }, 30, NOW)).toBe(0);
    const env = { DB: new FakeD1(makeDb(), "DELETE FROM gmail_send_log") };
    await expect(pruneGmailSendLog(env, 30, NOW)).rejects.toThrow("D1 exploded");
  });
});

describe("pruneResearchRuns", () => {
  it("drops old rows including crashed 'running' runs; fresh rows survive", async () => {
    const db = makeDb();
    insertRun(db, "r-old-done", ts(-40));
    insertRun(db, "r-old-crashed", ts(-40), "running");
    insertRun(db, "r-fresh", ts(-10));
    const env = { DB: new FakeD1(db) };
    expect(await pruneResearchRuns(env, 30, NOW)).toBe(2);
    const left = db.prepare("SELECT id FROM research_runs").all().map((r: any) => r.id);
    expect(left).toEqual(["r-fresh"]);
  });

  it("missing table is a silent no-op", async () => {
    const bare = new DatabaseSync(":memory:");
    expect(await pruneResearchRuns({ DB: new FakeD1(bare as any) }, 30, NOW)).toBe(0);
  });
});

describe("pruneSupersededEvidence", () => {
  it("never touches is_current = 1 rows, however ancient", async () => {
    const db = makeDb();
    insertEvidence(db, 1, 1, ts(-400), null); // live chain, very old
    const env = { DB: new FakeD1(db) };
    expect(await pruneSupersededEvidence(env, 30, NOW)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM evidence").get().n).toBe(1);
  });

  it("cuts superseded rows past the horizon, by valid_until", async () => {
    const db = makeDb();
    insertEvidence(db, 1, 0, ts(-400), ts(-100)); // superseded long ago
    insertEvidence(db, 2, 0, ts(-400), ts(-10)); // superseded recently
    const env = { DB: new FakeD1(db) };
    expect(await pruneSupersededEvidence(env, 30, NOW)).toBe(1);
    expect(db.prepare("SELECT id FROM evidence").get().id).toBe(2);
  });

  it("legacy superseded rows without valid_until fall back to collected_at", async () => {
    const db = makeDb();
    insertEvidence(db, 1, 0, ts(-100), null); // legacy: no valid_until
    insertEvidence(db, 2, 0, ts(-10), null); // legacy, recent
    const env = { DB: new FakeD1(db) };
    expect(await pruneSupersededEvidence(env, 30, NOW)).toBe(1);
    expect(db.prepare("SELECT id FROM evidence").get().id).toBe(2);
  });

  it("missing table is a silent no-op", async () => {
    const bare = new DatabaseSync(":memory:");
    expect(await pruneSupersededEvidence({ DB: new FakeD1(bare as any) }, 30, NOW)).toBe(0);
  });
});

describe("pruneCustomerImports", () => {
  it("deletes old raw rows; normalized customers are a different table", async () => {
    const db = makeDb();
    insertImport(db, "imp-old", ts(-200));
    insertImport(db, "imp-new", ts(-5));
    const env = { DB: new FakeD1(db) };
    expect(await pruneCustomerImports(env, 30, NOW)).toBe(1);
    const left = db.prepare("SELECT import_id FROM customer_imports").all().map((r: any) => r.import_id);
    expect(left).toEqual(["imp-new"]);
  });

  it("missing table is a silent no-op", async () => {
    const bare = new DatabaseSync(":memory:");
    expect(await pruneCustomerImports({ DB: new FakeD1(bare as any) }, 30, NOW)).toBe(0);
  });
});

describe("pruneLoginAttempts (fixed 30-day sweep)", () => {
  it("sweeps buckets older than the fixed horizon; recent ones survive", async () => {
    const db = makeDb();
    insertAttempt(db, "stale-hash", ts(-(LOGIN_ATTEMPTS_RETENTION_DAYS + 1)));
    insertAttempt(db, "live-hash", ts(-(LOGIN_ATTEMPTS_RETENTION_DAYS - 1)));
    const env = { DB: new FakeD1(db) };
    expect(await pruneLoginAttempts(env, NOW)).toBe(1);
    const left = db.prepare("SELECT ident FROM admin_login_attempts").all().map((r: any) => r.ident);
    expect(left).toEqual(["live-hash"]);
  });

  it("missing table is a silent no-op", async () => {
    const bare = new DatabaseSync(":memory:");
    expect(await pruneLoginAttempts({ DB: new FakeD1(bare as any) }, NOW)).toBe(0);
  });
});

describe("scheduled cron tick hosts the data prune (fail-open)", () => {
  const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
  const controller = { cron: "*/5 * * * *", scheduledTime: 0 } as unknown as ScheduledController;

  it("prunes all six tables and writes a DATA_PRUNE row with per-table counts", async () => {
    const db = makeDb();
    insertSendLog(db, "old@x.com", toSqlUtc(new Date(Date.now() - 40 * DAY)));
    insertSendLog(db, "new@x.com", toSqlUtc(new Date()));
    insertRun(db, "r-old", toSqlUtc(new Date(Date.now() - 40 * DAY)));
    insertEvidence(db, 1, 0, toSqlUtc(new Date(Date.now() - 40 * DAY)), toSqlUtc(new Date(Date.now() - 35 * DAY)));
    insertImport(db, "imp-old", toSqlUtc(new Date(Date.now() - 40 * DAY)));
    // Phase 3 Stage 36/37: superseded raw sources and typed facts prune like
    // superseded evidence; the current sets survive regardless of age.
    db.exec(`
      INSERT INTO research_sources (customer_id, source_type, raw_text, fetched_at, is_current, valid_until) VALUES
        ('c1', 'website', 'superseded old', '${toSqlUtc(new Date(Date.now() - 40 * DAY))}', 0, '${toSqlUtc(new Date(Date.now() - 35 * DAY))}'),
        ('c1', 'website', 'current old',   '${toSqlUtc(new Date(Date.now() - 40 * DAY))}', 1, NULL);
      INSERT INTO research_facts (customer_id, fact_type, fact_value, source_type, fetched_at, is_current, valid_until) VALUES
        ('c1', 'email', 'superseded@old.io', 'website', '${toSqlUtc(new Date(Date.now() - 40 * DAY))}', 0, '${toSqlUtc(new Date(Date.now() - 35 * DAY))}'),
        ('c1', 'email', 'current@old.io',    'website', '${toSqlUtc(new Date(Date.now() - 40 * DAY))}', 1, NULL);
    `);
    const env: any = { DB: new FakeD1(db), DATA_RETENTION_DAYS: "30", GEMINI_API_KEY: "x" };
    await worker.scheduled!(controller, env, ctx);
    expect(db.prepare("SELECT COUNT(*) AS n FROM gmail_send_log").get().n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM research_runs").get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM evidence").get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM customer_imports").get().n).toBe(0);
    expect(db.prepare("SELECT raw_text FROM research_sources").all().map((r: any) => r.raw_text)).toEqual(["current old"]);
    expect(db.prepare("SELECT fact_value FROM research_facts").all().map((r: any) => r.fact_value)).toEqual(["current@old.io"]);
    const prune = db.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'DATA_PRUNE'").get() as any;
    expect(prune).toBeTruthy();
    expect(JSON.parse(prune.metadata_json)).toEqual({
      retention_days: 30,
      gmail_send_log: 1,
      research_runs: 1,
      evidence_superseded: 1,
      research_sources_superseded: 1,
      research_facts_superseded: 1,
      customer_imports: 1,
    });
  });

  it('"0" disables business-data pruning but still sweeps login attempts', async () => {
    const db = makeDb();
    insertSendLog(db, "old@x.com", toSqlUtc(new Date(Date.now() - 400 * DAY)));
    insertEvidence(db, 1, 1, toSqlUtc(new Date(Date.now() - 400 * DAY)), null); // live chain
    insertAttempt(db, "stale-hash", toSqlUtc(new Date(Date.now() - 40 * DAY)));
    db.exec(`
      INSERT INTO research_sources (customer_id, source_type, raw_text, fetched_at, is_current, valid_until) VALUES
        ('c1', 'website', 'superseded but kept', '${toSqlUtc(new Date(Date.now() - 400 * DAY))}', 0, '${toSqlUtc(new Date(Date.now() - 399 * DAY))}');
      INSERT INTO research_facts (customer_id, fact_type, fact_value, source_type, fetched_at, is_current, valid_until) VALUES
        ('c1', 'email', 'superseded@kept.io', 'website', '${toSqlUtc(new Date(Date.now() - 400 * DAY))}', 0, '${toSqlUtc(new Date(Date.now() - 399 * DAY))}');
    `);
    const env: any = { DB: new FakeD1(db), DATA_RETENTION_DAYS: "0", GEMINI_API_KEY: "x" };
    await worker.scheduled!(controller, env, ctx);
    expect(db.prepare("SELECT COUNT(*) AS n FROM gmail_send_log").get().n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM evidence").get().n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM research_sources").get().n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM research_facts").get().n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM admin_login_attempts").get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'DATA_PRUNE'").get().n).toBe(0);
  });

  it("a broken prune never breaks the tick: each table has its own envelope via shared try", async () => {
    // whole block is one envelope — verify the cron still completes when the
    // first prune throws a non-missing-table error, and no DATA_PRUNE row lands.
    const db = makeDb();
    const env: any = { DB: new FakeD1(db, "DELETE FROM gmail_send_log"), DATA_RETENTION_DAYS: "30", GEMINI_API_KEY: "x" };
    await expect(worker.scheduled!(controller, env, ctx)).resolves.toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'DATA_PRUNE'").get().n).toBe(0);
  });
});
