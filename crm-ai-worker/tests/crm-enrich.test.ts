/* crm-enrich（0043 自动资料补全）单元 + 集成测试。
 *
 * 覆盖：纯函数（stripHtml / parseEnrichFields / pickFillableFields /
 * missingFields）、入队幂等、tick 端到端（官网抓取 + DDG + Workers AI 全
 * mock）：只填空字段、时间线备注、资料齐全跳过、AI 失败重试与终态、
 * 无 AI 绑定不处理、抓取全空终态。 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AdminAuthContext, AdminEnv } from "../src/admin";
import {
  ENRICH_FIELDS,
  enqueueForEnrichment,
  missingFields,
  parseEnrichFields,
  pickFillableFields,
  runCrmEnrichTick,
  stripHtml,
  type EnrichEnv,
} from "../src/crm-enrich";

const FIELD_COLUMNS = ENRICH_FIELDS.map(([f]) => f).join(", ");

class FakeD1 {
  constructor(private db: any) {}

  prepare(sql: string) {
    const db = this.db;
    let bound: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...bound) as T[], success: true };
      },
      async first<T>() {
        return (db.prepare(sql).get(...bound) ?? undefined) as T | undefined;
      },
      async run() {
        const info = db.prepare(sql).run(...bound);
        return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
      },
    };
  }

  async batch(stmts: any[]) {
    for (const s of stmts) await s.run();
    return [];
  }
}

const AUTH: AdminAuthContext = {
  user: { id: "u1", username: "operator", role: "operator", enabled: 1 },
  sessionId: "",
  tokenHash: null,
  via: "session",
  expiresAt: null,
};
void AUTH;

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE crm_companies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT,
      ${ENRICH_FIELDS.map(([f]) => `${f} TEXT`).join(", ")}
    );
    CREATE TABLE crm_activities (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
      type TEXT DEFAULT 'manual_note', summary TEXT NOT NULL,
      due_date TEXT, is_completed INTEGER DEFAULT 0, owner TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE crm_enrich_queue (
      company_id TEXT PRIMARY KEY REFERENCES crm_companies(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      enqueued_at TEXT NOT NULL,
      finished_at TEXT,
      filled_fields TEXT,
      note TEXT,
      run_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function makeEnv(db = makeDb(), ai?: { run: ReturnType<typeof vi.fn> }): EnrichEnv {
  const env: EnrichEnv = { DB: new FakeD1(db) } as unknown as AdminEnv;
  if (ai) (env as { AI?: unknown }).AI = ai;
  return env;
}

/** fetch 桩：按 URL 路由 —— DDG 搜索页 / 官网页。 */
function stubFetch(
  pages: Array<{ match: string; body: string; status?: number }>,
) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    for (const page of pages) {
      if (url.includes(page.match)) {
        return new Response(page.body, { status: page.status ?? 200 });
      }
    }
    return new Response("", { status: 404 });
  });
}

function ddgHtml(results: Array<{ title: string; snippet?: string }>): string {
  let html = "";
  for (const r of results) {
    html += `<a class="result__a" href="https://example.com/x">${r.title}</a><a class="result__snippet">${r.snippet ?? ""}</a>`;
  }
  return html;
}

function aiOk(payload: Record<string, unknown>) {
  return { run: vi.fn(async () => ({ response: JSON.stringify(payload) })) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ── 纯函数 ─────────────────────────────────────────────────────────────── */

describe("stripHtml", () => {
  it("去 script/style/标签/实体，压缩空白", () => {
    const html = `<html><head><script>alert(1)</script><style>.a{}</style></head>
      <body><h1>Acme&nbsp;Marine</h1><p>SUP &amp; kayaks &lt;since 1999&gt;</p></body></html>`;
    expect(stripHtml(html)).toBe("Acme Marine SUP & kayaks <since 1999>");
  });
});

describe("parseEnrichFields", () => {
  it("容忍代码围栏与前后杂文，只保留已知字段并按列宽截断", () => {
    const long = "x".repeat(3000);
    const out = parseEnrichFields(
      `好的，以下是结果：\n\`\`\`json\n{"industry":"Marine retail","products_services":"${long}","country":"Puerto Rico","evil_key":"hack","city":null}\n\`\`\`\n以上。`,
    );
    expect(out).not.toBeNull();
    expect(out!.industry).toBe("Marine retail");
    expect(out!.country).toBe("Puerto Rico");
    expect(out!.products_services).toHaveLength(2000); // 列宽截断
    expect(Object.keys(out!)).not.toContain("evil_key");
    expect(Object.keys(out!)).not.toContain("city"); // null 值跳过
  });

  it("N/A 与空串跳过；完全解析不出 JSON → null", () => {
    expect(parseEnrichFields('{"industry":"N/A","city":"  "}')).toEqual({});
    expect(parseEnrichFields("the company sells boats")).toBeNull();
    expect(parseEnrichFields('{"industry": 42}')).toEqual({}); // 非字符串跳过
  });
});

describe("pickFillableFields / missingFields", () => {
  it("只挑「当前为空 + 提取到值」的字段", () => {
    const current = { industry: "Retail", country: "", city: null, region: undefined };
    const extracted = { industry: "Ignored", country: "USA", city: "", region: "West" };
    expect(pickFillableFields(current, extracted)).toEqual(["country", "region"]);
    expect(missingFields(current)).toEqual(["products_services", "country", "city", "region", "employee_range", "description"]);
  });
});

/* ── 入队 ───────────────────────────────────────────────────────────────── */

describe("enqueueForEnrichment", () => {
  it("只入队存在的公司；重复入队幂等返回 0；未知 id 忽略", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO crm_companies (id, name) VALUES ('c1', 'Acme'), ('c2', 'Beta')").run();
    const env = makeEnv(db);
    expect(await enqueueForEnrichment(env, ["c1", "c2", "ghost"])).toBe(2);
    expect(await enqueueForEnrichment(env, ["c1", "c2"])).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM crm_enrich_queue").get() as any).n).toBe(2);
    expect((db.prepare("SELECT status FROM crm_enrich_queue WHERE company_id='c1'").get() as any).status).toBe("pending");
  });

  it("表缺失（0043 未应用）→ fail-open 返回 0", async () => {
    const db = makeDb();
    db.exec("DROP TABLE crm_enrich_queue");
    db.prepare("INSERT INTO crm_companies (id, name) VALUES ('c1', 'Acme')").run();
    const env = makeEnv(db);
    expect(await enqueueForEnrichment(env, ["c1"])).toBe(0);
  });
});

/* ── Tick ───────────────────────────────────────────────────────────────── */

describe("runCrmEnrichTick", () => {
  it("端到端：官网+DDG+AI 提取 → 只填空字段 + 时间线备注 + 队列 done", async () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO crm_companies (id, name, domain, industry, country) VALUES ('c1', 'Acme Marine', 'acme.example.com', 'Retail', NULL)",
    ).run();
    await enqueueForEnrichment(makeEnv(db), ["c1"]);
    const fetchMock = stubFetch([
      { match: "html.duckduckgo.com", body: ddgHtml([{ title: "Acme Marine - Home", snippet: "SUP and kayak rentals in San Juan" }]) },
      { match: "acme.example.com", body: "<html><body><p>Acme Marine sells paddle boards and kayaks in San Juan, Puerto Rico. 20 employees.</p></body></html>" },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const ai = aiOk({
      industry: "Watersports retail",
      country: "Puerto Rico",
      city: "San Juan",
      employee_range: "11-50",
      products_services: "Paddle boards; Kayaks",
      description: "Watersports retailer in San Juan.",
    });
    const env = makeEnv(db, ai);
    const report = await runCrmEnrichTick(env);
    expect(report).toEqual({ processed: 1, filled: 1, failed: 0 });
    const co = db.prepare("SELECT * FROM crm_companies WHERE id='c1'").get() as any;
    expect(co.industry).toBe("Retail"); // 已有值不动
    expect(co.country).toBe("Puerto Rico");
    expect(co.city).toBe("San Juan");
    expect(co.employee_range).toBe("11-50");
    const q = db.prepare("SELECT * FROM crm_enrich_queue WHERE company_id='c1'").get() as any;
    expect(q.status).toBe("done");
    expect(q.filled_fields).toBe("products_services,country,city,employee_range,description");
    const note = db.prepare("SELECT summary FROM crm_activities WHERE company_id='c1'").get() as any;
    expect(note.summary).toContain("自动资料补全");
    expect(note.summary).toContain("5 项");
  });

  it("资料已齐全 → 不发任何网络请求，直接 done", async () => {
    const db = makeDb();
    const full: Record<string, string> = {};
    for (const [f] of ENRICH_FIELDS) full[f] = "已有值";
    db.prepare(
      `INSERT INTO crm_companies (id, name, domain, ${FIELD_COLUMNS}) VALUES ('c1', 'Acme', 'acme.example.com', ${ENRICH_FIELDS.map(() => "?").join(", ")})`,
    ).run(...Object.values(full));
    await enqueueForEnrichment(makeEnv(db), ["c1"]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const env = makeEnv(db, aiOk({}));
    const report = await runCrmEnrichTick(env);
    expect(report.processed).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    const q = db.prepare("SELECT * FROM crm_enrich_queue WHERE company_id='c1'").get() as any;
    expect(q.status).toBe("done");
    expect(q.note).toContain("资料已齐全");
  });

  it("官网不可达且搜索无结果 → done 终态 + 时间线说明", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO crm_companies (id, name, domain) VALUES ('c1', 'Acme', 'acme.example.com')").run();
    await enqueueForEnrichment(makeEnv(db), ["c1"]);
    vi.stubGlobal("fetch", stubFetch([]));
    const env = makeEnv(db, aiOk({}));
    const report = await runCrmEnrichTick(env);
    expect(report.filled).toBe(1);
    const q = db.prepare("SELECT * FROM crm_enrich_queue WHERE company_id='c1'").get() as any;
    expect(q.status).toBe("done");
    expect(q.note).toContain("无可提取资料");
    const note = db.prepare("SELECT summary FROM crm_activities WHERE company_id='c1'").get() as any;
    expect(note.summary).toContain("未回填");
  });

  it("无 AI 绑定 → 不处理，保留 pending", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO crm_companies (id, name) VALUES ('c1', 'Acme')").run();
    await enqueueForEnrichment(makeEnv(db), ["c1"]);
    const report = await runCrmEnrichTick(makeEnv(db));
    expect(report.processed).toBe(0);
    const q = db.prepare("SELECT status FROM crm_enrich_queue WHERE company_id='c1'").get() as any;
    expect(q.status).toBe("pending");
  });

  it("AI 失败 → 前两次保留 pending 重试，第 3 次置 failed 终态", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO crm_companies (id, name, domain) VALUES ('c1', 'Acme', 'acme.example.com')").run();
    await enqueueForEnrichment(makeEnv(db), ["c1"]);
    vi.stubGlobal("fetch", stubFetch([
      { match: "html.duckduckgo.com", body: ddgHtml([{ title: "Acme Marine", snippet: "SUP" }]) },
      { match: "acme.example.com", body: "<p>Acme Marine</p>" },
    ]));
    const ai = { run: vi.fn(async () => { throw new Error("boom"); }) };
    const env = makeEnv(db, ai);
    await runCrmEnrichTick(env);
    let q = db.prepare("SELECT * FROM crm_enrich_queue WHERE company_id='c1'").get() as any;
    expect(q.status).toBe("pending");
    expect(q.run_count).toBe(1);
    expect(q.note).toContain("boom");
    await runCrmEnrichTick(env);
    q = db.prepare("SELECT * FROM crm_enrich_queue WHERE company_id='c1'").get() as any;
    expect(q.status).toBe("pending");
    expect(q.run_count).toBe(2);
    await runCrmEnrichTick(env);
    q = db.prepare("SELECT * FROM crm_enrich_queue WHERE company_id='c1'").get() as any;
    expect(q.status).toBe("failed");
    expect(q.run_count).toBe(2); // finishQueueRow 不动 run_count
    expect(q.note).toContain("boom");
  });

  it("AI 输出不可解析 → 按失败重试计数", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO crm_companies (id, name, domain) VALUES ('c1', 'Acme', 'acme.example.com')").run();
    await enqueueForEnrichment(makeEnv(db), ["c1"]);
    vi.stubGlobal("fetch", stubFetch([
      { match: "html.duckduckgo.com", body: ddgHtml([{ title: "Acme Marine", snippet: "SUP" }]) },
      { match: "acme.example.com", body: "<p>Acme Marine</p>" },
    ]));
    const ai = { run: vi.fn(async () => ({ response: "I cannot answer in JSON, sorry." })) };
    const env = makeEnv(db, ai);
    const report = await runCrmEnrichTick(env);
    expect(report.filled).toBe(0);
    const q = db.prepare("SELECT * FROM crm_enrich_queue WHERE company_id='c1'").get() as any;
    expect(q.status).toBe("pending");
    expect(q.run_count).toBe(1);
    expect(q.note).toContain("无法解析");
  });

  it("每 tick 只处理 2 家（限流子请求）", async () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) {
      db.prepare("INSERT INTO crm_companies (id, name) VALUES (?, ?)").run(`c${i}`, `Co ${i}`);
    }
    await enqueueForEnrichment(makeEnv(db), ["c0", "c1", "c2", "c3", "c4"]);
    vi.stubGlobal("fetch", stubFetch([]));
    const env = makeEnv(db, aiOk({}));
    const report = await runCrmEnrichTick(env);
    expect(report.processed).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM crm_enrich_queue WHERE status='done'").get() as any).n).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM crm_enrich_queue WHERE status='pending'").get() as any).n).toBe(3);
  });
});
