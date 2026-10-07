import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import {
  appendResearchSignals,
  SIGNALS_PER_RUN_CAP,
  SIGNAL_TEXT_CAP,
  SIGNALS_PARSER_VERSION,
} from "../src/research-run";
import { pruneSupersededResearchSignals } from "../src/data-retention";
import { handleAdminRequest } from "../src/admin";
import type { AdminEnv } from "../src/admin";
import { toSqlUtc } from "../src/audit/audit-retention";

/* Phase 4 Stage 40 — buying-signal layer (research_signals).
 *
 * Contract (docs/phase4-ai-intelligence.md §4.1/§6 Stage 40):
 *  - append + supersede, never delete: a fresh run flips the previous
 *    current set to is_current = 0 and appends its own rows in ONE batch;
 *  - UNLIKE facts, the supersede runs even for an empty input — the
 *    current set must always mirror the latest run's judgment, exactly
 *    like the cache column (NULL when the analysis found nothing);
 *  - duplicates within the run collapse, AI order preserved;
 *  - writer-side bounds: ≤ 20 rows/run, signal_text ≤ 500 chars;
 *  - the writer is fail-open (auditability layer, never a reason to lose
 *    paid research);
 *  - retention prunes superseded-only, same policy as evidence/sources/
 *    facts;
 *  - the admin detail endpoint serves the current set (fail-open to an
 *    empty list — a missing table renders no section, never a broken
 *    detail view).
 */

const SCHEMA_SQL = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

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

function makeDb(): any {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  return db;
}

const NOW = new Date("2026-10-06T12:00:00Z");

function insertSignal(
  db: any,
  companyId: string,
  text: string,
  isCurrent: number,
  validUntil: string | null,
): void {
  db.prepare(
    `INSERT INTO research_signals
       (research_run_id, customer_id, signal_text, parser_version, created_at, is_current, valid_from, valid_until)
     VALUES (NULL, ?, ?, 'legacy', ?, ?, ?, ?)`,
  ).run(companyId, text, toSqlUtc(NOW), isCurrent, toSqlUtc(NOW), validUntil);
}

function rows(db: any, sql: string): any[] {
  return db.prepare(sql).all();
}

describe("appendResearchSignals", () => {
  it("appends signals as current rows with parser version and run link", async () => {
    const db = makeDb();
    await appendResearchSignals({ DB: new FakeD1(db) } as any, {
      companyId: "acme",
      runId: "run-1",
      signals: [{ signal_text: "2026 扩张新仓库" }, { signal_text: "新增 SUP 产品线" }],
      now: NOW,
    });
    const all = rows(db, "SELECT signal_text, research_run_id, parser_version, is_current, valid_from FROM research_signals ORDER BY id");
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.signal_text)).toEqual(["2026 扩张新仓库", "新增 SUP 产品线"]);
    for (const r of all) {
      expect(r.research_run_id).toBe("run-1");
      expect(r.parser_version).toBe(SIGNALS_PARSER_VERSION);
      expect(r.is_current).toBe(1);
      expect(r.valid_from).toBe(toSqlUtc(NOW));
    }
  });

  it("supersedes the previous current set in the same batch, never deletes", async () => {
    const db = makeDb();
    const env = { DB: new FakeD1(db) } as any;
    await appendResearchSignals(env, { companyId: "acme", runId: "run-1", signals: [{ signal_text: "旧信号" }], now: NOW });
    await appendResearchSignals(env, { companyId: "acme", runId: "run-2", signals: [{ signal_text: "新信号" }], now: new Date("2026-10-07T12:00:00Z") });
    const all = rows(db, "SELECT signal_text, is_current, valid_until, research_run_id FROM research_signals ORDER BY id");
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ signal_text: "旧信号", is_current: 0, valid_until: toSqlUtc(new Date("2026-10-07T12:00:00Z")) });
    expect(all[1]).toMatchObject({ signal_text: "新信号", is_current: 1, research_run_id: "run-2" });
  });

  it("an empty run still supersedes — current set mirrors the latest judgment like the NULL cache", async () => {
    const db = makeDb();
    const env = { DB: new FakeD1(db) } as any;
    await appendResearchSignals(env, { companyId: "acme", runId: "run-1", signals: [{ signal_text: "旧信号" }], now: NOW });
    await appendResearchSignals(env, { companyId: "acme", runId: "run-2", signals: [], now: NOW });
    const all = rows(db, "SELECT is_current FROM research_signals");
    expect(all).toHaveLength(1);
    expect(all[0].is_current).toBe(0);
  });

  it("dedupes within the run and preserves AI order", async () => {
    const db = makeDb();
    await appendResearchSignals({ DB: new FakeD1(db) } as any, {
      companyId: "acme",
      runId: "run-1",
      signals: [
        { signal_text: "信号A" },
        { signal_text: "信号B" },
        { signal_text: "信号A" },
        { signal_text: " 信号A " },
      ],
      now: NOW,
    });
    const all = rows(db, "SELECT signal_text FROM research_signals ORDER BY id");
    expect(all.map((r) => r.signal_text)).toEqual(["信号A", "信号B"]);
  });

  it("caps rows per run and text length at the writer-side bounds", async () => {
    const db = makeDb();
    const long = "x".repeat(SIGNAL_TEXT_CAP + 40);
    const many = Array.from({ length: SIGNALS_PER_RUN_CAP + 10 }, (_, i) => ({ signal_text: `信号${i}` }));
    many[0].signal_text = long;
    await appendResearchSignals({ DB: new FakeD1(db) } as any, { companyId: "acme", runId: "run-1", signals: many, now: NOW });
    const all = rows(db, "SELECT signal_text FROM research_signals");
    expect(all).toHaveLength(SIGNALS_PER_RUN_CAP);
    expect(all[0].signal_text).toHaveLength(SIGNAL_TEXT_CAP);
  });

  it("drops blank entries before the caps apply", async () => {
    const db = makeDb();
    await appendResearchSignals({ DB: new FakeD1(db) } as any, {
      companyId: "acme",
      runId: "run-1",
      signals: [{ signal_text: "   " }, { signal_text: "" }, { signal_text: "真实信号" }],
      now: NOW,
    });
    const all = rows(db, "SELECT signal_text FROM research_signals");
    expect(all.map((r) => r.signal_text)).toEqual(["真实信号"]);
  });

  it("supersede is per-company — another company's current set is untouched", async () => {
    const db = makeDb();
    const env = { DB: new FakeD1(db) } as any;
    await appendResearchSignals(env, { companyId: "acme", runId: "r1", signals: [{ signal_text: "A信号" }], now: NOW });
    await appendResearchSignals(env, { companyId: "other", runId: "r2", signals: [{ signal_text: "B信号" }], now: NOW });
    expect(rows(db, "SELECT signal_text FROM research_signals WHERE customer_id = 'acme' AND is_current = 1").map((r) => r.signal_text))
      .toEqual(["A信号"]);
    expect(rows(db, "SELECT signal_text FROM research_signals WHERE customer_id = 'other' AND is_current = 1").map((r) => r.signal_text))
      .toEqual(["B信号"]);
  });

  it("fail-open: a missing table never throws (research is never lost to the layer)", async () => {
    const bare = new DatabaseSync(":memory:");
    await expect(
      appendResearchSignals({ DB: new FakeD1(bare) } as any, { companyId: "acme", runId: "r1", signals: [{ signal_text: "信号" }], now: NOW }),
    ).resolves.toBeUndefined();
  });

  it("tolerates a null run id (soft reference, fail-open start)", async () => {
    const db = makeDb();
    await appendResearchSignals({ DB: new FakeD1(db) } as any, { companyId: "acme", runId: null, signals: [{ signal_text: "信号" }], now: NOW });
    const all = rows(db, "SELECT research_run_id FROM research_signals");
    expect(all[0].research_run_id).toBeNull();
  });
});

describe("pruneSupersededResearchSignals", () => {
  it("cuts superseded rows past the horizon, never the current set", async () => {
    const db = makeDb();
    const day = 86_400_000;
    insertSignal(db, "c1", "superseded old", 0, toSqlUtc(new Date(NOW.getTime() - 35 * day)));
    insertSignal(db, "c1", "superseded recent", 0, toSqlUtc(new Date(NOW.getTime() - 10 * day)));
    insertSignal(db, "c1", "current ancient", 1, null);
    expect(await pruneSupersededResearchSignals({ DB: new FakeD1(db) }, 30, NOW)).toBe(1);
    expect(rows(db, "SELECT signal_text FROM research_signals ORDER BY id").map((r) => r.signal_text))
      .toEqual(["superseded recent", "current ancient"]);
  });

  it("missing table is a silent no-op", async () => {
    const bare = new DatabaseSync(":memory:");
    expect(await pruneSupersededResearchSignals({ DB: new FakeD1(bare as any) }, 30, NOW)).toBe(0);
  });
});

describe("admin detail API — current signals (Stage 40 reader)", () => {
  const TOKEN = "signals-master-token";

  function detailReq(id: number): Request {
    return new Request(`https://worker.example/admin/api/customers/${id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  }

  function seed(db: any): number {
    const info = db.prepare(
      "INSERT INTO customers (company_id, display_id, domain, status) VALUES ('acme', 'ACME-001', 'acme.example', 'completed')",
    ).run();
    return Number(info.lastInsertRowid);
  }

  it("serves the current signal set in append order", async () => {
    const db = makeDb();
    const id = seed(db);
    appendForTest(db, "acme", "信号一", 1, null);
    appendForTest(db, "acme", "信号二", 1, null);
    appendForTest(db, "acme", "旧信号", 0, toSqlUtc(NOW));
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    const res = await handleAdminRequest(detailReq(id), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signals: Array<{ signal_text: string }> };
    expect(body.signals.map((s) => s.signal_text)).toEqual(["信号一", "信号二"]);
  });

  it("returns an empty list when the latest run found nothing (superseded-only set)", async () => {
    const db = makeDb();
    const id = seed(db);
    appendForTest(db, "acme", "旧信号", 0, toSqlUtc(NOW));
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    const res = await handleAdminRequest(detailReq(id), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signals: Array<{ signal_text: string }> };
    expect(body.signals).toEqual([]);
  });

  it("missing table fails open to an empty list, never a broken detail view", async () => {
    const db = makeDb();
    const id = seed(db);
    db.exec("DROP TABLE research_signals");
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    const res = await handleAdminRequest(detailReq(id), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signals: Array<{ signal_text: string }> };
    expect(body.signals).toEqual([]);
  });
});

function appendForTest(db: any, companyId: string, text: string, isCurrent: number, validUntil: string | null): void {
  db.prepare(
    `INSERT INTO research_signals
       (research_run_id, customer_id, signal_text, parser_version, created_at, is_current, valid_from, valid_until)
     VALUES (NULL, ?, ?, 'legacy', ?, ?, ?, ?)`,
  ).run(companyId, text, toSqlUtc(NOW), isCurrent, toSqlUtc(NOW), validUntil);
}
