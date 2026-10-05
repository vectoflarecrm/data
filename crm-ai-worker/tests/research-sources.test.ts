import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import {
  appendResearchSources,
  capResearchSourcesToBudget,
  RESEARCH_SOURCE_TOTAL_CAP,
  SOURCES_PARSER_VERSION,
} from "../src/research-run";
import { pruneSupersededResearchSources } from "../src/data-retention";

/* Phase 3 Stage 36 — raw source registry (research_sources).
 *
 * Contract (docs/phase3-research-engine.md §3):
 *  - append + supersede, never delete: a fresh run flips the previous
 *    current set to is_current = 0 and appends its own rows in ONE batch;
 *  - total raw text per run is budget-capped to the blob's 50 000 chars,
 *    walked in blob order (website → social → search → additional);
 *  - empty-text entries with a URL survive (they record "crawled, got
 *    nothing"); empty-text entries without a URL are dropped;
 *  - the writer is fail-open like appendFieldEvidence (auditability layer,
 *    never a reason to lose paid research);
 *  - the 0021 backfill turns legacy blobs into synthetic runs + source
 *    rows, idempotently, and never pollutes customers that already have
 *    real per-run history;
 *  - retention prunes superseded-only, same policy as evidence.
 */

const SCHEMA_SQL = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const BACKFILL_SQL = readFileSync(
  new URL("../migrations/0021_research_sources_backfill.sql", import.meta.url),
  "utf8",
);

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

function sha16(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function insertRun(db: any, id: string, companyId: string): void {
  db.prepare(
    "INSERT INTO research_runs (id, customer_id, status, started_at) VALUES (?, ?, 'running', '2026-01-01 00:00:00')",
  ).run(id, companyId);
}

function rows(db: any, sql: string): any[] {
  return db.prepare(sql).all();
}

describe("appendResearchSources", () => {
  it("appends fresh segments as current rows with hashes and run link", async () => {
    const db = makeDb();
    insertRun(db, "run-1", "comp-1");
    await appendResearchSources({ DB: new FakeD1(db) as any }, {
      companyId: "comp-1",
      runId: "run-1",
      sources: [
        { source_type: "website", source_url: "https://acme.example", raw_text: "homepage text" },
        { source_type: "search", raw_text: "search results block" },
      ],
      now: new Date("2026-02-03T04:05:06Z"),
    });

    const all = rows(db, "SELECT * FROM research_sources ORDER BY id");
    expect(all).toHaveLength(2);
    for (const r of all) {
      expect(r.is_current).toBe(1);
      expect(r.research_run_id).toBe("run-1");
      expect(r.customer_id).toBe("comp-1");
      expect(r.parser_version).toBe(SOURCES_PARSER_VERSION);
      expect(r.valid_from).toBe("2026-02-03 04:05:06");
      expect(r.valid_until).toBeNull();
    }
    expect(all[0].source_type).toBe("website");
    expect(all[0].source_url).toBe("https://acme.example");
    expect(all[0].content_hash).toBe(sha16("homepage text"));
    expect(all[1].source_type).toBe("search");
    expect(all[1].source_url).toBeNull();
    expect(all[1].content_hash).toBe(sha16("search results block"));
  });

  it("supersedes the previous set on re-research, never deletes", async () => {
    const db = makeDb();
    insertRun(db, "run-1", "comp-1");
    insertRun(db, "run-2", "comp-1");
    const env = { DB: new FakeD1(db) as any };
    await appendResearchSources(env, {
      companyId: "comp-1",
      runId: "run-1",
      sources: [
        { source_type: "website", source_url: "https://acme.example", raw_text: "old homepage" },
        { source_type: "search", raw_text: "old results" },
      ],
      now: new Date("2026-02-03T00:00:00Z"),
    });
    await appendResearchSources(env, {
      companyId: "comp-1",
      runId: "run-2",
      sources: [{ source_type: "website", source_url: "https://acme.example", raw_text: "new homepage" }],
      now: new Date("2026-02-04T00:00:00Z"),
    });

    const all = rows(db, "SELECT * FROM research_sources ORDER BY id");
    expect(all).toHaveLength(3);
    const superseded = all.filter((r) => r.research_run_id === "run-1");
    expect(superseded).toHaveLength(2);
    for (const r of superseded) {
      expect(r.is_current).toBe(0);
      expect(r.valid_until).toBe("2026-02-04 00:00:00");
      expect(r.valid_from).toBe("2026-02-03 00:00:00");
    }
    const current = all.filter((r) => r.research_run_id === "run-2");
    expect(current).toHaveLength(1);
    expect(current[0].is_current).toBe(1);
    expect(current[0].raw_text).toBe("new homepage");
  });

  it("keeps other companies' current rows untouched (supersede is per company)", async () => {
    const db = makeDb();
    insertRun(db, "run-a", "comp-a");
    insertRun(db, "run-b", "comp-b");
    const env = { DB: new FakeD1(db) as any };
    await appendResearchSources(env, {
      companyId: "comp-a",
      runId: "run-a",
      sources: [{ source_type: "website", raw_text: "a homepage" }],
    });
    await appendResearchSources(env, {
      companyId: "comp-b",
      runId: "run-b",
      sources: [{ source_type: "website", raw_text: "b homepage" }],
    });

    const current = rows(db, "SELECT customer_id FROM research_sources WHERE is_current = 1 ORDER BY customer_id");
    expect(current.map((r) => r.customer_id)).toEqual(["comp-a", "comp-b"]);
  });

  it("is fail-open when the table is missing (pre-migration window)", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE research_runs (
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, completed_at TEXT, parser_version TEXT,
        model_name TEXT, model_version TEXT, error TEXT
      );
    `);
    await expect(appendResearchSources({ DB: new FakeD1(db) as any }, {
      companyId: "comp-1",
      runId: "run-1",
      sources: [{ source_type: "website", raw_text: "text" }],
    })).resolves.toBeUndefined();
  });

  it("tolerates a null run id (fail-open run start) and still records sources", async () => {
    const db = makeDb();
    await appendResearchSources({ DB: new FakeD1(db) as any }, {
      companyId: "comp-1",
      runId: null,
      sources: [{ source_type: "website", raw_text: "orphan run text" }],
    });
    const all = rows(db, "SELECT * FROM research_sources");
    expect(all).toHaveLength(1);
    expect(all[0].research_run_id).toBeNull();
    expect(all[0].raw_text).toBe("orphan run text");
  });
});

describe("capResearchSourcesToBudget", () => {
  it("caps total raw text to the blob budget in blob order", () => {
    const capped = capResearchSourcesToBudget([
      { source_type: "website", raw_text: "a".repeat(30_000) },
      { source_type: "social", raw_text: "b".repeat(15_000) },
      { source_type: "search", raw_text: "c".repeat(10_000) },
      { source_type: "additional", raw_text: "d".repeat(10_000) },
    ]);
    expect(capped.map((e) => e.source_type)).toEqual(["website", "social", "search"]);
    expect(capped[0].raw_text).toHaveLength(30_000);
    expect(capped[1].raw_text).toHaveLength(15_000);
    expect(capped[2].raw_text).toHaveLength(5_000);
    const total = capped.reduce((n, e) => n + e.raw_text.length, 0);
    expect(total).toBe(RESEARCH_SOURCE_TOTAL_CAP);
  });

  it("keeps empty-text URL entries (site unreachable this run) even at zero budget", () => {
    const capped = capResearchSourcesToBudget([
      { source_type: "website", source_url: "https://acme.example", raw_text: "" },
      { source_type: "website", raw_text: "x".repeat(RESEARCH_SOURCE_TOTAL_CAP) },
      { source_type: "search", source_url: "https://search.example", raw_text: "" },
    ]);
    expect(capped).toHaveLength(3);
    expect(capped[0].source_url).toBe("https://acme.example");
    expect(capped[1].raw_text).toHaveLength(RESEARCH_SOURCE_TOTAL_CAP);
    expect(capped[2].source_url).toBe("https://search.example");
  });

  it("drops empty entries without a URL and empty input entirely", () => {
    expect(capResearchSourcesToBudget([{ source_type: "social", raw_text: "" }])).toEqual([]);
    expect(capResearchSourcesToBudget([])).toEqual([]);
  });

  it("enforces the cap inside the writer (no caller can store unbounded raw text)", async () => {
    const db = makeDb();
    await appendResearchSources({ DB: new FakeD1(db) as any }, {
      companyId: "comp-1",
      runId: null,
      sources: [
        { source_type: "website", raw_text: "a".repeat(60_000) },
        { source_type: "search", raw_text: "b".repeat(60_000) },
      ],
    });
    const all = rows(db, "SELECT raw_text FROM research_sources");
    expect(all).toHaveLength(1);
    expect(all[0].raw_text).toHaveLength(RESEARCH_SOURCE_TOTAL_CAP);
  });
});

describe("0021 backfill migration", () => {
  function seed(db: any): void {
    db.prepare(
      "INSERT INTO customers (id, company_id, domain, full_research_text) VALUES (?, ?, ?, ?)",
    ).run(1, "comp-1", "acme.example", "=== 主网站内容 ===\nlegacy blob one");
    db.prepare(
      "INSERT INTO customers (id, company_id, domain, full_research_text) VALUES (?, ?, ?, ?)",
    ).run(2, "comp-2", "beta.example", "   ");
    db.prepare(
      "INSERT INTO customers (id, company_id, domain, full_research_text) VALUES (?, ?, ?, ?)",
    ).run(3, "comp-3", "gamma.example", "legacy blob three - already researched post-Stage-36");
    db.prepare(
      "INSERT INTO customers (id, company_id, domain, full_research_text) VALUES (?, ?, ?, ?)",
    ).run(4, "comp-4", "delta.example", "legacy blob four - backfill run exists, source row missing");
    // comp-3 already has real per-run history from the new code path.
    db.prepare(
      "INSERT INTO research_sources (research_run_id, customer_id, source_type, raw_text, fetched_at) VALUES (?, ?, 'website', 'real crawl', '2026-01-01 00:00:00')",
    ).run("run-3", "comp-3");
    // comp-4 has a backfill run from an interrupted attempt but no source row.
    db.prepare(
      "INSERT INTO research_runs (id, customer_id, status, started_at, completed_at, parser_version) VALUES ('backfill-4', 'comp-4', 'completed', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'backfill-v1')",
    ).run();
  }

  it("turns legacy blobs into synthetic runs + source rows, idempotently", () => {
    const db = makeDb();
    seed(db);
    db.exec(BACKFILL_SQL);

    const runs = rows(db, "SELECT id, customer_id FROM research_runs WHERE parser_version = 'backfill-v1' ORDER BY id");
    expect(runs.map((r) => r.customer_id)).toEqual(["comp-1", "comp-4"]);

    const sources = rows(db, "SELECT customer_id, source_type, raw_text, content_hash, parser_version, is_current FROM research_sources WHERE parser_version = 'backfill-v1' ORDER BY customer_id");
    expect(sources).toHaveLength(2);
    expect(sources[0].customer_id).toBe("comp-1");
    expect(sources[0].raw_text).toBe("=== 主网站内容 ===\nlegacy blob one");
    expect(sources[0].source_type).toBe("backfill");
    expect(sources[0].content_hash).toBeNull();
    expect(sources[0].parser_version).toBe("backfill-v1");
    expect(sources[0].is_current).toBe(1);
    expect(sources[1].customer_id).toBe("comp-4");

    // comp-2 (empty blob) and comp-3 (already has real history) stay absent.
    expect(rows(db, "SELECT COUNT(*) AS n FROM research_sources WHERE customer_id IN ('comp-2', 'comp-3') AND parser_version = 'backfill-v1'")[0].n).toBe(0);

    // Re-execution is a no-op on every interleaving.
    db.exec(BACKFILL_SQL);
    expect(rows(db, "SELECT COUNT(*) AS n FROM research_runs WHERE parser_version = 'backfill-v1'")[0].n).toBe(2);
    expect(rows(db, "SELECT COUNT(*) AS n FROM research_sources WHERE parser_version = 'backfill-v1'")[0].n).toBe(2);
  });

  it("does not re-backfill a customer whose blob was rewritten by the new code", () => {
    const db = makeDb();
    seed(db);
    db.exec(BACKFILL_SQL);
    // Post-Stage-36 research: the new writer superseded the backfill row and
    // appended real segments. A later re-deploy must not add another backfill.
    db.exec(`
      UPDATE research_sources SET is_current = 0, valid_until = '2026-02-05 00:00:00' WHERE customer_id = 'comp-1';
      INSERT INTO research_sources (research_run_id, customer_id, source_type, raw_text, fetched_at) VALUES ('run-1', 'comp-1', 'website', 'fresh crawl', '2026-02-05 00:00:00');
      UPDATE customers SET full_research_text = '=== 主网站内容 ===\nfresh dual-write blob' WHERE id = 1;
    `);
    db.exec(BACKFILL_SQL);
    expect(rows(db, "SELECT COUNT(*) AS n FROM research_runs WHERE customer_id = 'comp-1' AND parser_version = 'backfill-v1'")[0].n).toBe(1);
    expect(rows(db, "SELECT COUNT(*) AS n FROM research_sources WHERE customer_id = 'comp-1'")[0].n).toBe(2);
  });
});

describe("pruneSupersededResearchSources", () => {
  it("prunes only superseded rows past the horizon, current snapshot survives forever", async () => {
    const db = makeDb();
    db.exec(`
      INSERT INTO research_sources (customer_id, source_type, raw_text, fetched_at, is_current, valid_until) VALUES
        ('comp-1', 'website', 'current but ancient', '2020-01-01 00:00:00', 1, NULL),
        ('comp-1', 'website', 'superseded ancient',   '2020-01-01 00:00:00', 0, '2020-02-01 00:00:00'),
        ('comp-1', 'website', 'superseded recent',    '2026-01-01 00:00:00', 0, '2026-10-01 00:00:00'),
        ('comp-1', 'website', 'superseded ancient, no valid_until (legacy)', '2020-01-01 00:00:00', 0, NULL);
    `);
    const deleted = await pruneSupersededResearchSources({ DB: new FakeD1(db) as any }, 30, new Date("2026-10-06T00:00:00Z"));
    expect(deleted).toBe(2);
    const kept = rows(db, "SELECT raw_text FROM research_sources ORDER BY id").map((r) => r.raw_text);
    expect(kept).toEqual(["current but ancient", "superseded recent"]);
  });

  it("is fail-open on a missing table (pre-migration window)", async () => {
    const db = new DatabaseSync(":memory:");
    await expect(pruneSupersededResearchSources({ DB: new FakeD1(db) as any }, 30)).resolves.toBe(0);
  });
});
