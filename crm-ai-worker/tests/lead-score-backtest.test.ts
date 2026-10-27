import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { handleAdminApi, type AdminAuthContext, type AdminEnv } from "../src/admin";
import { getLeadScoreBacktest } from "../src/lead-score-backtest";

/* 更新.txt 四.4 / 模块 D「评分模型的历史效果校准」（0041）：
 * GET /admin/api/lead-score/backtest 用真实结果（触达/回复/意向/商机/成交）
 * 回测 lead_score 区分度。最小 schema 只建回测查询涉及的五张表。 */

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
      id INTEGER PRIMARY KEY, company_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'completed',
      lead_score INTEGER, lead_score_breakdown TEXT
    );
    CREATE TABLE outreach_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER, status TEXT DEFAULT 'draft'
    );
    CREATE TABLE crm_activities (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, type TEXT,
      summary TEXT NOT NULL
    );
    CREATE TABLE crm_deals (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, stage TEXT DEFAULT 'inquiry'
    );
  `);
  return db;
}

function makeEnv() {
  const db = makeDb();
  return { db, env: { DB: new FakeD1(db) } as unknown as AdminEnv };
}

/** 种子：一家已完成评分客户。返回 customers.id。 */
function seedCustomer(
  db: any,
  score: number,
  breakdown: Record<string, number> | null,
): number {
  const info = db
    .prepare("INSERT INTO customers (company_id, status, lead_score, lead_score_breakdown) VALUES (?, 'completed', ?, ?)")
    .run(`co_${Math.random().toString(36).slice(2)}`, score, breakdown ? JSON.stringify(breakdown) : null);
  return Number(info.lastInsertRowid);
}

const BREAKDOWN = (icp: number, reach: number): Record<string, number> => ({
  version: "lead-score-v2",
  icp_fit: icp,
  product_fit: 10,
  buyer_role: 10,
  buying_signal: 5,
  reachability: reach,
  strategic_value: 5,
});

describe("④ 评分回测：分段漏斗", () => {
  it("各分段计数正确：触达/回复（排除退信与自动回复）/意向/商机/成交", async () => {
    const { env, db } = makeEnv();
    // 高分客户：已触达 + 人工回复（无前缀）+ 意向 + 成交。
    // company_id 在 JS 里拼接（生产 promoteLead 同款）——node:sqlite 数字
    // 绑定会让 SQL 里 'c_' || ? 变成 'c_1.0'，join 失配。
    const a = seedCustomer(db, 85, BREAKDOWN(25, 15));
    const ca = "c_" + a;
    db.prepare("INSERT INTO outreach_emails (customer_id, status) VALUES (?, 'sent')").run(a);
    db.prepare("INSERT INTO crm_activities VALUES ('a1', ?, 'email_received', '收到来信: 你好')").run(ca);
    db.prepare("INSERT INTO crm_activities VALUES ('a2', ?, 'email_received', '【疑似意向】收到来信: 报价')").run(ca);
    db.prepare("INSERT INTO crm_activities VALUES ('a3', ?, 'email_received', '【自动回复】收到来信: 不在办公室')").run(ca);
    db.prepare("INSERT INTO crm_deals VALUES ('d1', ?, 'won')").run(ca);
    // 中分客户：已触达但只有退信（不算人工回复）
    const b = seedCustomer(db, 65, BREAKDOWN(20, 15));
    const cb = "c_" + b;
    db.prepare("INSERT INTO outreach_emails (customer_id, status) VALUES (?, 'sent')").run(b);
    db.prepare("INSERT INTO crm_activities VALUES ('a4', ?, 'email_received', '【退信】发送至 x 的邮件被退回')").run(cb);
    // 低分客户：未触达，无任何事件
    seedCustomer(db, 30, null);

    const report = await getLeadScoreBacktest(env);
    expect(report.total_scored).toBe(3);
    const high = report.tiers.find((t) => t.tier.startsWith("≥80"));
    const mid = report.tiers.find((t) => t.tier.startsWith("60-79"));
    const low = report.tiers.find((t) => t.tier.startsWith("<40"));
    expect(high).toMatchObject({ scored: 1, contacted: 1, replied: 1, interested: 1, deals: 1, won: 1 });
    // 退信与自动回复不计人工回复
    expect(mid).toMatchObject({ scored: 1, contacted: 1, replied: 0, interested: 0, deals: 0, won: 0 });
    expect(low).toMatchObject({ scored: 1, contacted: 0, replied: 0, deals: 0, won: 0 });
  });

  it("pending/未评分客户不参与回测", async () => {
    const { env, db } = makeEnv();
    seedCustomer(db, 90, BREAKDOWN(25, 15));
    db.prepare("INSERT INTO customers (company_id, status, lead_score) VALUES ('p1', 'pending', 88)").run();
    db.prepare("INSERT INTO customers (company_id, status) VALUES ('p2', 'completed')").run();
    const report = await getLeadScoreBacktest(env);
    expect(report.total_scored).toBe(1);
  });
});

describe("④ 评分回测：结论与维度相关性", () => {
  it("样本不足（<30）时只给提示，不给区分度结论", async () => {
    const { env, db } = makeEnv();
    for (let i = 0; i < 5; i++) seedCustomer(db, 50 + i, BREAKDOWN(20, 15));
    const report = await getLeadScoreBacktest(env);
    expect(report.total_scored).toBe(5);
    expect(report.verdict).toContain("样本不足");
    expect(report.advice).toHaveLength(0);
  });

  it("样本充足 + 有成交时：结论含统计，维度均值区分成交/回复/未回复", async () => {
    const { env, db } = makeEnv();
    // 20 家高分成交（icp 25）+ 20 家低分未触达（icp 5）→ 40 家 ≥ 门槛
    for (let i = 0; i < 20; i++) {
      const id = seedCustomer(db, 85, BREAKDOWN(25, 15));
      const cid = "c_" + id;
      db.prepare("INSERT INTO outreach_emails (customer_id, status) VALUES (?, 'sent')").run(id);
      db.prepare("INSERT INTO crm_activities VALUES (?, ?, 'email_received', '收到来信: ok')").run(`m${i}`, cid);
      db.prepare("INSERT INTO crm_deals VALUES (?, ?, 'won')").run(`w${i}`, cid);
    }
    for (let i = 0; i < 20; i++) seedCustomer(db, 10, BREAKDOWN(5, 5));

    const report = await getLeadScoreBacktest(env);
    expect(report.total_scored).toBe(40);
    expect(report.verdict).toContain("成交 20");
    expect(report.verdict).not.toContain("样本不足");
    // 建议：高分成交率高于低分 → 方向有效
    expect(report.advice.some((a) => a.includes("有效") || a.includes("倍"))).toBe(true);
    const icp = report.dimensions.find((d) => d.dim === "icp_fit");
    expect(icp).toMatchObject({ label: "ICP 匹配", avg_all: 15, avg_won: 25, avg_replied: 25, avg_not_replied: 5 });
    // 每条建议末尾带口径说明
    expect(report.advice[report.advice.length - 1]).toContain("口径");
  });

  it("有回复但无商机/成交时也能出结论（回复率口径）", async () => {
    const { env, db } = makeEnv();
    for (let i = 0; i < 30; i++) {
      const id = seedCustomer(db, i < 15 ? 90 : 20, BREAKDOWN(20, 15));
      db.prepare("INSERT INTO outreach_emails (customer_id, status) VALUES (?, 'sent')").run(id);
      if (i < 15) db.prepare("INSERT INTO crm_activities VALUES (?, ?, 'email_received', '收到来信: hi')").run(`r${i}`, "c_" + id);
    }
    const report = await getLeadScoreBacktest(env);
    expect(report.verdict).toContain("回复 15");
    expect(report.verdict).toContain("商机 0");
  });
});

describe("④ 评分回测：HTTP 路由", () => {
  it("GET /admin/api/lead-score/backtest 返回 report（customers.read 门禁在 rbac 段）", async () => {
    const { env, db } = makeEnv();
    seedCustomer(db, 72, BREAKDOWN(20, 15));
    const res = await handleAdminApi(
      new Request("https://worker.example.com/admin/api/lead-score/backtest"),
      env,
      AUTH,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.report.total_scored).toBe(1);
    expect(body.report.tiers).toHaveLength(4);
    expect(body.report.dimensions).toHaveLength(6);
    expect(body.report.verdict).toContain("样本不足");
  });
});
