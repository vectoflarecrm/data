import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { buildSavedResearchText, readSavedResearchText } from "../src/research-run";
import type { SavedSourceRow } from "../src/research-run";
import { handleAdminRequest } from "../src/admin";
import type { AdminEnv } from "../src/admin";

/* Phase 3 Stage 38 — blob deprecation cutover.
 *
 * Contract (docs/phase3-research-engine.md §Stage 38):
 *  - buildSavedResearchText rebuilds the EXACT legacy blob format from a
 *    current source set: cleanResearchContextForAi splits on `=== ... ===`
 *    headers, so a reconstruction that dropped or renamed them would break
 *    reuse silently;
 *  - readSavedResearchText is sources-first with the blob as fallback, and
 *    fail-open end to end (missing table / read error → blob, never a
 *    crash, never paid re-research);
 *  - the admin detail endpoint shows the sources reconstruction, falling
 *    back to the blob for pre-Stage-36 snapshots.
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

function insertCustomer(db: any, companyId: string, blob: string | null): number {
  const info = db.prepare(
    "INSERT INTO customers (company_id, display_id, domain, status, full_research_text) VALUES (?, ?, ?, 'pending', ?)",
  ).run(companyId, companyId.toUpperCase(), `${companyId}.example`, blob);
  return Number(info.lastInsertRowid);
}

function insertSource(db: any, companyId: string, type: string, raw: string): void {
  db.prepare(
    `INSERT INTO research_sources
       (research_run_id, customer_id, source_type, source_url, raw_text,
        content_hash, parser_version, fetched_at, is_current, valid_from)
     VALUES (NULL, ?, ?, NULL, ?, 'h', 'sources-v1', '2026-01-01 00:00:00', 1, '2026-01-01 00:00:00')`,
  ).run(companyId, type, raw);
}

const src = (source_type: string, raw_text: string | null): SavedSourceRow =>
  ({ source_type, raw_text });

describe("buildSavedResearchText", () => {
  it("rebuilds the exact legacy blob from a full four-segment set", () => {
    const rows = [
      src("website", "ACME home page text."),
      src("social", "LinkedIn: https://linkedin.com/company/acme (已验证)"),
      src("search", "\n\n--- 搜索结果页面 (1条) ---\n=== 搜索结果: Acme ===\nresult snippet"),
      src("additional", "\n\n--- 额外信息来源 ---\n=== /about 页面内容 ===\nabout text"),
    ];
    expect(buildSavedResearchText(rows)).toBe(
      "=== 主网站内容 ===\nACME home page text."
      + "\n\n=== 已验证社交媒体 ===\nLinkedIn: https://linkedin.com/company/acme (已验证)"
      + "\n\n--- 搜索结果页面 (1条) ---\n=== 搜索结果: Acme ===\nresult snippet"
      + "\n\n--- 额外信息来源 ---\n=== /about 页面内容 ===\nabout text",
    );
  });

  it("collapses an unreachable crawl to the legacy marker", () => {
    const rows = [src("website", ""), src("search", "\n\n--- 搜索结果页面 (2条) ---\nsnippet")];
    expect(buildSavedResearchText(rows)).toBe(
      "=== 主网站无法访问 ==="
      + "\n\n--- 搜索结果页面 (2条) ---\nsnippet",
    );
  });

  it("omits the social header when the segment is empty", () => {
    const rows = [src("website", "text"), src("social", "")];
    expect(buildSavedResearchText(rows)).toBe("=== 主网站内容 ===\ntext");
  });

  it("returns a single backfill snapshot verbatim (legacy blob stored whole)", () => {
    const legacy = "=== 主网站内容 ===\nold blob body";
    expect(buildSavedResearchText([src("backfill", legacy)])).toBe(legacy);
  });

  it("returns empty for no rows (caller falls back to the blob)", () => {
    expect(buildSavedResearchText([])).toBe("");
  });
});

describe("readSavedResearchText", () => {
  it("reads the current source set first", async () => {
    const db = makeDb();
    insertCustomer(db, "acme", "stale blob");
    insertSource(db, "acme", "website", "fresh page text");
    insertSource(db, "acme", "social", "Instagram: https://instagram.com/acme (未验证)");
    const text = await readSavedResearchText({ DB: new FakeD1(db) } as any, "acme", "stale blob");
    expect(text).toBe(
      "=== 主网站内容 ===\nfresh page text"
      + "\n\n=== 已验证社交媒体 ===\nInstagram: https://instagram.com/acme (未验证)",
    );
  });

  it("falls back to the blob when no current source rows exist", async () => {
    const db = makeDb();
    insertCustomer(db, "acme", "legacy blob body");
    const text = await readSavedResearchText({ DB: new FakeD1(db) } as any, "acme", "legacy blob body");
    expect(text).toBe("legacy blob body");
  });

  it("falls back to the blob when the table is missing (fail-open)", async () => {
    const db = makeDb();
    db.exec("DROP TABLE research_sources");
    const text = await readSavedResearchText({ DB: new FakeD1(db) } as any, "acme", "legacy blob body");
    expect(text).toBe("legacy blob body");
  });
});

describe("admin detail API — sources-first research view (Stage 38)", () => {
  const TOKEN = "research-text-master-token";

  function detailReq(id: number): Request {
    return new Request(`https://worker.example/admin/api/customers/${id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
  }

  it("serves the sources reconstruction over the stale blob", async () => {
    const db = makeDb();
    const id = insertCustomer(db, "acme", "old blob from a previous run");
    insertSource(db, "acme", "website", "fresh crawl text");
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    const res = await handleAdminRequest(detailReq(id), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.full_research_text).toBe("=== 主网站内容 ===\nfresh crawl text");
  });

  it("keeps serving the blob for pre-Stage-36 snapshots", async () => {
    const db = makeDb();
    const id = insertCustomer(db, "acme", "=== 主网站内容 ===\nlegacy snapshot");
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    const res = await handleAdminRequest(detailReq(id), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.full_research_text).toBe("=== 主网站内容 ===\nlegacy snapshot");
  });
});
