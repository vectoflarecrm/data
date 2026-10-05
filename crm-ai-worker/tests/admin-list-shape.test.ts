import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { handleAdminRequest } from "../src/admin";
import type { AdminEnv } from "../src/admin";

/* Phase 3b Stage 39 — read-path slimming.
 *
 * Contract (docs/phase3b-normalization-review.md §5, operator-signed):
 *  - list and pre-filter sample responses exclude the deprecated blob and
 *    the ten columns no code path has ever written;
 *  - the detail response keeps the full shape (the modal renders every
 *    field and the blob is the Stage 38 fallback source);
 *  - the live fields the panel actually renders stay in every response.
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

const TOKEN = "list-shape-master-token";

function makeEnv(): { env: AdminEnv; db: any } {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  db.prepare(
    `INSERT INTO customers (company_id, display_id, domain, status, company_name, country,
       email, customer_segment, lead_score, full_research_text)
     VALUES ('acme', 'ACME-001', 'acme.example', 'completed', 'Acme', 'Spain',
       'info@acme.example', 'Distributor', 75, '=== 主网站内容 ===\nlegacy blob')`,
  ).run();
  return { env: { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv, db };
}

function get(path: string, env: AdminEnv): Request {
  return new Request(`https://worker.example${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

const DROPPED = [
  "full_research_text", "first_name", "last_name", "full_name", "title",
  "department", "linkedin_url", "tel", "whatsapp", "social_accounts",
] as const;

const KEPT = ["id", "company_id", "display_id", "domain", "status", "company_name",
  "country", "email", "cellphone", "customer_segment", "lead_score", "remarks"] as const;

describe("admin list API — slim response (Stage 39)", () => {
  it("list items exclude the blob and dead columns, keep live fields", async () => {
    const { env } = makeEnv();
    const res = await handleAdminRequest(get("/admin/api/customers?limit=10", env), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items.length).toBe(1);
    const item = body.items[0];
    for (const key of DROPPED) expect(item[key]).toBeUndefined();
    for (const key of KEPT) expect(item[key]).toBeDefined();
  });

  it("pre-filter sample excludes the blob and dead columns", async () => {
    const { env } = makeEnv();
    const res = await handleAdminRequest(get("/admin/api/customers/pre-filter", env), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matching: number; sample: Array<Record<string, unknown>> };
    expect(body.matching).toBe(1);
    expect(body.sample.length).toBe(1);
    const sample = body.sample[0];
    for (const key of DROPPED) expect(sample[key]).toBeUndefined();
    for (const key of KEPT) expect(sample[key]).toBeDefined();
  });

  it("detail response keeps the full shape (dead fields present, blob fallback intact)", async () => {
    const { env, db } = makeEnv();
    const id = (db.prepare("SELECT id FROM customers").get() as { id: number }).id;
    const res = await handleAdminRequest(get(`/admin/api/customers/${id}`, env), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Detail is the modal contract: every column stays, including the
    // deprecated ones (rendered, never editable) and the blob fallback.
    for (const key of DROPPED) expect(key in body).toBe(true);
    expect(body.full_research_text).toBe("=== 主网站内容 ===\nlegacy blob");
    for (const key of KEPT) expect(body[key]).toBeDefined();
  });
});
