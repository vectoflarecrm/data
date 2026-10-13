import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { handleAdminRequest } from "../src/admin";
import type { AdminEnv } from "../src/admin";

/* 海选过滤器「导出全部数据」（action=export）：与 count 共用同一套
 * segmentClause WHERE——筛选语义必须一致，只是出口从 JSON 换成带 BOM
 * 的 CSV（Excel 直开中文）。列集是固定白名单：列表列 +
 * data_completeness_score + lead_score_breakdown；死列（从未写入的人
 * 名块、social_accounts）与研究原文 blob 一律不出。 */

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

const TOKEN = "prefilter-export-master-token";

function makeEnv(): { env: AdminEnv; db: any } {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  db.prepare(
    `INSERT INTO customers (company_id, display_id, domain, status, company_name, country,
       email, customer_segment, lead_score, remarks, data_completeness_score, full_research_text)
     VALUES ('acme', 'ACME-001', 'acme.example', 'completed', 'Acme', 'Spain',
       'info@acme.example', 'Distributor', 75, '含,逗号 "引号"', 88, '=== 原文 blob ==='),
       ('beta', 'BETA-002', 'beta.example', 'completed', 'Beta', 'Spain',
       'hi@beta.example', 'Retailer', 90, '', 92, 'blob'),
       ('gamma', 'GAMMA-003', 'gamma.example', 'completed', 'Gamma', 'Italy',
       NULL, 'Retailer', 60, '', 70, 'blob')`,
  ).run();
  return { env: { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv, db };
}

function get(path: string, env: AdminEnv): Request {
  return new Request(`https://worker.example${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
}

/* The BOM must live in the response BYTES (that's what a browser saves to
 * disk and what makes Excel detect UTF-8). res.text() is useless for the
 * check — TextDecoder strips a leading U+FEFF at decode time — so assert on
 * the raw buffer, then decode (BOM auto-removed) for the text assertions. */
async function csvOf(res: Response): Promise<string[]> {
  const buf = await res.arrayBuffer();
  expect(Array.from(new Uint8Array(buf.slice(0, 3)))).toEqual([0xef, 0xbb, 0xbf]);
  return new TextDecoder().decode(buf).split("\r\n");
}

describe("pre-filter export (action=export)", () => {
  it("returns BOM-prefixed CSV with the allowlisted columns, ordered by lead_score DESC", async () => {
    const { env } = makeEnv();
    const res = await handleAdminRequest(get("/admin/api/customers/pre-filter?action=export&countries=Spain", env), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const lines = await csvOf(res);
    expect(lines.length).toBe(3); // header + 2 Spain rows
    const header = lines[0].split(",");
    for (const c of [
      "id", "company_id", "display_id", "domain", "status", "company_name",
      "country", "email", "cellphone", "customer_segment", "lead_score",
      "remarks", "social_accounts_verified", "buying_signals",
      "data_completeness_score", "lead_score_breakdown", "updated_at",
    ]) {
      expect(header).toContain(c);
    }
    for (const dead of [
      "full_research_text", "social_accounts", "first_name", "last_name",
      "full_name", "title", "department", "linkedin_url", "tel", "whatsapp",
    ]) {
      expect(header).not.toContain(dead);
    }
    // lead_score DESC: Beta (90) before Acme (75).
    const betaIdx = lines.findIndex((l) => l.includes("BETA-002"));
    const acmeIdx = lines.findIndex((l) => l.includes("ACME-001"));
    expect(betaIdx).toBe(1);
    expect(acmeIdx).toBe(2);
  });

  it("escapes commas and quotes the way CSV readers expect", async () => {
    const { env } = makeEnv();
    const res = await handleAdminRequest(get("/admin/api/customers/pre-filter?action=export&countries=Spain", env), env);
    const acme = (await csvOf(res)).find((l) => l.includes("ACME-001"));
    expect(acme).toBeDefined();
    expect(acme).toContain('"含,逗号 ""引号"""');
  });

  it("honors has_email and min_lead_score exactly like the count action", async () => {
    const { env } = makeEnv();
    const res = await handleAdminRequest(
      get("/admin/api/customers/pre-filter?action=export&has_email=1&min_lead_score=80", env),
      env,
    );
    const lines = await csvOf(res);
    expect(lines.length).toBe(2); // header + Beta only
    expect(lines[1]).toContain("BETA-002");
  });

  it("caps the export at 5000 rows and appends a truncation note", async () => {
    const { env, db } = makeEnv();
    db.exec(
      `INSERT INTO customers (company_id, display_id, domain, status, country, email, lead_score)
       WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 5001)
       SELECT 'bulk' || i, 'B-' || i, 'bulk' || i || '.example', 'completed', 'Spain',
         'b' || i || '@bulk.example', 60 FROM seq`,
    );
    const res = await handleAdminRequest(
      get("/admin/api/customers/pre-filter?action=export&countries=Spain&min_lead_score=59", env),
      env,
    );
    const lines = await csvOf(res);
    // header + 5000 data rows + 1 truncation note
    expect(lines.length).toBe(5002);
    expect(lines[lines.length - 1]).toContain("截断");
    expect(lines[lines.length - 1]).toContain("5000");
    // Filename carries the exported row count.
    expect(res.headers.get("content-disposition")).toContain("5000rows.csv");
  });
});
