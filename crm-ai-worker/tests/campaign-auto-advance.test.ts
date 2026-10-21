import { describe, it, expect } from "vitest";
import type { AdminEnv } from "../src/admin";
import {
  createCampaign,
  getCampaign,
  parseSegmentFilters,
  runCampaignAutoAdvance,
  setCampaignAutoAdvance,
  setCampaignStatus,
} from "../src/campaigns";
import type { CampaignDeps } from "../src/campaigns";

/* 开发信自动推进 (cron auto-advance)：runCampaignAutoAdvance 是 scheduled tick
 * 在调研空闲时调度的第三步。这里关心的性质：
 *   1. 只有 auto_advance = 1 且 status = 'draft' 的任务被推进；
 *   2. 每 tick 只走一小批生成 + 一小批发送，且完全复用手动步骤的语义
 *      （成员状态机、可续跑、配额感知）；
 *   3. 单个任务的失败（锁竞争 / 步骤报错）只影响该任务，不断掉整个 tick。
 *
 * AI 与 Gmail 仍通过 CampaignDeps 注入 — 这里不花 token 不发真邮件。 */

/* ── Minimal D1 shim over node:sqlite（与 campaign-steps.test.ts 相同） ──── */

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
        const stmt = db.prepare(sql);
        const rows = stmt.all(...bound);
        return { results: rows as T[], success: true };
      },
      async first<T>() {
        const stmt = db.prepare(sql);
        const row = stmt.get(...bound);
        return (row ?? undefined) as T | undefined;
      },
      async run() {
        const stmt = db.prepare(sql);
        const info = stmt.run(...bound);
        return {
          success: true,
          meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
        };
      },
    };
  }

  async batch(stmts: any[]) {
    for (const s of stmts) await s.run();
    return [];
  }
}

const BRANDS = [
  { brand_name: "Afarer", product_category: "SUPs", company_intro: "A real company intro.", enabled: 1 },
];

function seedCustomer(id: number, email: string | null, score = 80) {
  return `INSERT INTO customers
    (id, company_id, display_id, domain, status, company_name, country, email,
     customer_segment, product_categories, products_services, lead_score)
    VALUES (${id}, 'c${id}', 'C${id}', 'x${id}.com', 'completed', 'Co ${id}', 'Spain',
            ${email === null ? "NULL" : `'${email}'`}, 'Dealer', 'SUP', NULL, ${score})`;
}

async function makeDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY, company_id TEXT, display_id TEXT, domain TEXT, status TEXT,
      company_name TEXT, country TEXT, email TEXT, customer_segment TEXT,
      product_categories TEXT, products_services TEXT, description TEXT,
      business_tag TEXT, lead_score INTEGER
    );
    CREATE TABLE outreach_settings (brand_name TEXT PRIMARY KEY, product_category TEXT, company_intro TEXT,
      enabled INTEGER, sender_email TEXT, sender_name TEXT, gmail_account TEXT);
    CREATE TABLE outreach_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, company_id TEXT, display_id TEXT,
      company_name TEXT, email_to TEXT, product_category TEXT, brand_name TEXT,
      subject TEXT, body TEXT, status TEXT DEFAULT 'draft', sent_at TEXT, created_at TEXT,
      contact_id INTEGER
    );
    CREATE TABLE outreach_campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, brand_name TEXT,
      group_id INTEGER, filters TEXT, total INTEGER, status TEXT, auto_advance INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE outreach_campaign_members (campaign_id INTEGER, customer_id INTEGER, contact_id INTEGER, status TEXT,
      outreach_email_id INTEGER, error TEXT, PRIMARY KEY (campaign_id, customer_id));
    CREATE TABLE gmail_send_log (id INTEGER PRIMARY KEY AUTOINCREMENT, outreach_email_id INTEGER,
      recipient TEXT, status TEXT, sent_at TEXT);
  `);
  for (const b of BRANDS) {
    db.prepare(
      "INSERT INTO outreach_settings (brand_name, product_category, company_intro, enabled) VALUES (?,?,?,?)",
    ).run(b.brand_name, b.product_category, b.company_intro, b.enabled);
  }
  const fake = new FakeD1(db);
  (fake as any).db = db;
  const env = { DB: fake, GMAIL_SEND_DELAY_MS: "0" } as unknown as AdminEnv;
  return { db, env };
}

/* ── Stub generators / senders ──────────────────────────────────────────── */

type GenerateFn = CampaignDeps["generate"];
type SendFn = CampaignDeps["send"];

function draftWriter(db: any): GenerateFn {
  return async (_env, _brand, ids) => {
    const drafts = ids.map((cid) => {
      const r = db
        .prepare(
          "INSERT INTO outreach_emails (customer_id, brand_name, subject, body, status) VALUES (?,?,?,?,'draft')",
        )
        .run(cid, "Afarer", "S" + cid, "B" + cid);
      return { customer_id: cid, email_id: Number(r.lastInsertRowid) };
    });
    return { generated: drafts.length, already: [], drafts, errors: [] };
  };
}

function quotaStub(dailyLimit = 400) {
  const state = { sent: 0, limit: dailyLimit };
  const read = async () => ({
    sent_today: state.sent,
    daily_limit: state.limit,
    remaining: Math.max(0, state.limit - state.sent),
  });
  return Object.assign(read, { state });
}

const sendOK = (quota: ReturnType<typeof quotaStub>): SendFn => async () => {
  quota.state.sent++;
  return { ok: true };
};

async function makeCampaign(env: AdminEnv, customerId: number) {
  return createCampaign(env, {
    brandName: "Afarer",
    filters: parseSegmentFilters({}),
  }).then(async (created) => {
    // 用指定客户替换快照：比逐个 seed 一堆客户再筛更直接。
    await ((env.DB as any).db as any).exec(`DELETE FROM outreach_campaign_members WHERE campaign_id = ${created.id}`);
    await ((env.DB as any).db as any).exec(
      `INSERT INTO outreach_campaign_members (campaign_id, customer_id, status) VALUES (${created.id}, ${customerId}, 'pending')`,
    );
    return created;
  });
}

/* ── Tests ──────────────────────────────────────────────────────────────── */

describe("setCampaignAutoAdvance (开关)", () => {
  it("toggles the flag and it is visible through getCampaign", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "a@x.com"));
    const created = await makeCampaign(env, 1);
    expect((await getCampaign(env, created.id))!.auto_advance).toBe(0);

    await setCampaignAutoAdvance(env, created.id, true);
    expect((await getCampaign(env, created.id))!.auto_advance).toBe(1);

    await setCampaignAutoAdvance(env, created.id, false);
    expect((await getCampaign(env, created.id))!.auto_advance).toBe(0);
  });
});

describe("runCampaignAutoAdvance (cron 自动推进)", () => {
  it("generates and then sends a batch for opted-in running campaigns", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "a@x.com"));
    const created = await makeCampaign(env, 1);
    await setCampaignAutoAdvance(env, created.id, true);

    const quota = quotaStub();
    const deps = { generate: draftWriter(db), send: sendOK(quota), quota };
    const report = await runCampaignAutoAdvance(env, { deps });

    expect(report.advanced).toEqual([{ campaign: created.id, generated: 1, sent: 1 }]);
    expect(report.skipped).toEqual([]);
    const progress = await getCampaign(env, created.id);
    expect(progress?.sent).toBe(1);
    expect(progress?.remaining).toBe(0);
  });

  it("ignores campaigns that are paused, done or not opted in", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "a@x.com"));
    db.exec(seedCustomer(2, "b@x.com"));
    db.exec(seedCustomer(3, "c@x.com"));

    const off = await makeCampaign(env, 1); // 未开启自动推进
    const paused = await makeCampaign(env, 2);
    await setCampaignAutoAdvance(env, paused.id, true);
    await setCampaignStatus(env, paused.id, "paused");
    const finished = await makeCampaign(env, 3);
    await setCampaignAutoAdvance(env, finished.id, true);
    await db.exec(
      `UPDATE outreach_campaign_members SET status = 'sent' WHERE campaign_id = ${finished.id}`,
    );

    const quota = quotaStub();
    const deps = { generate: draftWriter(db), send: sendOK(quota), quota };
    const report = await runCampaignAutoAdvance(env, { deps });

    expect(report.advanced).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect((await getCampaign(env, off.id))?.pending).toBe(1);
    expect((await getCampaign(env, paused.id))?.pending).toBe(1);
  });

  it("advances only generateBatch members per tick and resumes on the next", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "a@x.com"));
    db.exec(seedCustomer(2, "b@x.com"));
    const created = await makeCampaign(env, 1);
    await db.exec(
      `INSERT INTO outreach_campaign_members (campaign_id, customer_id, status) VALUES (${created.id}, 2, 'pending')`,
    );
    await setCampaignAutoAdvance(env, created.id, true);

    const quota = quotaStub();
    const deps = { generate: draftWriter(db), send: sendOK(quota), quota };
    const first = await runCampaignAutoAdvance(env, { generateBatch: 1, sendBatch: 1, deps });
    expect(first.advanced[0].generated).toBe(1);

    const mid = await getCampaign(env, created.id);
    expect(mid?.pending).toBe(1);

    const second = await runCampaignAutoAdvance(env, { generateBatch: 1, sendBatch: 1, deps });
    expect(second.advanced[0].generated).toBe(1);
    const done = await getCampaign(env, created.id);
    expect(done?.remaining).toBe(0);
    expect(done?.sent).toBe(2);
  });

  it("skips a failing campaign without breaking the rest of the tick", async () => {
    const { db, env } = await makeDb();
    db.exec(seedCustomer(1, "a@x.com"));
    db.exec(seedCustomer(2, "b@x.com"));
    const broken = await makeCampaign(env, 1);
    const healthy = await makeCampaign(env, 2);
    await setCampaignAutoAdvance(env, broken.id, true);
    await setCampaignAutoAdvance(env, healthy.id, true);

    // generate 对 broken 的客户抛错 — runCampaignGenerate 会记录 last_error
    // 后重抛，auto-advance 必须吞掉它并继续处理 healthy。
    const generate: GenerateFn = async (_env, _brand, ids) => {
      if (ids.includes(1)) throw new Error("AI 服务暂时不可用");
      const drafts = ids.map((cid) => {
        const r = db
          .prepare(
            "INSERT INTO outreach_emails (customer_id, brand_name, subject, body, status) VALUES (?,?,?,?,'draft')",
          )
          .run(cid, "Afarer", "S" + cid, "B" + cid);
        return { customer_id: cid, email_id: Number(r.lastInsertRowid) };
      });
      return { generated: drafts.length, already: [], drafts, errors: [] };
    };
    const quota = quotaStub();
    const deps = { generate, send: sendOK(quota), quota };
    const report = await runCampaignAutoAdvance(env, { deps });

    expect(report.skipped).toEqual([{ campaign: broken.id, reason: "AI 服务暂时不可用" }]);
    expect(report.advanced).toEqual([{ campaign: healthy.id, generated: 1, sent: 1 }]);
    expect((await getCampaign(env, broken.id))?.last_error).toContain("AI 服务暂时不可用");
  });
});
