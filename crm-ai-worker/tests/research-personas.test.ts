import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import {
  appendResearchPersonas,
  PERSONAS_PER_RUN_CAP,
  PERSONA_NAME_CAP,
  PERSONA_LIST_CAP,
  PERSONA_ITEM_CAP,
  PERSONAS_PARSER_VERSION,
} from "../src/research-run";
import { pruneSupersededResearchPersonas } from "../src/data-retention";
import { handleAdminRequest } from "../src/admin";
import type { AdminEnv } from "../src/admin";
import { toSqlUtc } from "../src/audit/audit-retention";

/* Phase 4 Stage 41 — buyer-persona layer (research_personas).
 *
 * Contract (docs/phase4-ai-intelligence.md §4.2/§6 Stage 41):
 *  - append + supersede in one D1 batch, never delete;
 *  - like signals (and unlike facts), the supersede runs even for an
 *    EMPTY input — the cache column always stores the full
 *    personas_and_solutions object, empty arrays included, so the
 *    current rows must mirror the latest run's judgment the same way;
 *  - duplicates collapse by persona_name (first wins, AI order kept);
 *  - writer-side bounds: ≤ 10 personas/run, name/role ≤ 120 chars,
 *    ≤ 6 needs/pain points per persona, each ≤ 200 chars;
 *  - fail-open writer; retention prunes superseded-only;
 *  - the admin detail endpoint serves the current set (fail-open to an
 *    empty list); the panel prefers rows with JSON-column fallback.
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

function insertPersona(
  db: any,
  companyId: string,
  name: string,
  isCurrent: number,
  validUntil: string | null,
): void {
  db.prepare(
    `INSERT INTO research_personas
       (research_run_id, customer_id, persona_name, persona_role, needs_json, pain_points_json,
        parser_version, created_at, is_current, valid_from, valid_until)
     VALUES (NULL, ?, ?, '旧职位', '[]', '[]', 'legacy', ?, ?, ?, ?)`,
  ).run(companyId, name, toSqlUtc(NOW), isCurrent, toSqlUtc(NOW), validUntil);
}

function rows(db: any, sql: string): any[] {
  return db.prepare(sql).all();
}

describe("appendResearchPersonas", () => {
  it("appends personas as current rows with parser version, run link and JSON lists", async () => {
    const db = makeDb();
    await appendResearchPersonas({ DB: new FakeD1(db) } as any, {
      companyId: "acme",
      runId: "run-1",
      personas: [
        { persona_name: "采购经理", persona_role: "Purchasing Manager", needs: ["成本控制", "稳定供货"], pain_points: ["交期不稳"] },
        { persona_name: "CEO", persona_role: null, needs: [], pain_points: ["增长压力"] },
      ],
      now: NOW,
    });
    const all = rows(db, "SELECT persona_name, persona_role, needs_json, pain_points_json, research_run_id, parser_version, is_current, valid_from FROM research_personas ORDER BY id");
    expect(all).toHaveLength(2);
    expect(all[0].persona_name).toBe("采购经理");
    expect(all[0].persona_role).toBe("Purchasing Manager");
    expect(JSON.parse(all[0].needs_json)).toEqual(["成本控制", "稳定供货"]);
    expect(JSON.parse(all[0].pain_points_json)).toEqual(["交期不稳"]);
    expect(all[1].persona_role).toBeNull();
    for (const r of all) {
      expect(r.research_run_id).toBe("run-1");
      expect(r.parser_version).toBe(PERSONAS_PARSER_VERSION);
      expect(r.is_current).toBe(1);
      expect(r.valid_from).toBe(toSqlUtc(NOW));
    }
  });

  it("supersedes the previous current set in the same batch, never deletes", async () => {
    const db = makeDb();
    const env = { DB: new FakeD1(db) } as any;
    await appendResearchPersonas(env, { companyId: "acme", runId: "run-1", personas: [{ persona_name: "旧画像" }], now: NOW });
    await appendResearchPersonas(env, { companyId: "acme", runId: "run-2", personas: [{ persona_name: "新画像" }], now: new Date("2026-10-07T12:00:00Z") });
    const all = rows(db, "SELECT persona_name, is_current, valid_until, research_run_id FROM research_personas ORDER BY id");
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ persona_name: "旧画像", is_current: 0, valid_until: toSqlUtc(new Date("2026-10-07T12:00:00Z")) });
    expect(all[1]).toMatchObject({ persona_name: "新画像", is_current: 1, research_run_id: "run-2" });
  });

  it("an empty run still supersedes — current set mirrors the latest judgment like the cache column", async () => {
    const db = makeDb();
    const env = { DB: new FakeD1(db) } as any;
    await appendResearchPersonas(env, { companyId: "acme", runId: "run-1", personas: [{ persona_name: "旧画像" }], now: NOW });
    await appendResearchPersonas(env, { companyId: "acme", runId: "run-2", personas: [], now: NOW });
    const all = rows(db, "SELECT is_current FROM research_personas");
    expect(all).toHaveLength(1);
    expect(all[0].is_current).toBe(0);
  });

  it("dedupes by persona_name and preserves AI order", async () => {
    const db = makeDb();
    await appendResearchPersonas({ DB: new FakeD1(db) } as any, {
      companyId: "acme",
      runId: "run-1",
      personas: [
        { persona_name: "画像A" },
        { persona_name: "画像B" },
        { persona_name: "画像A", persona_role: "重复职位" },
      ],
      now: NOW,
    });
    const all = rows(db, "SELECT persona_name, persona_role FROM research_personas ORDER BY id");
    expect(all.map((r) => r.persona_name)).toEqual(["画像A", "画像B"]);
    // First occurrence wins — the duplicate's role is discarded.
    expect(all[0].persona_role).toBeNull();
  });

  it("caps personas per run, name/role length and needs/pain list sizes", async () => {
    const db = makeDb();
    const long = "x".repeat(PERSONA_NAME_CAP + 40);
    const longRole = "y".repeat(PERSONA_NAME_CAP + 40);
    const longItem = "z".repeat(PERSONA_ITEM_CAP + 40);
    const manyNeeds = Array.from({ length: PERSONA_LIST_CAP + 5 }, (_, i) => `需求${i}`);
    const many = Array.from({ length: PERSONAS_PER_RUN_CAP + 5 }, (_, i) => ({ persona_name: `画像${i}` }));
    many[0] = { persona_name: long, persona_role: longRole, needs: [longItem, ...manyNeeds], pain_points: [] };
    await appendResearchPersonas({ DB: new FakeD1(db) } as any, { companyId: "acme", runId: "run-1", personas: many, now: NOW });
    const all = rows(db, "SELECT persona_name, persona_role, needs_json FROM research_personas");
    expect(all).toHaveLength(PERSONAS_PER_RUN_CAP);
    expect(all[0].persona_name).toHaveLength(PERSONA_NAME_CAP);
    expect(all[0].persona_role).toHaveLength(PERSONA_NAME_CAP);
    const needs = JSON.parse(all[0].needs_json);
    expect(needs).toHaveLength(PERSONA_LIST_CAP);
    expect(needs[0]).toHaveLength(PERSONA_ITEM_CAP);
  });

  it("drops blank names and blank list items before the caps apply", async () => {
    const db = makeDb();
    await appendResearchPersonas({ DB: new FakeD1(db) } as any, {
      companyId: "acme",
      runId: "run-1",
      personas: [
        { persona_name: "   " },
        { persona_name: "真实画像", needs: ["  ", "", "真实需求"], pain_points: [" "] },
      ],
      now: NOW,
    });
    const all = rows(db, "SELECT persona_name, needs_json, pain_points_json FROM research_personas");
    expect(all).toHaveLength(1);
    expect(all[0].persona_name).toBe("真实画像");
    expect(JSON.parse(all[0].needs_json)).toEqual(["真实需求"]);
    expect(JSON.parse(all[0].pain_points_json)).toEqual([]);
  });

  it("supersede is per-company — another company's current set is untouched", async () => {
    const db = makeDb();
    const env = { DB: new FakeD1(db) } as any;
    await appendResearchPersonas(env, { companyId: "acme", runId: "r1", personas: [{ persona_name: "A画像" }], now: NOW });
    await appendResearchPersonas(env, { companyId: "other", runId: "r2", personas: [{ persona_name: "B画像" }], now: NOW });
    expect(rows(db, "SELECT persona_name FROM research_personas WHERE customer_id = 'acme' AND is_current = 1").map((r) => r.persona_name))
      .toEqual(["A画像"]);
    expect(rows(db, "SELECT persona_name FROM research_personas WHERE customer_id = 'other' AND is_current = 1").map((r) => r.persona_name))
      .toEqual(["B画像"]);
  });

  it("fail-open: a missing table never throws (research is never lost to the layer)", async () => {
    const bare = new DatabaseSync(":memory:");
    await expect(
      appendResearchPersonas({ DB: new FakeD1(bare) } as any, { companyId: "acme", runId: "r1", personas: [{ persona_name: "画像" }], now: NOW }),
    ).resolves.toBeUndefined();
  });

  it("tolerates a null run id (soft reference, fail-open start)", async () => {
    const db = makeDb();
    await appendResearchPersonas({ DB: new FakeD1(db) } as any, { companyId: "acme", runId: null, personas: [{ persona_name: "画像" }], now: NOW });
    const all = rows(db, "SELECT research_run_id FROM research_personas");
    expect(all[0].research_run_id).toBeNull();
  });
});

describe("pruneSupersededResearchPersonas", () => {
  it("cuts superseded rows past the horizon, never the current set", async () => {
    const db = makeDb();
    const day = 86_400_000;
    insertPersona(db, "c1", "superseded old", 0, toSqlUtc(new Date(NOW.getTime() - 35 * day)));
    insertPersona(db, "c1", "superseded recent", 0, toSqlUtc(new Date(NOW.getTime() - 10 * day)));
    insertPersona(db, "c1", "current ancient", 1, null);
    expect(await pruneSupersededResearchPersonas({ DB: new FakeD1(db) }, 30, NOW)).toBe(1);
    expect(rows(db, "SELECT persona_name FROM research_personas ORDER BY id").map((r) => r.persona_name))
      .toEqual(["superseded recent", "current ancient"]);
  });

  it("missing table is a silent no-op", async () => {
    const bare = new DatabaseSync(":memory:");
    expect(await pruneSupersededResearchPersonas({ DB: new FakeD1(bare as any) }, 30, NOW)).toBe(0);
  });
});

describe("admin detail API — current personas (Stage 41 reader)", () => {
  const TOKEN = "personas-master-token";

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

  it("serves the current persona set in append order", async () => {
    const db = makeDb();
    const id = seed(db);
    insertPersona(db, "acme", "采购经理", 1, null);
    insertPersona(db, "acme", "CEO", 1, null);
    insertPersona(db, "acme", "旧画像", 0, toSqlUtc(NOW));
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    const res = await handleAdminRequest(detailReq(id), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { personas: Array<{ persona_name: string }> };
    expect(body.personas.map((p) => p.persona_name)).toEqual(["采购经理", "CEO"]);
  });

  it("returns an empty list when the latest run found nothing (superseded-only set)", async () => {
    const db = makeDb();
    const id = seed(db);
    insertPersona(db, "acme", "旧画像", 0, toSqlUtc(NOW));
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    const res = await handleAdminRequest(detailReq(id), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { personas: Array<{ persona_name: string }> };
    expect(body.personas).toEqual([]);
  });

  it("missing table fails open to an empty list, never a broken detail view", async () => {
    const db = makeDb();
    const id = seed(db);
    db.exec("DROP TABLE research_personas");
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    const res = await handleAdminRequest(detailReq(id), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { personas: Array<{ persona_name: string }> };
    expect(body.personas).toEqual([]);
  });
});
