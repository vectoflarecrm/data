import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AdminEnv } from "../src/admin";
import { getCustomerEvidence } from "../src/admin";
import {
  EVIDENCE_PARSER_VERSION,
  startResearchRun,
  completeResearchRun,
  appendFieldEvidence,
  newProvenance,
  type ResearchRunEnv,
} from "../src/research-run";

/* Security V2 Stage 14 — Evidence V2 (spec §15).
 *
 * §15.2 contract: re-research must never UPDATE/DELETE old evidence — new
 * rows are appended and prior rows superseded via is_current/valid_until.
 * §15.3 test list, mapped:
 *   old evidence preserved         ✓ ("append-only supersede …")
 *   new evidence appended          ✓ (same test: run 2's rows land)
 *   source hash                    ✓ ("hash semantics …")
 *   content hash                   ✓ (same + "content hash …")
 *   research run relation          ✓ ("run relation …")
 * Plus: run lifecycle, field isolation, fail-open on migration-pending
 * tables, and the admin read side (current facts first, legacy fallback).
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

/** Full Stage 14 shape: evidence with provenance columns + research_runs. */
function makeDb(): any {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id TEXT NOT NULL,
      contact_id TEXT,
      field_name TEXT NOT NULL,
      field_value TEXT,
      source_url TEXT,
      source_type TEXT,
      evidence_text TEXT,
      confidence REAL,
      collected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      research_run_id TEXT,
      source_id TEXT,
      source_hash TEXT,
      content_hash TEXT,
      parser_version TEXT,
      model_name TEXT,
      model_version TEXT,
      retrieved_at TEXT,
      is_current INTEGER NOT NULL DEFAULT 1,
      valid_from TEXT,
      valid_until TEXT
    );
    CREATE TABLE research_runs (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      parser_version TEXT,
      model_name TEXT,
      model_version TEXT,
      error TEXT
    );
  `);
  return db;
}

function runEnv(db: any): ResearchRunEnv {
  return { DB: new FakeD1(db) } as unknown as ResearchRunEnv;
}

function adminEnv(db: any): AdminEnv {
  return { DB: new FakeD1(db) } as unknown as AdminEnv;
}

/** Mirrors src/research-run.ts's sha256Hex16 so hashes are verified against
 * the documented inputs, not just "some value". */
async function expectedHash16(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest).slice(0, 8);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

const GEMINI = { provider: "gemini", model: "gemini-2.0-flash" };
const GROQ = { provider: "groq", model: "llama-3.3-70b-versatile" };

describe("research run lifecycle", () => {
  it("startResearchRun opens a running row; completeResearchRun closes it with provenance", async () => {
    const db = makeDb();
    const e = runEnv(db);
    const runId = await startResearchRun(e, "acme");
    expect(runId).toBeTruthy();
    const open = db.prepare("SELECT * FROM research_runs WHERE id = ?").get(runId) as Record<string, unknown>;
    expect(open.customer_id).toBe("acme");
    expect(open.status).toBe("running");
    expect(open.started_at).toBeTruthy();
    expect(open.completed_at).toBeNull();

    await completeResearchRun(e, runId, GEMINI);
    const done = db.prepare("SELECT * FROM research_runs WHERE id = ?").get(runId) as Record<string, unknown>;
    expect(done.status).toBe("completed");
    expect(done.completed_at).toBeTruthy();
    expect(done.parser_version).toBe(EVIDENCE_PARSER_VERSION);
    expect(done.model_name).toBe("gemini");
    expect(done.model_version).toBe("gemini-2.0-flash");
    expect(done.error).toBeNull();
  });

  it("failure variant: status failed with the error text; two runs get distinct ids", async () => {
    const db = makeDb();
    const e = runEnv(db);
    const run1 = await startResearchRun(e, "acme");
    const run2 = await startResearchRun(e, "acme");
    expect(run1).not.toBe(run2);
    await completeResearchRun(e, run1, newProvenance(), { error: "AI处理超时（60秒内未完成）" });
    const row = db.prepare("SELECT status, error, model_name FROM research_runs WHERE id = ?").get(run1) as Record<string, unknown>;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("AI处理超时（60秒内未完成）");
    // The failure happened before any analysis → no model stamped.
    expect(row.model_name).toBeNull();
    expect((db.prepare("SELECT status FROM research_runs WHERE id = ?").get(run2) as Record<string, unknown>).status).toBe("running");
  });
});

describe("append-only evidence (spec §15.2)", () => {
  it("old evidence preserved, new evidence appended: supersede via is_current, never delete", async () => {
    const db = makeDb();
    const e = runEnv(db);
    // Run 1 asserts two fields.
    const run1 = await startResearchRun(e, "acme");
    await appendFieldEvidence(e, {
      companyId: "acme",
      runId: run1,
      provenance: GEMINI,
      entries: [
        { field_name: "customer_segment", field_value: "分销商", source_url: "https://acme.example/about", evidence_text: "We distribute inflatable boats", confidence: 0.9 },
        { field_name: "country", field_value: "USA", source_url: "https://acme.example", evidence_text: "Based in Florida", confidence: 0.8 },
      ],
    });
    // Run 2 re-asserts ONLY customer_segment, with a new judgement.
    const run2 = await startResearchRun(e, "acme");
    await appendFieldEvidence(e, {
      companyId: "acme",
      runId: run2,
      provenance: GROQ,
      entries: [
        { field_name: "customer_segment", field_value: "零售商", source_url: "https://acme.example/shop", evidence_text: "Shop our full retail range", confidence: 0.95 },
      ],
    });

    // §15.3 "old evidence preserved": nothing was deleted — all 3 rows exist.
    expect((db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE company_id = 'acme'").get() as Record<string, unknown>).n).toBe(3);

    // Run 1's customer_segment row is superseded but still present.
    const seg1 = db.prepare("SELECT * FROM evidence WHERE research_run_id = ? AND field_name = 'customer_segment'").get(run1) as Record<string, unknown>;
    expect(seg1.is_current).toBe(0);
    expect(seg1.valid_until).toBeTruthy();
    expect(seg1.field_value).toBe("分销商"); // the replaced fact is still readable

    // §15.3 "new evidence appended": run 2's row is the current fact.
    const seg2 = db.prepare("SELECT * FROM evidence WHERE research_run_id = ? AND field_name = 'customer_segment'").get(run2) as Record<string, unknown>;
    expect(seg2.is_current).toBe(1);
    expect(seg2.valid_from).toBeTruthy();
    expect(seg2.valid_until).toBeNull();
    expect(seg2.field_value).toBe("零售商");
    expect(seg2.retrieved_at).toBeTruthy();
    expect(seg2.parser_version).toBe(EVIDENCE_PARSER_VERSION);
    expect(seg2.model_name).toBe("groq");
    expect(seg2.model_version).toBe("llama-3.3-70b-versatile");
    expect(seg2.source_type).toBe("ai_analysis");

    // Field isolation: country (not re-asserted by run 2) stays current.
    const country = db.prepare("SELECT * FROM evidence WHERE field_name = 'country'").get() as Record<string, unknown>;
    expect(country.is_current).toBe(1);
    expect(country.valid_until).toBeNull();
  });

  it("content hash: same fact re-observed → same hash; changed fact → different hash", async () => {
    const db = makeDb();
    const e = runEnv(db);
    const run1 = await startResearchRun(e, "acme");
    await appendFieldEvidence(e, {
      companyId: "acme", runId: run1, provenance: GEMINI,
      entries: [{ field_name: "customer_segment", field_value: "分销商" }],
    });
    const run2 = await startResearchRun(e, "acme");
    await appendFieldEvidence(e, {
      companyId: "acme", runId: run2, provenance: GEMINI,
      entries: [{ field_name: "customer_segment", field_value: "零售商" }],
    });
    const run3 = await startResearchRun(e, "acme");
    await appendFieldEvidence(e, {
      companyId: "acme", runId: run3, provenance: GEMINI,
      entries: [{ field_name: "customer_segment", field_value: "分销商" }],
    });
    const h1 = db.prepare("SELECT content_hash FROM evidence WHERE research_run_id = ?").get(run1) as Record<string, unknown>;
    const h2 = db.prepare("SELECT content_hash FROM evidence WHERE research_run_id = ?").get(run2) as Record<string, unknown>;
    const h3 = db.prepare("SELECT content_hash FROM evidence WHERE research_run_id = ?").get(run3) as Record<string, unknown>;
    // Verified against the documented input (field_name + NUL + field_value).
    expect(h1.content_hash).toBe(await expectedHash16("customer_segment\u0000分销商"));
    expect(h2.content_hash).toBe(await expectedHash16("customer_segment\u0000零售商"));
    // Run 3 re-observed run 1's fact → identical identity hash.
    expect(h3.content_hash).toBe(h1.content_hash);
    expect(h2.content_hash).not.toBe(h1.content_hash);
    // All three versions coexist: append-only, current = run 3.
    expect((db.prepare("SELECT COUNT(*) AS n FROM evidence").get() as Record<string, unknown>).n).toBe(3);
    expect((db.prepare("SELECT COUNT(*) AS n FROM evidence WHERE is_current = 1").get() as Record<string, unknown>).n).toBe(1);
  });

  it("source hash / source_id: same URL → same source_id; same quote → same source_hash; no URL → ai-analysis id", async () => {
    const db = makeDb();
    const e = runEnv(db);
    const run1 = await startResearchRun(e, "acme");
    await appendFieldEvidence(e, {
      companyId: "acme", runId: run1, provenance: GEMINI,
      entries: [
        { field_name: "main_products", field_value: "RIB boats", source_url: "https://acme.example/products", evidence_text: "RIB boats since 1998" },
        { field_name: "country", field_value: "USA" }, // model-judged, no source URL
      ],
    });
    const run2 = await startResearchRun(e, "acme");
    await appendFieldEvidence(e, {
      companyId: "acme", runId: run2, provenance: GEMINI,
      entries: [
        { field_name: "main_products", field_value: "RIB boats", source_url: "https://acme.example/products", evidence_text: "RIB boats since 1998" },
      ],
    });
    const p1 = db.prepare("SELECT source_id, source_hash FROM evidence WHERE research_run_id = ? AND field_name = 'main_products'").get(run1) as Record<string, unknown>;
    const p2 = db.prepare("SELECT source_id, source_hash FROM evidence WHERE research_run_id = ? AND field_name = 'main_products'").get(run2) as Record<string, unknown>;
    // Same source document and same quoted text → stable identities.
    expect(p1.source_id).toBe(p2.source_id);
    expect(p1.source_hash).toBe(p2.source_hash);
    expect(p1.source_id).toBe(await expectedHash16("https://acme.example/products"));
    expect(p1.source_hash).toBe(await expectedHash16("RIB boats since 1998"));
    // Different field_name/field_value → different content_hash, same source.
    expect(
      (db.prepare("SELECT content_hash FROM evidence WHERE research_run_id = ? AND field_name = 'main_products'").get(run2) as Record<string, unknown>).content_hash,
    ).toBe(
      (db.prepare("SELECT content_hash FROM evidence WHERE research_run_id = ? AND field_name = 'main_products'").get(run1) as Record<string, unknown>).content_hash,
    );
    // A changed quote (source drift) → different source_hash.
    const run3 = await startResearchRun(e, "acme");
    await appendFieldEvidence(e, {
      companyId: "acme", runId: run3, provenance: GEMINI,
      entries: [{ field_name: "main_products", field_value: "RIB boats", source_url: "https://acme.example/products", evidence_text: "RIB boats since 2005" }],
    });
    const p3 = db.prepare("SELECT source_id, source_hash FROM evidence WHERE research_run_id = ?").get(run3) as Record<string, unknown>;
    expect(p3.source_id).toBe(p1.source_id);
    expect(p3.source_hash).not.toBe(p1.source_hash);
    // Model-judged fields (no URL) share the "ai-analysis" document identity.
    const judged = db.prepare("SELECT source_id FROM evidence WHERE field_name = 'country'").get() as Record<string, unknown>;
    expect(judged.source_id).toBe(await expectedHash16("ai-analysis"));
  });

  it("research run relation: every evidence row references an existing run of the same customer", async () => {
    const db = makeDb();
    const e = runEnv(db);
    const run1 = await startResearchRun(e, "acme");
    const run2 = await startResearchRun(e, "acme");
    await completeResearchRun(e, run1, GEMINI);
    await appendFieldEvidence(e, {
      companyId: "acme", runId: run1, provenance: GEMINI,
      entries: [{ field_name: "country", field_value: "USA" }],
    });
    await appendFieldEvidence(e, {
      companyId: "acme", runId: run2, provenance: GROQ,
      entries: [
        { field_name: "country", field_value: "USA" },
        { field_name: "main_products", field_value: "kayaks" },
      ],
    });
    const rows = db.prepare(
      "SELECT e.research_run_id AS rid, r.customer_id AS cid, r.status AS status FROM evidence e JOIN research_runs r ON r.id = e.research_run_id",
    ).all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.cid).toBe("acme");
      expect(r.rid).toBeTruthy();
    }
    // A completed run keeps its status even while a later run appends more.
    const statuses = rows.map((r) => r.status);
    expect(statuses).toContain("completed");
    expect(statuses).toContain("running");
  });
});

describe("fail-open on migration-pending schemas", () => {
  it("missing research_runs table: startResearchRun → null, completeResearchRun(null) no-op, nothing throws", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE evidence (id INTEGER PRIMARY KEY, company_id TEXT, field_name TEXT)`);
    const e = runEnv(db);
    const runId = await startResearchRun(e, "acme");
    expect(runId).toBeNull();
    await expect(completeResearchRun(e, runId, GEMINI, { error: "boom" })).resolves.toBeUndefined();
  });

  it("legacy evidence table (no provenance columns): appendFieldEvidence skips, old rows intact", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        field_value TEXT,
        source_url TEXT,
        source_type TEXT,
        evidence_text TEXT,
        confidence REAL,
        collected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.prepare(
      "INSERT INTO evidence (company_id, field_name, field_value, source_type) VALUES ('acme', 'customer_segment', '分销商', 'ai_analysis')",
    ).run();
    const e = runEnv(db);
    await expect(appendFieldEvidence(e, {
      companyId: "acme",
      runId: null,
      provenance: newProvenance(),
      entries: [{ field_name: "customer_segment", field_value: "零售商" }],
    })).resolves.toBeUndefined();
    // The single legacy row is untouched — fail-open must never degrade into
    // the old DELETE behaviour.
    const rows = db.prepare("SELECT field_value FROM evidence WHERE company_id = 'acme'").all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0].field_value).toBe("分销商");
  });
});

describe("admin read side: current facts first", () => {
  it("is_current rows lead the panel view even below superseded rows' confidence", async () => {
    const db = makeDb();
    const e = runEnv(db);
    const run1 = await startResearchRun(e, "acme");
    await appendFieldEvidence(e, {
      companyId: "acme", runId: run1, provenance: GEMINI,
      entries: [{ field_name: "customer_segment", field_value: "旧判定", confidence: 0.99 }],
    });
    const run2 = await startResearchRun(e, "acme");
    await appendFieldEvidence(e, {
      companyId: "acme", runId: run2, provenance: GEMINI,
      entries: [{ field_name: "customer_segment", field_value: "新判定", confidence: 0.5 }],
    });
    const rows = await getCustomerEvidence(adminEnv(db), "acme");
    expect(rows.length).toBe(2);
    // Current fact first even though the superseded row has higher confidence.
    expect(rows[0].field_value).toBe("新判定");
    expect(rows[0].is_current).toBe(1);
    expect(rows[1].field_value).toBe("旧判定");
    expect(rows[1].is_current).toBe(0);
  });

  it("legacy table (no is_current column): falls back to the original query", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id TEXT NOT NULL,
        field_name TEXT NOT NULL,
        field_value TEXT,
        source_url TEXT,
        source_type TEXT,
        evidence_text TEXT,
        confidence REAL,
        collected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.prepare(
      "INSERT INTO evidence (company_id, field_name, field_value, source_type, confidence) VALUES ('acme', 'country', 'USA', 'ai_analysis', 0.9)",
    ).run();
    const rows = await getCustomerEvidence(adminEnv(db), "acme");
    expect(rows.length).toBe(1);
    expect(rows[0].field_value).toBe("USA");
    expect(rows[0].is_current).toBeUndefined();
  });
});
