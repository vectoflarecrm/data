import { describe, expect, it } from "vitest";
import type { AdminEnv } from "../src/admin";
import {
  createCampaign,
  parseSegmentFilters,
  runCampaignGenerate,
  runCampaignSend,
} from "../src/campaigns";
import type { CampaignDeps } from "../src/campaigns";
import { listOverdueTasks, noteResearchEnriched } from "../src/crm-hooks";

/* CRM ↔ 流水线状态联动 (合并.txt §二):
 *   1. createCampaign 快照排除 CRM 已淘汰（disqualified）客户；
 *   2. runCampaignGenerate / runCampaignSend 把已淘汰成员标记 skipped（终态）；
 *   3. 发信成功回写 CRM：cold_email_sent 时间线 + lead_status → contacted；
 *   4. AI 调研完成写入 ai_enrichment 时间线（未提升公司静默无操作）；
 *   5. CRM 层缺失时一切 fail-open（老库行为不变）。 */

/* ── Minimal D1 shim over node:sqlite（与 campaign-auto-advance.test.ts 相同） ── */

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

const CRM_DDL = `
  CREATE TABLE crm_companies (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT UNIQUE, industry TEXT,
    country TEXT, tier TEXT DEFAULT 'unqualified', lead_status TEXT DEFAULT 'new',
    merged_from_ids TEXT, chinese_remarks TEXT, customer_since TEXT,
    do_not_contact INTEGER DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE crm_activities (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
    deal_id TEXT, type TEXT DEFAULT 'manual_note', summary TEXT NOT NULL,
    due_date TEXT, is_completed INTEGER DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;

async function makeDb(withCrm: boolean) {
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
  `);
  if (withCrm) db.exec(CRM_DDL);
  db.prepare(
    "INSERT INTO outreach_settings (brand_name, product_category, company_intro, enabled, sender_email) VALUES (?,?,?,1,'noreply@afarer.com')",
  ).run("Afarer", "SUP", "A real company intro.");
  for (let id = 1; id <= 2; id++) {
    db.prepare(
      `INSERT INTO customers (id, company_id, domain, status, company_name, country, email, customer_segment, product_categories, lead_score)
       VALUES (${id}, 'c${id}', 'x${id}.com', 'completed', 'Co ${id}', 'Spain', 'a${id}@x.com', 'Dealer', 'SUP', 80)`,
    ).run();
  }
  const env = { DB: new FakeD1(db), GMAIL_SEND_DELAY_MS: "0" } as unknown as AdminEnv;
  return { db, env };
}

function seedCrmCompany(db: any, id: string, leadStatus: string) {
  db.prepare("INSERT INTO crm_companies (id, name, lead_status) VALUES (?, ?, ?)").run(
    id,
    `CRM ${id}`,
    leadStatus,
  );
}

function seedCampaign(db: any, total: number) {
  db.prepare(
    "INSERT INTO outreach_campaigns (name, brand_name, total, status) VALUES ('T', 'Afarer', ?, 'draft')",
  ).run(total);
  return 1;
}

function seedMember(db: any, customerId: number, status: string, emailId: number | null) {
  db.prepare(
    "INSERT INTO outreach_campaign_members (campaign_id, customer_id, status, outreach_email_id) VALUES (1, ?, ?, ?)",
  ).run(customerId, status, emailId);
}

function seedDraft(db: any, customerId: number, emailTo: string) {
  const r = db
    .prepare(
      "INSERT INTO outreach_emails (customer_id, brand_name, email_to, subject, body, status) VALUES (?, 'Afarer', ?, 'S" + customerId + "', 'B" + customerId + "', 'draft')",
    )
    .run(customerId, emailTo);
  return Number(r.lastInsertRowid);
}

function memberRow(db: any, customerId: number) {
  return db
    .prepare("SELECT * FROM outreach_campaign_members WHERE campaign_id = 1 AND customer_id = ?")
    .get(customerId) as any;
}

/* ── Stubs ──────────────────────────────────────────────────────────────── */

function generateRecorder(db: any) {
  const calls: number[][] = [];
  const generate: CampaignDeps["generate"] = async (_env, _brand, ids) => {
    calls.push([...ids]);
    const drafts = ids.map((cid) => {
      const r = db
        .prepare(
          "INSERT INTO outreach_emails (customer_id, brand_name, subject, body, status) VALUES (?, 'Afarer', 'S" + cid + "', 'B" + cid + "', 'draft')",
        )
        .run(cid);
      return { customer_id: cid, email_id: Number(r.lastInsertRowid) };
    });
    return { generated: drafts.length, already: [], drafts, errors: [] };
  };
  return { generate, calls };
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

function sendRecorder(quota: ReturnType<typeof quotaStub>): CampaignDeps["send"] {
  const sentEmailIds: number[] = [];
  const send: CampaignDeps["send"] = async (_env, email) => {
    quota.state.sent++;
    sentEmailIds.push(email.id);
    return { ok: true };
  };
  return Object.assign(send, { sentEmailIds });
}

/* ── Tests ──────────────────────────────────────────────────────────────── */

describe("createCampaign 排除 CRM 已淘汰客户", () => {
  it("excludes disqualified companies from the snapshot", async () => {
    const { db, env } = await makeDb(true);
    seedCrmCompany(db, "c_2", "disqualified");
    const created = await createCampaign(env, {
      brandName: "Afarer",
      filters: parseSegmentFilters({}),
    });
    expect(created.total).toBe(1);
    const members = db.prepare("SELECT customer_id FROM outreach_campaign_members").all() as any[];
    expect(members.map((m) => m.customer_id)).toEqual([1]);
  });

  it("keeps qualified/contacted CRM companies in the snapshot", async () => {
    const { db, env } = await makeDb(true);
    seedCrmCompany(db, "c_1", "qualified");
    seedCrmCompany(db, "c_2", "contacted");
    const created = await createCampaign(env, {
      brandName: "Afarer",
      filters: parseSegmentFilters({}),
    });
    expect(created.total).toBe(2);
  });

  it("fail-open: without the CRM layer the snapshot is unchanged", async () => {
    const { env } = await makeDb(false);
    const created = await createCampaign(env, {
      brandName: "Afarer",
      filters: parseSegmentFilters({}),
    });
    expect(created.total).toBe(2);
  });
});

describe("runCampaignGenerate 跳过已淘汰成员", () => {
  it("marks disqualified pending members skipped and generates the rest", async () => {
    const { db, env } = await makeDb(true);
    seedCrmCompany(db, "c_2", "disqualified");
    seedCampaign(db, 2);
    seedMember(db, 1, "pending", null);
    seedMember(db, 2, "pending", null);
    const { generate, calls } = generateRecorder(db);

    const r = await runCampaignGenerate(env, 1, 10, { generate });
    expect(r.generated).toBe(1);
    expect(calls).toEqual([[1]]);
    expect(memberRow(db, 1).status).toBe("generated");
    expect(memberRow(db, 2).status).toBe("skipped");
    expect(memberRow(db, 2).error).toContain("淘汰");
  });

  it("fail-open: without the CRM layer all members generate", async () => {
    const { db, env } = await makeDb(false);
    seedCampaign(db, 2);
    seedMember(db, 1, "pending", null);
    seedMember(db, 2, "pending", null);
    const { generate, calls } = generateRecorder(db);

    const r = await runCampaignGenerate(env, 1, 10, { generate });
    expect(r.generated).toBe(2);
    expect(calls).toEqual([[1, 2]]);
  });
});

describe("runCampaignSend 不向已淘汰客户发信", () => {
  it("skips disqualified members, sends the rest, and writes back to CRM", async () => {
    const { db, env } = await makeDb(true);
    seedCrmCompany(db, "c_1", "enriched");
    seedCrmCompany(db, "c_2", "disqualified");
    seedCampaign(db, 2);
    const e1 = seedDraft(db, 1, "a1@x.com");
    const e2 = seedDraft(db, 2, "a2@x.com");
    seedMember(db, 1, "generated", e1);
    seedMember(db, 2, "generated", e2);
    const quota = quotaStub();
    const send = sendRecorder(quota);

    const r = await runCampaignSend(env, 1, 10, { send, quota });
    expect(r.generated).toBe(1);
    expect(r.failed).toBe(0);
    expect((send as any).sentEmailIds).toEqual([e1]);
    expect(memberRow(db, 1).status).toBe("sent");
    expect(memberRow(db, 2).status).toBe("skipped");
    expect(memberRow(db, 2).error).toContain("淘汰");

    // CRM 回写: 时间线 + lead_status → contacted
    const acts = db.prepare("SELECT * FROM crm_activities").all() as any[];
    expect(acts).toHaveLength(1);
    expect(acts[0].company_id).toBe("c_1");
    expect(acts[0].type).toBe("cold_email_sent");
    expect(acts[0].summary).toContain("outreach_emails#" + e1);
    const company = db.prepare("SELECT lead_status FROM crm_companies WHERE id = 'c_1'").get() as any;
    expect(company.lead_status).toBe("contacted");
    // 已淘汰公司的状态保持不变，且没有新时间线
    const disq = db.prepare("SELECT lead_status FROM crm_companies WHERE id = 'c_2'").get() as any;
    expect(disq.lead_status).toBe("disqualified");
  });

  it("does not demote an already-contacted/qualified company", async () => {
    const { db, env } = await makeDb(true);
    seedCrmCompany(db, "c_1", "qualified");
    seedCampaign(db, 1);
    const e1 = seedDraft(db, 1, "a1@x.com");
    seedMember(db, 1, "generated", e1);
    const quota = quotaStub();
    const send = sendRecorder(quota);

    await runCampaignSend(env, 1, 10, { send, quota });
    const company = db.prepare("SELECT lead_status FROM crm_companies WHERE id = 'c_1'").get() as any;
    expect(company.lead_status).toBe("qualified");
  });

  it("fail-open: without the CRM layer every member sends", async () => {
    const { db, env } = await makeDb(false);
    seedCampaign(db, 2);
    const e1 = seedDraft(db, 1, "a1@x.com");
    const e2 = seedDraft(db, 2, "a2@x.com");
    seedMember(db, 1, "generated", e1);
    seedMember(db, 2, "generated", e2);
    const quota = quotaStub();
    const send = sendRecorder(quota);

    const r = await runCampaignSend(env, 1, 10, { send, quota });
    expect(r.generated).toBe(2);
  });

  it("no CRM timeline row when the company was never promoted", async () => {
    const { db, env } = await makeDb(true);
    seedCampaign(db, 1);
    const e1 = seedDraft(db, 1, "a1@x.com");
    seedMember(db, 1, "generated", e1);
    const quota = quotaStub();
    const send = sendRecorder(quota);

    await runCampaignSend(env, 1, 10, { send, quota });
    expect(db.prepare("SELECT COUNT(*) AS n FROM crm_activities").get()).toEqual({ n: 0 });
  });
});

describe("listOverdueTasks (任务提醒)", () => {
  function daysFromToday(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function seedTask(db: any, id: string, dueDate: string | null, completed = 0) {
    db.prepare(
      "INSERT INTO crm_activities (id, company_id, type, summary, due_date, is_completed) VALUES (?, 'c_1', 'task', ?, ?, ?)",
    ).run(id, `任务 ${id}`, dueDate, completed);
  }

  it("returns only open tasks whose due_date is in the past", async () => {
    const { db, env } = await makeDb(true);
    seedCrmCompany(db, "c_1", "enriched");
    seedTask(db, "t-overdue", daysFromToday(-3));
    seedTask(db, "t-future", daysFromToday(3));
    seedTask(db, "t-done", daysFromToday(-3), 1);
    seedTask(db, "t-nodue", null);

    const overdue = await listOverdueTasks(env);
    expect(overdue.map((t) => t.summary)).toEqual(["任务 t-overdue"]);
    expect(overdue[0].due_date).toBe(daysFromToday(-3));
    expect(overdue[0].company_name).toBe("CRM c_1");
  });

  it("fail-open: without the CRM layer returns an empty list", async () => {
    const { env } = await makeDb(false);
    await expect(listOverdueTasks(env)).resolves.toEqual([]);
  });
});

describe("noteResearchEnriched (AI 调研完成 → 时间线)", () => {
  it("writes an ai_enrichment activity for a promoted company", async () => {
    const { db, env } = await makeDb(true);
    seedCrmCompany(db, "c_1", "enriched");
    await noteResearchEnriched(env, 1, "AI 调研完成（测试）");
    const acts = db.prepare("SELECT * FROM crm_activities").all() as any[];
    expect(acts).toHaveLength(1);
    expect(acts[0].type).toBe("ai_enrichment");
    expect(acts[0].summary).toBe("AI 调研完成（测试）");
  });

  it("is a silent no-op for companies that were never promoted", async () => {
    const { db, env } = await makeDb(true);
    await noteResearchEnriched(env, 42);
    expect(db.prepare("SELECT COUNT(*) AS n FROM crm_activities").get()).toEqual({ n: 0 });
  });

  it("fail-open: without the CRM layer nothing throws", async () => {
    const { env } = await makeDb(false);
    await expect(noteResearchEnriched(env, 1)).resolves.toBeUndefined();
  });
});
