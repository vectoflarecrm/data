import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";

/* Phase 9 Stage 54 — GET /admin/api/persona-roles (Stage 51 leftover): the
 * panel's persona_roles AND role_priority inputs match stored persona_role
 * values exactly, so their shared datalist must offer exactly what exists.
 * Pinned at the HTTP surface, like the Stage 51 wiring tests:
 *   - distinct roles across CURRENT research runs only, counted per
 *     distinct customer, ordered by usefulness (count desc, then role);
 *   - NULL / empty-string roles never leak into the datalist;
 *   - fail-open on a migration-pending database: an empty list, never a
 *     500 on panel load. */

const BASE = "https://worker.example";
const TOKEN = "persona-roles-master-token";

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
    for (const s of await stmts) await s.run();
    return [];
  }
}

function makeDb(withPersonas = true): any {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY, company_id TEXT, display_id TEXT, status TEXT,
      company_name TEXT, country TEXT, email TEXT, customer_segment TEXT, lead_score INTEGER
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, actor_user_id TEXT, actor_role TEXT, action TEXT NOT NULL,
      resource_type TEXT NOT NULL, resource_id TEXT, request_id TEXT,
      metadata_json TEXT, ip_hash TEXT, user_agent_hash TEXT, created_at TEXT NOT NULL
    );
  `);
  if (withPersonas) {
    // Real shape: persona_role is NULLable (research-run trims to null).
    db.exec(`
      CREATE TABLE research_personas (
        id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL,
        persona_role TEXT, is_current INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO customers VALUES
        (1,'comp_a','C1','completed','Alpha','Spain',NULL,'Distributor',90),
        (2,'comp_b','C2','completed','Beta','Spain',NULL,'Dealer',80),
        (3,'comp_c','C3','completed','Gamma','France','c@x.com','Dealer',70),
        (4,'comp_d','C4','completed','Delta','Spain','d@x.com','Dealer',60),
        (5,'comp_e','C5','completed','Epsilon','Spain','e@x.com','Dealer',50);
      INSERT INTO research_personas (customer_id, persona_role, is_current) VALUES
        ('comp_a','采购总监',1),
        ('comp_b','采购总监',1),
        ('comp_b','门店老板',1),
        ('comp_a','销售经理',1),
        ('comp_c','门店老板',0),
        ('comp_d',NULL,1),
        ('comp_e','',1);
    `);
  }
  return db;
}

function makeEnv(db: any): AdminEnv {
  return { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
}

function call(env: AdminEnv, path: string): Promise<Response> {
  return handleAdminRequest(new Request(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  }), env) as Promise<Response>;
}

describe("GET /admin/api/persona-roles (Stage 54)", () => {
  it("lists distinct current roles with per-role customer counts, ordered by usefulness", async () => {
    const env = makeEnv(makeDb());
    const res = await call(env, "/admin/api/persona-roles");
    expect(res.status).toBe(200);
    const d = await res.json() as { roles: Array<{ persona_role: string; n: number }> };
    // 采购总监 on 2 customers leads; the two 1-customer roles tie on count and
    // fall back to role order. Superseded (is_current=0), NULL and '' rows
    // never surface.
    expect(d.roles).toEqual([
      { persona_role: "采购总监", n: 2 },
      { persona_role: "销售经理", n: 1 },
      { persona_role: "门店老板", n: 1 },
    ]);
  });

  it("fails open with an empty list when research_personas is missing (migration pending)", async () => {
    const env = makeEnv(makeDb(false));
    const res = await call(env, "/admin/api/persona-roles");
    expect(res.status).toBe(200);
    const d = await res.json() as { roles: unknown[] };
    expect(d.roles).toEqual([]);
  });
});
