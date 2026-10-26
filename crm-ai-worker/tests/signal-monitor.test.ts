import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AdminEnv } from "../src/admin";
import {
  buildSignalQuery,
  checkCompanySignals,
  companyNameAnchor,
  listSignalOverview,
  matchSignalHit,
  runSignalMonitorTick,
  signalTypeLabel,
  updateSignalWatch,
} from "../src/signal-monitor";

/* ⑥ 持续采购意向监测（更新.txt 第 6 项，0037）：查询构造与信号判定纯函数、
 * DDG 全 mock 的单公司检查（信号落库/来源去重/时间线+待办/C 级上调 B）、
 * tick（重要客户自动入表、冷却跳过、fail-open）、监测配置与总览。 */

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

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE crm_companies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT, industry TEXT,
      country TEXT, tier TEXT DEFAULT 'unqualified', lead_status TEXT DEFAULT 'new',
      do_not_contact INTEGER DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE crm_contacts (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, full_name TEXT NOT NULL,
      job_title TEXT, procurement_role TEXT NOT NULL DEFAULT 'unknown'
    );
    CREATE TABLE crm_deals (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, title TEXT NOT NULL,
      stage TEXT DEFAULT 'inquiry', archived_at TEXT
    );
    CREATE TABLE crm_activities (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, type TEXT DEFAULT 'manual_note',
      summary TEXT NOT NULL, due_date TEXT, is_completed INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE crm_signal_watch (
      company_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
      interval_days INTEGER NOT NULL DEFAULT 14, last_checked_at TEXT, last_error TEXT
    );
    CREATE TABLE crm_signal_checks (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, signal_type TEXT NOT NULL,
      signal_text TEXT NOT NULL, source_url TEXT, detected_at TEXT NOT NULL,
      expires_at TEXT, created_at TEXT NOT NULL,
      UNIQUE(company_id, signal_type, source_url)
    );
  `);
  return db;
}

function seedCompany(db: any, id: string, tier = "C"): void {
  db.prepare("INSERT INTO crm_companies (id, name, domain, tier) VALUES (?, 'Acme Marine', ?, ?)")
    .run(id, `${id}.example.com`, tier);
}

/* DDG stub：按查询子串路由返回固定 HTML 结果。 */
function stubDdg(pages: Array<{ match: string; results: Array<{ title: string; url: string; snippet?: string }> }>) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    const q = decodeURIComponent(url.split("q=")[1] ?? "").toLowerCase();
    for (const page of pages) {
      if (q.includes(page.match.toLowerCase())) {
        let html = "";
        for (const r of page.results) {
          html += `<a class="result__a" href="${r.url}">${r.title}</a><a class="result__snippet">${r.snippet ?? ""}</a>`;
        }
        return new Response(html, { status: 200 });
      }
    }
    return new Response("", { status: 200 });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ── 纯函数 ──────────────────────────────────────────────────────────────── */

describe("信号查询与判定纯函数", () => {
  const company = { id: "c1", name: "Acme Paddle Co", domain: "acme.com", tier: "C" };

  it("companyNameAnchor 去除公司后缀噪音", () => {
    expect(companyNameAnchor("Acme Paddle Co")).toBe("acme paddle");
    expect(companyNameAnchor("The Acme Ltd.")).toBe("the acme");
  });

  it("buildSignalQuery 包含公司锚点与类型关键词", () => {
    const q = buildSignalQuery(company, "distributor");
    expect(q).toContain("Acme Paddle Co");
    expect(q).toContain("acme.com");
    expect(q).toContain("distributor");
  });

  it("matchSignalHit：公司锚点 + 类型关键词同时命中才算信号", () => {
    expect(
      matchSignalHit(
        { title: "Acme Paddle seeks distributors for new line", link: "u1", snippet: "" },
        "Acme Paddle Co",
        "distributor",
      ),
    ).toBe(true);
    // 关键词命中但公司不相关 → 不算。
    expect(
      matchSignalHit(
        { title: "Other Corp seeks distributors", link: "u2", snippet: "" },
        "Acme Paddle Co",
        "distributor",
      ),
    ).toBe(false);
    // 公司命中但无信号关键词 → 不算。
    expect(
      matchSignalHit(
        { title: "Acme Paddle homepage", link: "u3", snippet: "Welcome to Acme Paddle" },
        "Acme Paddle Co",
        "distributor",
      ),
    ).toBe(false);
    // 摘要命中也算（标题无关键词、snippet 有）。
    expect(
      matchSignalHit(
        { title: "Industry news weekly", link: "u4", snippet: "Acme Paddle opens new store in Lisbon" },
        "Acme Paddle Co",
        "expansion",
      ),
    ).toBe(true);
  });

  it("signalTypeLabel 中文标签", () => {
    expect(signalTypeLabel("new_product")).toBe("新品发布");
    expect(signalTypeLabel("procurement")).toBe("采购公告");
  });
});

/* ── 单公司检查 ─────────────────────────────────────────────────────────── */

describe("checkCompanySignals", () => {
  it("命中信号 → 落库 + 时间线 + 待办；二次检查按来源去重", async () => {
    const db = makeDb();
    seedCompany(db, "c1", "C");
    vi.stubGlobal("fetch", stubDdg([
      {
        match: "distributor wanted",
        results: [{ title: "Acme Marine seeks distributors for paddle boards", url: "https://news.example/acme-dist" }],
      },
    ]));

    const r1 = await checkCompanySignals({ DB: new FakeD1(db) } as unknown as AdminEnv, "c1");
    expect(r1.new_signals).toBe(1);
    expect(r1.queries).toBe(5); // 五类信号各一条查询
    const stored = db.prepare("SELECT * FROM crm_signal_checks WHERE company_id = 'c1'").all() as any[];
    expect(stored).toHaveLength(1);
    expect(stored[0].signal_type).toBe("distributor");
    expect(stored[0].source_url).toBe("https://news.example/acme-dist");
    expect(stored[0].expires_at).toBeTruthy();
    // 时间线备注 + 待办任务
    const acts = db.prepare("SELECT type, summary FROM crm_activities WHERE company_id = 'c1'").all() as any[];
    expect(acts.some((a) => a.type === "note" && a.summary.includes("经销商招募"))).toBe(true);
    expect(acts.some((a) => a.type === "task" && a.summary.includes("经销商招募"))).toBe(true);
    // C 级 + 强信号 → 自动上调 B
    expect(r1.tier_bumped).toBe(true);
    expect(db.prepare("SELECT tier FROM crm_companies WHERE id = 'c1'").get()).toMatchObject({ tier: "B" });
    // watch 行已建立并记录检查时间
    expect(db.prepare("SELECT last_checked_at FROM crm_signal_watch WHERE company_id = 'c1'").get().last_checked_at).toBeTruthy();

    // 二次检查：同来源不再计为新信号
    const r2 = await checkCompanySignals({ DB: new FakeD1(db) } as unknown as AdminEnv, "c1");
    expect(r2.new_signals).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM crm_signal_checks").get()).toMatchObject({ n: 1 });
    // 已上调为 B → 不再重复调整
    expect(r2.tier_bumped).toBe(false);
  });

  it("弱信号（new_product）不触发分级上调", async () => {
    const db = makeDb();
    seedCompany(db, "c1", "C");
    vi.stubGlobal("fetch", stubDdg([
      {
        match: "new product launch",
        results: [{ title: "Acme Marine announces new product line", url: "https://acme.example/new" }],
      },
    ]));
    const r = await checkCompanySignals({ DB: new FakeD1(db) } as unknown as AdminEnv, "c1");
    expect(r.new_signals).toBe(1);
    expect(r.tier_bumped).toBe(false);
    expect(db.prepare("SELECT tier FROM crm_companies WHERE id = 'c1'").get()).toMatchObject({ tier: "C" });
  });

  it("A/VIP 公司即使有强信号也不改分级", async () => {
    const db = makeDb();
    seedCompany(db, "c1", "A");
    vi.stubGlobal("fetch", stubDdg([
      {
        match: "distributor wanted",
        results: [{ title: "Acme Marine seeks distributors", url: "https://news.example/a" }],
      },
    ]));
    const r = await checkCompanySignals({ DB: new FakeD1(db) } as unknown as AdminEnv, "c1");
    expect(r.new_signals).toBe(1);
    expect(r.tier_bumped).toBe(false);
    expect(db.prepare("SELECT tier FROM crm_companies WHERE id = 'c1'").get()).toMatchObject({ tier: "A" });
  });

  it("公司不存在时报错", async () => {
    const db = makeDb();
    await expect(
      checkCompanySignals({ DB: new FakeD1(db) } as unknown as AdminEnv, "missing"),
    ).rejects.toThrow("公司不存在");
  });
});

/* ── Cron tick ──────────────────────────────────────────────────────────── */

describe("runSignalMonitorTick", () => {
  it("重要客户自动入表（A/VIP 或未结商机），普通公司不自动监测", async () => {
    const db = makeDb();
    seedCompany(db, "a1", "A");
    seedCompany(db, "vip1", "VIP");
    seedCompany(db, "plain", "C");
    seedCompany(db, "dealco", "C");
    db.prepare("INSERT INTO crm_deals (id, company_id, title) VALUES ('d1', 'dealco', '询盘')").run();
    vi.stubGlobal("fetch", stubDdg([]));

    const report = await runSignalMonitorTick({ DB: new FakeD1(db) } as unknown as AdminEnv);
    expect(report.checked).toBe(1); // TICK_BUDGET = 1
    const watched = db.prepare("SELECT company_id FROM crm_signal_watch ORDER BY company_id").all() as any[];
    const ids = watched.map((w) => w.company_id);
    expect(ids).toContain("a1");
    expect(ids).toContain("vip1");
    expect(ids).toContain("dealco"); // 有未结商机的 C 级也入表
    expect(ids).not.toContain("plain");
  });

  it("冷却期内（last_checked_at 新于 interval_days）跳过", async () => {
    const db = makeDb();
    seedCompany(db, "a1", "A");
    db.prepare("INSERT INTO crm_signal_watch (company_id, last_checked_at) VALUES ('a1', ?)")
      .run(new Date().toISOString());
    const fetchMock = stubDdg([]);
    vi.stubGlobal("fetch", fetchMock);

    const report = await runSignalMonitorTick({ DB: new FakeD1(db) } as unknown as AdminEnv);
    expect(report.checked).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("已检查过的到期公司会再次检查（冷却到期）", async () => {
    const db = makeDb();
    seedCompany(db, "a1", "A");
    db.prepare("INSERT INTO crm_signal_watch (company_id, last_checked_at) VALUES ('a1', ?)")
      .run(new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString());
    const fetchMock = stubDdg([]);
    vi.stubGlobal("fetch", fetchMock);

    const report = await runSignalMonitorTick({ DB: new FakeD1(db) } as unknown as AdminEnv);
    expect(report.checked).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("停用监测（enabled=0）与禁联公司不检查", async () => {
    const db = makeDb();
    seedCompany(db, "off1", "A");
    seedCompany(db, "dnc1", "A");
    db.prepare("INSERT INTO crm_signal_watch (company_id, enabled) VALUES ('off1', 0)").run();
    db.prepare("UPDATE crm_companies SET do_not_contact = 1 WHERE id = 'dnc1'").run();
    const fetchMock = stubDdg([]);
    vi.stubGlobal("fetch", fetchMock);

    const report = await runSignalMonitorTick({ DB: new FakeD1(db) } as unknown as AdminEnv);
    expect(report.checked).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("表缺失（migration 未应用）→ 零报告 fail-open", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE crm_companies (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
    const report = await runSignalMonitorTick({ DB: new FakeD1(db) } as unknown as AdminEnv);
    expect(report).toMatchObject({ checked: 0, new_signals: 0, errors: 0 });
  });
});

/* ── 配置与总览 ─────────────────────────────────────────────────────────── */

describe("updateSignalWatch / listSignalOverview", () => {
  it("手工为 B/C 级公司开监测 + 自定义周期（1-90 夹取）", async () => {
    const db = makeDb();
    seedCompany(db, "b1", "B");
    const env = { DB: new FakeD1(db) } as unknown as AdminEnv;
    await updateSignalWatch(env, "b1", { enabled: true, interval_days: 7 });
    expect(db.prepare("SELECT enabled, interval_days FROM crm_signal_watch WHERE company_id = 'b1'").get())
      .toMatchObject({ enabled: 1, interval_days: 7 });
    await updateSignalWatch(env, "b1", { interval_days: 300 });
    expect(db.prepare("SELECT interval_days FROM crm_signal_watch WHERE company_id = 'b1'").get())
      .toMatchObject({ interval_days: 90 });
    await updateSignalWatch(env, "b1", { enabled: false });
    expect(db.prepare("SELECT enabled FROM crm_signal_watch WHERE company_id = 'b1'").get())
      .toMatchObject({ enabled: 0 });
  });

  it("公司不存在时报错", async () => {
    const db = makeDb();
    await expect(
      updateSignalWatch({ DB: new FakeD1(db) } as unknown as AdminEnv, "missing", {}),
    ).rejects.toThrow("公司不存在");
  });

  it("listSignalOverview 返回监测列表（含有效信号数）与最近信号", async () => {
    const db = makeDb();
    seedCompany(db, "a1", "A");
    const env = { DB: new FakeD1(db) } as unknown as AdminEnv;
    await updateSignalWatch(env, "a1", { enabled: true });
    db.prepare(
      "INSERT INTO crm_signal_checks (id, company_id, signal_type, signal_text, source_url, detected_at, expires_at, created_at) VALUES ('s1', 'a1', 'expansion', 'Acme opens new facility', 'https://n.example/1', ?, ?, ?)",
    ).run(
      new Date().toISOString(),
      new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      new Date().toISOString(),
    );

    const res = await listSignalOverview(env);
    const body = JSON.parse(await res.text()) as {
      watch: Array<{ company_id: string; company_name: string; active_signals: number }>;
      signals: Array<{ signal_type: string; company_name: string }>;
    };
    expect(body.watch).toHaveLength(1);
    expect(body.watch[0]).toMatchObject({ company_id: "a1", active_signals: 1 });
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0]).toMatchObject({ signal_type: "expansion", company_name: "Acme Marine" });
  });

  it("过期信号（expires_at 早于 now）不计入有效数也不在列表", async () => {
    const db = makeDb();
    seedCompany(db, "a1", "A");
    const env = { DB: new FakeD1(db) } as unknown as AdminEnv;
    await updateSignalWatch(env, "a1", {});
    db.prepare(
      "INSERT INTO crm_signal_checks (id, company_id, signal_type, signal_text, source_url, detected_at, expires_at, created_at) VALUES ('old', 'a1', 'expansion', 'stale', 'https://n.example/old', ?, ?, ?)",
    ).run(
      new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString(),
      new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString(),
      new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString(),
    );

    const res = await listSignalOverview(env);
    const body = JSON.parse(await res.text()) as {
      watch: Array<{ active_signals: number }>;
      signals: unknown[];
    };
    expect(body.watch[0].active_signals).toBe(0);
    expect(body.signals).toHaveLength(0);
  });
});
