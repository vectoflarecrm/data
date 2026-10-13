import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { handleAdminRequest } from "../src/admin";
import type { AdminEnv } from "../src/admin";

/* 海选「重新入队」（action=queue）现在必须作废旧研究：processCustomer 的
 * canReuseResearch 会把 research_sources 里 is_current=1 的旧抓取原样
 * 重建后重跑 AI——不先作废，重跑等于用同一份（可能已串入别家公司数据
 * 的）输入再算一遍。预期：匹配集的 research_sources 置 is_current=0 并
 * 打上 valid_until、customers.full_research_text 兜底清空，历史行与非
 * 匹配客户原样保留；两条 UPDATE 同一 batch 原子生效。 */

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
    const out: any[] = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

const TOKEN = "prefilter-queue-master-token";

function makeEnv(): { env: AdminEnv; db: any } {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  db.prepare(
    `INSERT INTO customers (company_id, display_id, domain, status, company_name, country,
       email, customer_segment, lead_score, full_research_text)
     VALUES ('acme', 'ACME-001', 'acme.example', 'completed', 'Acme', 'Spain',
       'info@acme.example', 'Distributor', 75, 'blob-acme'),
       ('beta', 'BETA-002', 'beta.example', 'completed', 'Beta', 'Spain',
       'hi@beta.example', 'Retailer', 90, 'blob-beta'),
       ('gamma', 'GAMMA-003', 'gamma.example', 'completed', 'Gamma', 'Italy',
       NULL, 'Retailer', 60, 'blob-gamma')`,
  ).run();
  // acme：一条当前研究 + 一条早已作废的历史行（valid_until 不得被改动）。
  // gamma：非匹配客户的当前研究必须原样保留。
  db.prepare(
    `INSERT INTO research_sources
       (research_run_id, customer_id, source_type, source_url, raw_text,
        content_hash, parser_version, fetched_at, is_current, valid_from, valid_until)
     VALUES ('r1', 'acme', 'website', 'https://acme.example', 'old crawl',
       'h1', 'v1', '2026-01-01 00:00:00', 1, '2026-01-01 00:00:00', NULL),
       ('r0', 'acme', 'website', 'https://acme.example', 'ancient crawl',
       'h0', 'v0', '2025-01-01 00:00:00', 0, '2025-01-01 00:00:00', '2025-06-01 00:00:00'),
       ('r2', 'gamma', 'website', 'https://gamma.example', 'gamma crawl',
       'h2', 'v1', '2026-01-02 00:00:00', 1, '2026-01-02 00:00:00', NULL)`,
  ).run();
  return { env: { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv, db };
}

function get(path: string, env: AdminEnv): Request {
  return new Request(`https://worker.example${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

describe("pre-filter queue (action=queue) invalidates old research", () => {
  it("supersedes research_sources and clears the blob cache for the matched set only", async () => {
    const { env, db } = makeEnv();
    const res = await handleAdminRequest(get("/admin/api/customers/pre-filter?action=queue&countries=Spain", env), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { action: string; queued: number };
    expect(body.action).toBe("queue");
    expect(body.queued).toBe(2); // acme + beta

    // 匹配集：重新入队 + 兜底 blob 清空。
    const rows = db.prepare(
      `SELECT company_id, status, full_research_text FROM customers ORDER BY company_id`,
    ).all() as Array<{ company_id: string; status: string; full_research_text: string | null }>;
    const byId = new Map(rows.map((r) => [r.company_id, r]));
    expect(byId.get("acme")?.status).toBe("pending");
    expect(byId.get("acme")?.full_research_text).toBeNull();
    expect(byId.get("beta")?.status).toBe("pending");
    expect(byId.get("beta")?.full_research_text).toBeNull();
    // 非匹配客户原样保留。
    expect(byId.get("gamma")?.status).toBe("completed");
    expect(byId.get("gamma")?.full_research_text).toBe("blob-gamma");

    // acme 的当前研究被作废（is_current=0 且打上 valid_until），历史行的
    // valid_until 保持原值；gamma 的当前研究不受影响。
    const sources = db.prepare(
      `SELECT research_run_id, is_current, valid_until FROM research_sources ORDER BY research_run_id`,
    ).all() as Array<{ research_run_id: string; is_current: number; valid_until: string | null }>;
    const byRun = new Map(sources.map((s) => [s.research_run_id, s]));
    const superseded = byRun.get("r1");
    expect(superseded?.is_current).toBe(0);
    expect(superseded?.valid_until).toBeTruthy();
    expect(byRun.get("r0")?.valid_until).toBe("2025-06-01 00:00:00");
    expect(byRun.get("r2")?.is_current).toBe(1);
    expect(byRun.get("r2")?.valid_until).toBeNull();
  });

  it("leaves retries' research reuse intact when queueing an empty match set", async () => {
    const { env, db } = makeEnv();
    const res = await handleAdminRequest(get("/admin/api/customers/pre-filter?action=queue&countries=Portugal", env), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { queued: number };
    expect(body.queued).toBe(0);
    // Nothing matched: every customer and every source row is untouched.
    const statuses = db.prepare(`SELECT DISTINCT status FROM customers`).all() as Array<{ status: string }>;
    expect(statuses.map((s) => s.status)).toEqual(["completed"]);
    const current = db.prepare(`SELECT COUNT(*) AS n FROM research_sources WHERE is_current = 1`).get() as { n: number };
    expect(current.n).toBe(2);
  });
});
