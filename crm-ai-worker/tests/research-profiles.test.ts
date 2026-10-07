import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import {
  appendResearchProfile,
  linkResearchFactsToContacts,
  SOLUTIONS_PER_RUN_CAP,
  SOLUTION_FIELD_CAP,
  PROFILE_JSON_CAP,
  PROFILES_PARSER_VERSION,
} from "../src/research-run";
import { pruneSupersededResearchProfiles } from "../src/data-retention";
import { handleAdminRequest } from "../src/admin";
import type { AdminEnv } from "../src/admin";
import { toSqlUtc } from "../src/audit/audit-retention";

/* Phase 4 Stage 42 — profile/strategy layer (research_profiles) + the
 * research_facts entity column (contact_id).
 *
 * Contract (docs/phase4-ai-intelligence.md §4.3/§4.4/§6 Stage 42):
 *  - append + supersede in one D1 batch, never delete;
 *  - 1:1 grain: the row ALWAYS lands, one per run — even when all three
 *    payloads are empty (a run that produced nothing is still history);
 *  - solutions bounded like personas: ≤ 10 per run, dedup by name
 *    (first wins, AI order kept), each field ≤ 200 chars;
 *  - profile/strategy JSON over PROFILE_JSON_CAP drops to NULL — never
 *    sliced (a sliced JSON string would violate json_valid);
 *  - linkage: only THIS run's current facts, only contacts of the SAME
 *    company, never overwriting an existing link; null run id = no-op;
 *  - fail-open writers and linkage; retention prunes superseded-only;
 *  - the admin detail endpoint serves linked facts with the contact
 *    name (fail-open to an empty list).
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

function insertProfile(
  db: any,
  companyId: string,
  isCurrent: number,
  validUntil: string | null,
): void {
  db.prepare(
    `INSERT INTO research_profiles
       (research_run_id, customer_id, company_profile_json, strategy_json, solutions_json,
        parser_version, created_at, is_current, valid_from, valid_until)
     VALUES ('legacy-run', ?, '{"legacy":true}', NULL, '[]', 'legacy', ?, ?, ?, ?)`,
  ).run(companyId, toSqlUtc(NOW), isCurrent, toSqlUtc(NOW), validUntil);
}

function insertFact(
  db: any,
  companyId: string,
  runId: string | null,
  factType: string,
  factValue: string,
  isCurrent: number,
  contactId: string | null,
): void {
  db.prepare(
    `INSERT INTO research_facts
       (research_run_id, customer_id, fact_type, fact_value, contact_id, source_type,
        occurrence_count, confidence, parser_version, fetched_at, is_current, valid_from, valid_until)
     VALUES (?, ?, ?, ?, ?, 'website', 1, 1, 'facts-v1', ?, ?, ?, NULL)`,
  ).run(runId, companyId, factType, factValue, contactId, toSqlUtc(NOW), isCurrent, toSqlUtc(NOW));
}

function insertContact(
  db: any,
  companyId: string,
  seq: number,
  email: string | null,
  cellphone: string | null,
): string {
  const contactId = `${companyId}_${String(seq).padStart(3, "0")}`;
  db.prepare(
    `INSERT INTO contacts (contact_id, company_id, seq, first_name, last_name, title, email, cellphone)
     VALUES (?, ?, ?, 'Anna', 'Meier', 'Purchasing Manager', ?, ?)`,
  ).run(contactId, companyId, seq, email, cellphone);
  return contactId;
}

function rows(db: any, sql: string): any[] {
  return db.prepare(sql).all();
}

describe("appendResearchProfile", () => {
  it("appends exactly one current row per run with all three payloads", async () => {
    const db = makeDb();
    await appendResearchProfile({ DB: new FakeD1(db) } as any, {
      companyId: "acme",
      runId: "run-1",
      companyProfileJson: '{"company_background":"经销商"}',
      strategyJson: '{"recommended_angle":"供应链替换"}',
      solutions: [{ name: "定制充气艇配套", value: "OEM 生产", target_persona: "Purchasing Manager" }],
      now: NOW,
    });
    const all = rows(db, "SELECT * FROM research_profiles");
    expect(all).toHaveLength(1);
    expect(all[0].research_run_id).toBe("run-1");
    expect(all[0].customer_id).toBe("acme");
    expect(JSON.parse(all[0].company_profile_json)).toEqual({ company_background: "经销商" });
    expect(JSON.parse(all[0].strategy_json)).toEqual({ recommended_angle: "供应链替换" });
    expect(JSON.parse(all[0].solutions_json)).toEqual([
      { name: "定制充气艇配套", value: "OEM 生产", target_persona: "Purchasing Manager" },
    ]);
    expect(all[0].parser_version).toBe(PROFILES_PARSER_VERSION);
    expect(all[0].is_current).toBe(1);
    expect(all[0].valid_from).toBe(toSqlUtc(NOW));
  });

  it("supersedes the previous current row in the same batch, never deletes", async () => {
    const db = makeDb();
    const env = { DB: new FakeD1(db) } as any;
    await appendResearchProfile(env, { companyId: "acme", runId: "run-1", companyProfileJson: '{"old":1}', strategyJson: null, solutions: [], now: NOW });
    await appendResearchProfile(env, { companyId: "acme", runId: "run-2", companyProfileJson: null, strategyJson: null, solutions: [], now: new Date("2026-10-07T12:00:00Z") });
    const all = rows(db, "SELECT research_run_id, company_profile_json, is_current, valid_until FROM research_profiles ORDER BY id");
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ research_run_id: "run-1", is_current: 0, valid_until: toSqlUtc(new Date("2026-10-07T12:00:00Z")) });
    expect(all[1]).toMatchObject({ research_run_id: "run-2", is_current: 1 });
  });

  it("lands the row even when all payloads are empty — one run = one row", async () => {
    const db = makeDb();
    await appendResearchProfile({ DB: new FakeD1(db) } as any, {
      companyId: "acme", runId: "run-1", companyProfileJson: null, strategyJson: null, solutions: [], now: NOW,
    });
    const all = rows(db, "SELECT company_profile_json, strategy_json, solutions_json, is_current FROM research_profiles");
    expect(all).toHaveLength(1);
    expect(all[0].company_profile_json).toBeNull();
    expect(all[0].strategy_json).toBeNull();
    expect(JSON.parse(all[0].solutions_json)).toEqual([]);
    expect(all[0].is_current).toBe(1);
  });

  it("bounds solutions like personas: cap per run, field caps, dedup by name, blanks dropped", async () => {
    const db = makeDb();
    const long = "x".repeat(SOLUTION_FIELD_CAP + 40);
    const many = Array.from({ length: SOLUTIONS_PER_RUN_CAP + 5 }, (_, i) => ({
      name: `方案${i}`,
      value: `描述${i}`,
      target_persona: `角色${i}`,
    }));
    many[0] = { name: long, value: long, target_persona: long };
    many.push({ name: "方案0" }); // duplicate of the first — must collapse
    many.push({ name: "   " }); // blank — must drop
    await appendResearchProfile({ DB: new FakeD1(db) } as any, {
      companyId: "acme", runId: "run-1", companyProfileJson: null, strategyJson: null, solutions: many, now: NOW,
    });
    const all = rows(db, "SELECT solutions_json FROM research_profiles");
    expect(all).toHaveLength(1);
    const stored = JSON.parse(all[0].solutions_json);
    expect(stored).toHaveLength(SOLUTIONS_PER_RUN_CAP);
    expect(stored[0].name).toHaveLength(SOLUTION_FIELD_CAP);
    expect(stored[0].value).toHaveLength(SOLUTION_FIELD_CAP);
    expect(stored[0].target_persona).toHaveLength(SOLUTION_FIELD_CAP);
    // Dedup by name kept AI order: 方案0's duplicate never appears twice.
    expect(stored.filter((s: any) => s.name.startsWith("方案0")).length).toBeLessThanOrEqual(1);
  });

  it("drops oversized profile/strategy JSON to NULL instead of slicing (json_valid survives)", async () => {
    const db = makeDb();
    const huge = `{"pad":"${"y".repeat(PROFILE_JSON_CAP)}"}`;
    expect(huge.length).toBeGreaterThan(PROFILE_JSON_CAP);
    await appendResearchProfile({ DB: new FakeD1(db) } as any, {
      companyId: "acme", runId: "run-1", companyProfileJson: huge, strategyJson: huge, solutions: [], now: NOW,
    });
    const all = rows(db, "SELECT company_profile_json, strategy_json, solutions_json FROM research_profiles");
    expect(all).toHaveLength(1);
    expect(all[0].company_profile_json).toBeNull();
    expect(all[0].strategy_json).toBeNull();
    // The bounded payload is untouched by the cap.
    expect(JSON.parse(all[0].solutions_json)).toEqual([]);
  });

  it("supersede is per-company — another company's current row is untouched", async () => {
    const db = makeDb();
    const env = { DB: new FakeD1(db) } as any;
    await appendResearchProfile(env, { companyId: "acme", runId: "r1", companyProfileJson: '{"a":1}', strategyJson: null, solutions: [], now: NOW });
    await appendResearchProfile(env, { companyId: "other", runId: "r2", companyProfileJson: '{"b":1}', strategyJson: null, solutions: [], now: NOW });
    expect(rows(db, "SELECT company_profile_json FROM research_profiles WHERE customer_id = 'acme' AND is_current = 1").length).toBe(1);
    expect(rows(db, "SELECT company_profile_json FROM research_profiles WHERE customer_id = 'other' AND is_current = 1").length).toBe(1);
  });

  it("fail-open: a missing table never throws (research is never lost to the layer)", async () => {
    const bare = new DatabaseSync(":memory:");
    await expect(
      appendResearchProfile({ DB: new FakeD1(bare) } as any, { companyId: "acme", runId: "r1", companyProfileJson: "{}", strategyJson: null, solutions: [], now: NOW }),
    ).resolves.toBeUndefined();
  });

  it("tolerates a null run id (soft reference, fail-open start)", async () => {
    const db = makeDb();
    await appendResearchProfile({ DB: new FakeD1(db) } as any, { companyId: "acme", runId: null, companyProfileJson: null, strategyJson: null, solutions: [], now: NOW });
    expect(rows(db, "SELECT research_run_id FROM research_profiles")[0].research_run_id).toBeNull();
  });
});

describe("linkResearchFactsToContacts", () => {
  it("links this run's email fact to the contact with the same email (case/trim-insensitive)", async () => {
    const db = makeDb();
    const contactId = insertContact(db, "acme", 1, "anna@acme.example", null);
    insertFact(db, "acme", "run-1", "email", "  ANNA@acme.example ", 1, null);
    await linkResearchFactsToContacts({ DB: new FakeD1(db) } as any, { companyId: "acme", runId: "run-1" });
    const all = rows(db, "SELECT contact_id FROM research_facts");
    expect(all[0].contact_id).toBe(contactId);
  });

  it("links phone facts ignoring separators (space, hyphen, parens, dot)", async () => {
    const db = makeDb();
    const contactId = insertContact(db, "acme", 1, null, "+49 89 123-456");
    insertFact(db, "acme", "run-1", "phone", "+49-89.123 456", 1, null);
    await linkResearchFactsToContacts({ DB: new FakeD1(db) } as any, { companyId: "acme", runId: "run-1" });
    const all = rows(db, "SELECT contact_id FROM research_facts");
    expect(all[0].contact_id).toBe(contactId);
  });

  it("links only THIS run's facts — another run's identical value stays untouched", async () => {
    const db = makeDb();
    const contactId = insertContact(db, "acme", 1, "anna@acme.example", null);
    insertFact(db, "acme", "run-1", "email", "anna@acme.example", 1, null);
    insertFact(db, "acme", "run-0", "email", "anna@acme.example", 1, null);
    await linkResearchFactsToContacts({ DB: new FakeD1(db) } as any, { companyId: "acme", runId: "run-1" });
    const all = rows(db, "SELECT research_run_id, contact_id FROM research_facts ORDER BY id");
    expect(all[0].contact_id).toBe(contactId);
    expect(all[1].contact_id).toBeNull();
  });

  it("never overwrites an existing link (contact_id IS NULL guard)", async () => {
    const db = makeDb();
    insertContact(db, "acme", 1, "anna@acme.example", null);
    insertFact(db, "acme", "run-1", "email", "anna@acme.example", 1, "MANUAL-001");
    await linkResearchFactsToContacts({ DB: new FakeD1(db) } as any, { companyId: "acme", runId: "run-1" });
    expect(rows(db, "SELECT contact_id FROM research_facts")[0].contact_id).toBe("MANUAL-001");
  });

  it("skips superseded facts and non-matching values", async () => {
    const db = makeDb();
    insertContact(db, "acme", 1, "anna@acme.example", null);
    insertFact(db, "acme", "run-1", "email", "anna@acme.example", 0, null);
    insertFact(db, "acme", "run-1", "email", "nomatch@acme.example", 1, null);
    insertFact(db, "acme", "run-1", "social", "https://facebook.com/acme", 1, null);
    await linkResearchFactsToContacts({ DB: new FakeD1(db) } as any, { companyId: "acme", runId: "run-1" });
    const all = rows(db, "SELECT fact_value, contact_id FROM research_facts ORDER BY id");
    expect(all.map((r) => r.contact_id)).toEqual([null, null, null]);
  });

  it("is company-scoped — another company's contact never swallows the fact", async () => {
    const db = makeDb();
    const otherContactId = insertContact(db, "other", 1, "anna@acme.example", null);
    insertFact(db, "acme", "run-1", "email", "anna@acme.example", 1, null);
    await linkResearchFactsToContacts({ DB: new FakeD1(db) } as any, { companyId: "acme", runId: "run-1" });
    const all = rows(db, "SELECT contact_id FROM research_facts");
    expect(all[0].contact_id).toBeNull();
    expect(rows(db, "SELECT contact_id FROM contacts")[0].contact_id).toBe(otherContactId);
  });

  it("a null run id is a no-op — an unscoped UPDATE would reach other runs' rows", async () => {
    const db = makeDb();
    insertContact(db, "acme", 1, "anna@acme.example", null);
    insertFact(db, "acme", null, "email", "anna@acme.example", 1, null);
    await linkResearchFactsToContacts({ DB: new FakeD1(db) } as any, { companyId: "acme", runId: null });
    expect(rows(db, "SELECT contact_id FROM research_facts")[0].contact_id).toBeNull();
  });

  it("fail-open: a missing contacts table never throws", async () => {
    const bare = new DatabaseSync(":memory:");
    bare.exec("CREATE TABLE research_facts (id INTEGER PRIMARY KEY, research_run_id TEXT, customer_id TEXT, fact_type TEXT, fact_value TEXT, contact_id TEXT, source_type TEXT, occurrence_count INTEGER, confidence REAL, parser_version TEXT, fetched_at TEXT, is_current INTEGER, valid_from TEXT, valid_until TEXT)");
    insertFact(bare, "acme", "run-1", "email", "anna@acme.example", 1, null);
    await expect(
      linkResearchFactsToContacts({ DB: new FakeD1(bare) } as any, { companyId: "acme", runId: "run-1" }),
    ).resolves.toBeUndefined();
  });
});

describe("pruneSupersededResearchProfiles", () => {
  it("cuts superseded rows past the horizon, never the current row", async () => {
    const db = makeDb();
    const day = 86_400_000;
    insertProfile(db, "c1", 0, toSqlUtc(new Date(NOW.getTime() - 35 * day)));
    insertProfile(db, "c1", 0, toSqlUtc(new Date(NOW.getTime() - 10 * day)));
    insertProfile(db, "c1", 1, null);
    expect(await pruneSupersededResearchProfiles({ DB: new FakeD1(db) }, 30, NOW)).toBe(1);
    const all = rows(db, "SELECT is_current, valid_until FROM research_profiles ORDER BY id");
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.is_current)).toEqual([0, 1]);
  });

  it("missing table is a silent no-op", async () => {
    const bare = new DatabaseSync(":memory:");
    expect(await pruneSupersededResearchProfiles({ DB: new FakeD1(bare as any) }, 30, NOW)).toBe(0);
  });
});

describe("admin detail API — linked facts (Stage 42 reader)", () => {
  const TOKEN = "profiles-master-token";

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

  it("serves linked facts with the contact's name, excluding unlinked and superseded rows", async () => {
    const db = makeDb();
    const id = seed(db);
    const contactId = insertContact(db, "acme", 1, "anna@acme.example", null);
    insertFact(db, "acme", "run-1", "email", "anna@acme.example", 1, contactId);
    insertFact(db, "acme", "run-1", "email", "unlinked@acme.example", 1, null);
    insertFact(db, "acme", "run-0", "phone", "+49 89 123-456", 0, contactId);
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    const res = await handleAdminRequest(detailReq(id), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { linked_facts: Array<{ fact_type: string; fact_value: string; first_name: string | null; last_name: string | null; title: string | null }> };
    expect(body.linked_facts).toHaveLength(1);
    expect(body.linked_facts[0]).toMatchObject({
      fact_type: "email",
      fact_value: "anna@acme.example",
      first_name: "Anna",
      last_name: "Meier",
      title: "Purchasing Manager",
    });
  });

  it("missing table fails open to an empty list, never a broken detail view", async () => {
    const db = makeDb();
    const id = seed(db);
    db.exec("DROP TABLE research_facts");
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    const res = await handleAdminRequest(detailReq(id), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { linked_facts: unknown[] };
    expect(body.linked_facts).toEqual([]);
  });
});
