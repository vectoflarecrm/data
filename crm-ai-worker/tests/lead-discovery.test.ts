import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { handleAdminApi, type AdminAuthContext, type AdminEnv } from "../src/admin";
import {
  buildDiscoveryQueries,
  cleanTitleName,
  extractCandidate,
  runDueDiscoveryRule,
} from "../src/lead-discovery";
import type { GoogleSearchResult } from "../src/web-search";

/* 更新.txt ① 自动寻找新客户（migration 0039）：发现规则 CRUD / 立即运行 /
 * 去重入队 / 运行日志 / cron 到期调度。搜索舰队用 DDG fetch stub 固定行为；
 * Tavily/Exa/Searlo 无 key 时天然短路（多引擎链直接落到 DDG）。 */

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

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY, company_id TEXT NOT NULL UNIQUE, display_id TEXT,
      domain TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      company_name TEXT, normalized_domain TEXT, country TEXT,
      products_services TEXT, lead_score INTEGER, discovery_rule_id TEXT,
      source_import_id TEXT, remarks TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE lead_discovery_rules (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, keywords TEXT NOT NULL,
      industry TEXT, country TEXT,
      max_results INTEGER NOT NULL DEFAULT 20,
      interval_hours INTEGER NOT NULL DEFAULT 168,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE lead_discovery_log (
      id TEXT PRIMARY KEY, rule_id TEXT NOT NULL,
      run_at TEXT NOT NULL DEFAULT (datetime('now')),
      query TEXT NOT NULL, company_name TEXT NOT NULL, domain TEXT,
      source_url TEXT, snippet TEXT,
      outcome TEXT NOT NULL DEFAULT 'inserted' CHECK (outcome IN ('inserted', 'duplicate', 'skipped')),
      customer_id INTEGER
    );
    CREATE TABLE crm_companies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT UNIQUE, industry TEXT,
      country TEXT, tier TEXT DEFAULT 'unqualified', lead_status TEXT DEFAULT 'new',
      merged_from_ids TEXT, chinese_remarks TEXT, customer_since TEXT,
      do_not_contact INTEGER DEFAULT 0,
      domain_email_status TEXT NOT NULL DEFAULT 'pending',
      source TEXT NOT NULL DEFAULT 'unknown',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, actor_user_id TEXT, actor_role TEXT,
      action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT,
      request_id TEXT, metadata_json TEXT, ip_hash TEXT, user_agent_hash TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function makeEnv() {
  const db = makeDb();
  return { db, env: { DB: new FakeD1(db) } as unknown as AdminEnv };
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`https://worker.example.com${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
  });
}

async function call(env: AdminEnv, method: string, path: string, body?: unknown) {
  const res = await handleAdminApi(req(method, path, body), env, AUTH);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** DDG stub: every discovery query answers with the same fixed result page. */
const DDG_RESULTS: Array<[string, string]> = [
  ["Aqua Marine GmbH - Home", "https://www.aquamarine.example/en"],
  ["Nordic SUP AB | LinkedIn", "https://www.linkedin.com/company/nordic-sup"],
  ["Best Paddle Board Deals — Amazon", "https://www.amazon.example/sup"],
  ["OceanPro Distributors", "https://oceanpro.example/"],
];
function stubDdg() {
  const html =
    DDG_RESULTS.map(
      ([title, url], i) =>
        `<a class="result__a" href="${url}">${title}</a><a class="result__snippet">Result ${i} snippet</a>`,
    ).join("\n");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("html.duckduckgo.com")) {
        return new Response(html, { status: 200 });
      }
      return new Response("", { status: 200 });
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ── 查询生成 / 标题清洗 / 候选提取（纯函数） ─────────────────────────── */

describe("① 查询生成", () => {
  it("拼接行业/国家，生成 3 组角色查询", () => {
    const queries = buildDiscoveryQueries({ keywords: "inflatable boat", industry: "water sports", country: "Germany" });
    expect(queries).toEqual([
      "inflatable boat water sports distributor Germany",
      "inflatable boat water sports importer wholesaler Germany",
      "inflatable boat water sports retailer reseller Germany",
    ]);
  });

  it("缺省行业/国家时只用关键词；全空时无查询", () => {
    const queries = buildDiscoveryQueries({ keywords: "sup", industry: null, country: null });
    expect(queries).toEqual(["sup distributor", "sup importer wholesaler", "sup retailer reseller"]);
    expect(buildDiscoveryQueries({ keywords: "  ", industry: null, country: null })).toEqual([]);
  });
});

describe("① 标题清洗", () => {
  it("去掉 - Home / | LinkedIn / Welcome to 前缀等装饰", () => {
    expect(cleanTitleName("Aqua Marine GmbH - Home")).toBe("Aqua Marine GmbH");
    expect(cleanTitleName("Nordic SUP AB | LinkedIn")).toBe("Nordic SUP AB");
    expect(cleanTitleName("Welcome to Baltic Boats")).toBe("Baltic Boats");
    expect(cleanTitleName("Home Page | Aqua Ltd")).toBe("Home Page");
  });

  it("榜单/URL/空标题返回 null", () => {
    expect(cleanTitleName("Top 10 SUP Distributors in Europe")).toBeNull();
    expect(cleanTitleName("https://example.com/en")).toBeNull();
    expect(cleanTitleName("Best 5 Companies Directory")).toBeNull();
    expect(cleanTitleName("")).toBeNull();
  });
});

describe("① 候选提取", () => {
  const q = "inflatable boat distributor Germany";
  const mk = (title: string, link: string): GoogleSearchResult => ({ title, link, snippet: "s" });

  it("自家域名：去 www.，名称取标题首段", () => {
    const c = extractCandidate(mk("Aqua Marine GmbH - Home", "https://www.aquamarine.example/en"), q);
    expect(c).toMatchObject({ name: "Aqua Marine GmbH", domain: "aquamarine.example" });
  });

  it("噪声域名（marketplace/directory）直接跳过", () => {
    expect(extractCandidate(mk("SUP Shop", "https://www.amazon.example/sup"), q)).toBeNull();
    expect(extractCandidate(mk("Kompass listing", "https://www.kompass.example/a"), q)).toBeNull();
  });

  it("免费博客平台与搜索引擎域名跳过", () => {
    expect(extractCandidate(mk("Some Blog", "https://blog.example.blogspot.com/"), q)).toBeNull();
    expect(extractCandidate(mk("Some Blog", "https://me.wordpress.com/"), q)).toBeNull();
    expect(extractCandidate(mk("results", "https://www.google.example/search?q=x"), q)).toBeNull();
  });

  it("社交平台：保留公司名、domain 置空", () => {
    const c = extractCandidate(mk("Nordic SUP AB | LinkedIn", "https://www.linkedin.com/company/nordic-sup"), q);
    expect(c).toMatchObject({ name: "Nordic SUP AB", domain: null });
  });

  it("DDG 跳转链接解包到真实 URL", () => {
    const wrapped = "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.aquamarine.example%2Fen&rut=abc";
    const c = extractCandidate(mk("Aqua Marine GmbH", wrapped), q);
    expect(c).toMatchObject({ domain: "aquamarine.example", sourceUrl: "https://www.aquamarine.example/en" });
  });

  it("标题不可用时回退用域名做公司名", () => {
    const c = extractCandidate(mk("Top 10 Lists", "https://www.oceanpro.example/"), q);
    expect(c).toMatchObject({ name: "oceanpro.example", domain: "oceanpro.example" });
  });
});

/* ── HTTP 层：规则 CRUD + 立即运行 + 去重 + 日志 ──────────────────────── */

describe("① 发现规则 API", () => {
  it("创建校验：缺关键词 400；合法输入 201 并出现在列表里", async () => {
    const { env, db } = makeEnv();
    const bad = await call(env, "POST", "/admin/api/discovery/rules", { name: "规则" });
    expect(bad.status).toBe(400);
    expect(bad.body.detail).toContain("关键词");

    const badLimit = await call(env, "POST", "/admin/api/discovery/rules", { name: "r", keywords: "sup", max_results: 99 });
    expect(badLimit.status).toBe(400);

    const ok = await call(env, "POST", "/admin/api/discovery/rules", {
      name: "欧洲桨板经销商", keywords: "inflatable boat SUP", industry: "water sports", country: "Germany",
    });
    expect(ok.status).toBe(201);
    expect(ok.body.rule).toMatchObject({ name: "欧洲桨板经销商", keywords: "inflatable boat SUP", max_results: 20, interval_hours: 168, enabled: 1 });
    const ruleId = ok.body.rule.id as string;

    const list = await call(env, "GET", "/admin/api/discovery/rules");
    expect(list.status).toBe(200);
    expect(list.body.rules).toHaveLength(1);
    expect(list.body.rules[0]).toMatchObject({ id: ruleId, inserted_count: 0, duplicate_count: 0 });

    // 创建动作写审计
    const audits = db.prepare("SELECT action, resource_id FROM audit_logs WHERE action = 'CREATE_DISCOVERY_RULE'").all() as any[];
    expect(audits).toHaveLength(1);
    expect(audits[0].resource_id).toBe(ruleId);
  });

  it("PATCH 启停 / DELETE 删除 / 不存在 404", async () => {
    const { env } = makeEnv();
    const created = await call(env, "POST", "/admin/api/discovery/rules", { name: "r", keywords: "sup" });
    const id = created.body.rule.id as string;

    const patched = await call(env, "PATCH", `/admin/api/discovery/rules/${id}`, { name: "r2", keywords: "sup", enabled: 0, interval_hours: 24 });
    expect(patched.status).toBe(200);
    expect(patched.body.rule).toMatchObject({ name: "r2", enabled: 0, interval_hours: 24 });

    const missing = await call(env, "PATCH", "/admin/api/discovery/rules/none", { name: "x", keywords: "y" });
    expect(missing.status).toBe(404);
    const missingRun = await call(env, "POST", "/admin/api/discovery/rules/none/run");
    expect(missingRun.status).toBe(404);

    const del = await call(env, "DELETE", `/admin/api/discovery/rules/${id}`);
    expect(del.status).toBe(200);
    expect((await call(env, "GET", "/admin/api/discovery/rules")).body.rules).toHaveLength(0);
  });

  it("立即运行：DDG 命中 → 噪声过滤 → 入库 pending（带规则溯源）→ 日志留痕", async () => {
    const { env, db } = makeEnv();
    stubDdg();
    const created = await call(env, "POST", "/admin/api/discovery/rules", {
      name: "欧洲", keywords: "inflatable boat", country: "Germany", max_results: 10,
    });
    const id = created.body.rule.id as string;

    const run = await call(env, "POST", `/admin/api/discovery/rules/${id}/run`);
    expect(run.status).toBe(200);
    // 4 条 DDG 结果：amazon 噪声被过滤，3 条入库（2 域名 + 1 LinkedIn 无域名）
    expect(run.body.report).toMatchObject({ inserted: 3, duplicates: 0 });
    expect(run.body.report.queries).toHaveLength(3);

    const rows = db.prepare("SELECT company_name, domain, normalized_domain, status, discovery_rule_id, country, products_services FROM customers ORDER BY id").all() as any[];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.company_name).sort()).toEqual(["Aqua Marine GmbH", "Nordic SUP AB", "OceanPro Distributors"].sort());
    for (const r of rows) {
      expect(r.status).toBe("pending");
      expect(r.discovery_rule_id).toBe(id);
      expect(r.country).toBe("Germany");
      expect(r.products_services).toBe("inflatable boat");
    }
    const aqua = rows.find((r) => r.company_name === "Aqua Marine GmbH");
    expect(aqua.normalized_domain).toBe("aquamarine.example");
    const nordic = rows.find((r) => r.company_name === "Nordic SUP AB");
    expect(nordic.domain).toBe("");

    // 日志：3 条 inserted，携带 customer_id 与来源 URL
    const logs = db.prepare("SELECT outcome, customer_id, source_url, query FROM lead_discovery_log WHERE rule_id = ?").all(id) as any[];
    expect(logs).toHaveLength(3);
    expect(logs.every((l) => l.outcome === "inserted" && l.customer_id && l.source_url && l.query.includes("inflatable boat"))).toBe(true);

    // last_run_at 已盖章
    const rule = db.prepare("SELECT last_run_at FROM lead_discovery_rules WHERE id = ?").get(id) as any;
    expect(rule.last_run_at).toBeTruthy();
  });

  it("重复运行命中去重（customers 域名/名称、crm_companies），重复项只记日志不入库", async () => {
    const { env, db } = makeEnv();
    stubDdg();
    const created = await call(env, "POST", "/admin/api/discovery/rules", { name: "欧洲", keywords: "inflatable boat", max_results: 10 });
    const id = created.body.rule.id as string;

    const first = await call(env, "POST", `/admin/api/discovery/rules/${id}/run`);
    expect(first.body.report.inserted).toBe(3);

    // 再放一家已在 CRM 的公司：domain 命中 crm_companies
    db.prepare("INSERT INTO crm_companies (id, name, domain) VALUES ('crm_1', 'CRM Corp', 'oceanpro.example')").run();

    const second = await call(env, "POST", `/admin/api/discovery/rules/${id}/run`);
    expect(second.status).toBe(200);
    expect(second.body.report).toMatchObject({ inserted: 0, duplicates: 3 });

    // customers 不新增；日志新增 3 条 duplicate
    expect((db.prepare("SELECT COUNT(*) AS n FROM customers").get() as any).n).toBe(3);
    const dupLogs = db.prepare("SELECT COUNT(*) AS n FROM lead_discovery_log WHERE rule_id = ? AND outcome = 'duplicate'").get(id) as any;
    expect(dupLogs.n).toBe(3);
  });

  it("运行日志接口：join customers 状态与评分，limit 生效", async () => {
    const { env, db } = makeEnv();
    stubDdg();
    const created = await call(env, "POST", "/admin/api/discovery/rules", { name: "欧洲", keywords: "inflatable boat", max_results: 10 });
    const id = created.body.rule.id as string;
    await call(env, "POST", `/admin/api/discovery/rules/${id}/run`);

    // 手工把一家研究完成并打分，验证 join
    db.prepare("UPDATE customers SET status = 'completed', lead_score = 77 WHERE company_name = 'Aqua Marine GmbH'").run();

    const log = await call(env, "GET", `/admin/api/discovery/rules/${id}/log?limit=100`);
    expect(log.status).toBe(200);
    expect(log.body.entries).toHaveLength(3);
    const aquaEntry = log.body.entries.find((e: any) => e.company_name === "Aqua Marine GmbH");
    expect(aquaEntry).toBeTruthy();
    expect(aquaEntry.customer_status).toBe("completed");
    expect(aquaEntry.customer_lead_score).toBe(77);
    // limit 生效
    expect((await call(env, "GET", `/admin/api/discovery/rules/${id}/log?limit=1`)).body.entries).toHaveLength(1);
  });
});

/* ── cron 调度：到期规则每次空闲 tick 只跑一条 ───────────────────────── */

describe("① cron 到期调度", () => {
  it("从未运行过的启用规则会被执行；最近刚跑过的（未到间隔）跳过", async () => {
    const { env, db } = makeEnv();
    stubDdg();
    db.prepare(
      "INSERT INTO lead_discovery_rules (id, name, keywords) VALUES ('fresh', '新规则', 'inflatable boat')",
    ).run();
    db.prepare(
      "INSERT INTO lead_discovery_rules (id, name, keywords, last_run_at) VALUES ('recent', '刚跑过', 'paddle', datetime('now', '-1 hour'))",
    ).run();

    const report = await runDueDiscoveryRule(env as any);
    expect(report).toMatchObject({ rule_id: "fresh", inserted: 3 });

    // fresh 已盖章；下一 tick 无到期规则（fresh 间隔 168h，recent 未到）→ null
    expect((db.prepare("SELECT last_run_at FROM lead_discovery_rules WHERE id = 'fresh'").get() as any).last_run_at).toBeTruthy();
    const second = await runDueDiscoveryRule(env as any);
    expect(second).toBeNull();
  });

  it("停用规则不参与调度；表缺失时 fail-open 返回 null", async () => {
    const { env, db } = makeEnv();
    stubDdg();
    db.prepare(
      "INSERT INTO lead_discovery_rules (id, name, keywords, enabled) VALUES ('off', '停用', 'sup', 0)",
    ).run();
    expect(await runDueDiscoveryRule(env as any)).toBeNull();

    const bare = new DatabaseSync(":memory:");
    expect(await runDueDiscoveryRule({ DB: new FakeD1(bare) } as any)).toBeNull();
  });
});
