import { describe, expect, it } from "vitest";
import { handleCrmApi, parseCsv, type CrmDealRow } from "../src/crm";
import type { AdminAuthContext, AdminEnv } from "../src/admin";

/* CRM 扩展（①赢单转客户+输单原因 ②看板排序/归档 ③任务顺延 ④联系人合并
 * ⑤CSV 导入 ⑥聚合统计）。覆盖顺序对照 src/crm.ts 的实现。 */

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

const AUTH: AdminAuthContext = {
  user: { id: "u1", username: "operator", role: "operator", enabled: 1 },
  sessionId: "",
  tokenHash: null,
  via: "session",
  expiresAt: null,
};

async function makeDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE crm_companies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT UNIQUE, industry TEXT,
      country TEXT, tier TEXT DEFAULT 'unqualified', lead_status TEXT DEFAULT 'new',
      merged_from_ids TEXT, chinese_remarks TEXT, customer_since TEXT,
      do_not_contact INTEGER DEFAULT 0,
      domain_email_status TEXT NOT NULL DEFAULT 'pending',
      source TEXT NOT NULL DEFAULT 'unknown',
      address TEXT, external_id TEXT, dealer_brands TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE crm_contacts (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL, job_title TEXT, email TEXT, whatsapp_or_phone TEXT,
      linkedin_url TEXT, is_primary INTEGER DEFAULT 0,
      email_status TEXT DEFAULT 'unknown', email_verified_at TEXT,
      email_check_status TEXT NOT NULL DEFAULT 'pending',
      unsubscribed_at TEXT, do_not_contact INTEGER DEFAULT 0,
      procurement_role TEXT NOT NULL DEFAULT 'unknown',
      role_evidence TEXT, role_updated_at TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE crm_deals (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
      title TEXT NOT NULL, stage TEXT DEFAULT 'inquiry', amount REAL, incoterms TEXT,
      expected_close_date TEXT, lost_reason TEXT, won_at TEXT, position REAL, archived_at TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE crm_activities (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
      deal_id TEXT, type TEXT DEFAULT 'manual_note', summary TEXT NOT NULL,
      due_date TEXT, is_completed INTEGER DEFAULT 0, owner TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE crm_deal_contacts (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
      contact_id TEXT NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
      role_in_deal TEXT, added_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(deal_id, contact_id)
    );
    CREATE TABLE crm_signal_watch (
      company_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
      interval_days INTEGER NOT NULL DEFAULT 14, last_checked_at TEXT, last_error TEXT
    );
    CREATE TABLE crm_signal_checks (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, signal_type TEXT NOT NULL,
      signal_text TEXT NOT NULL, source_url TEXT, detected_at TEXT NOT NULL,
      expires_at TEXT, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(company_id, signal_type, source_url)
    );
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT, actor_user_id TEXT,
      actor_username TEXT, actor_role TEXT, action TEXT, resource_type TEXT,
      resource_id TEXT, metadata TEXT, ip_hash TEXT, user_agent_hash TEXT,
      status INTEGER, created_at TEXT
    );
  `);
  const env = { DB: new FakeD1(db) } as unknown as AdminEnv;
  return { db, env };
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`https://worker.example.com${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
  });
}

async function call(env: AdminEnv, method: string, path: string, body?: unknown) {
  const res = await handleCrmApi(req(method, path, body), env, AUTH);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

function dateFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function seedCompany(env: AdminEnv, id: string, name = `公司 ${id}`) {
  const r = await call(env, "POST", "/admin/api/crm/companies", { name, domain: `${id}.example.com` });
  expect(r.status).toBe(201);
  return r.body.company as { id: string };
}

async function seedDeal(env: AdminEnv, companyId: string, title: string, extra: Record<string, unknown> = {}) {
  const r = await call(env, "POST", "/admin/api/crm/deals", { company_id: companyId, title, ...extra });
  expect(r.status).toBe(201);
  return r.body.deal as CrmDealRow;
}

/* ── ① 赢单转客户 + 输单原因 ───────────────────────────────────────────── */

describe("① 赢单/输单闭环", () => {
  it("stage → won flips the company into a customer (first win wins)", async () => {
    const { db, env } = await makeDb();
    const c = await seedCompany(env, "c_1");
    const d1 = await seedDeal(env, c.id, "第一单", { amount: 1000 });
    const d2 = await seedDeal(env, c.id, "第二单", { amount: 4000 });

    const r1 = await call(env, "PATCH", `/admin/api/crm/deals/${d1.id}`, { stage: "won" });
    expect(r1.status).toBe(200);
    expect(r1.body.deal.won_at).toBe(dateFromToday(0));
    const co1 = db.prepare("SELECT customer_since FROM crm_companies WHERE id = ?").get(c.id) as any;
    expect(co1.customer_since).toBe(dateFromToday(0));

    // 第二次赢单不得改写首次成交日
    await call(env, "PATCH", `/admin/api/crm/deals/${d2.id}`, { stage: "won" });
    const co2 = db.prepare("SELECT customer_since FROM crm_companies WHERE id = ?").get(c.id) as any;
    expect(co2.customer_since).toBe(dateFromToday(0));

    const acts = db.prepare("SELECT summary FROM crm_activities WHERE company_id = ? ORDER BY created_at").all(c.id) as any[];
    expect(acts.some((a) => a.summary.includes("赢单 🎉"))).toBe(true);
  });

  it("lost_reason records the loss; reopening clears it; non-lost stages reject it", async () => {
    const { db, env } = await makeDb();
    const c = await seedCompany(env, "c_1");
    const d = await seedDeal(env, c.id, "报价单");

    const lost = await call(env, "PATCH", `/admin/api/crm/deals/${d.id}`, { stage: "lost", lost_reason: "价格太高" });
    expect(lost.status).toBe(200);
    expect(lost.body.deal.lost_reason).toBe("价格太高");

    // 非输单阶段不允许携带输单原因
    const bad = await call(env, "PATCH", `/admin/api/crm/deals/${d.id}`, { lost_reason: "x", stage: "inquiry" });
    expect(bad.status).toBe(400);

    // 重新打开 → 陈旧的输单原因被清空
    const reopen = await call(env, "PATCH", `/admin/api/crm/deals/${d.id}`, { stage: "inquiry" });
    expect(reopen.status).toBe(200);
    expect(reopen.body.deal.lost_reason).toBeNull();
    expect(db.prepare("SELECT customer_since FROM crm_companies WHERE id = ?").get(c.id)).toMatchObject({ customer_since: null });
  });

  it("a deal created directly as won sets won_at + customer_since", async () => {
    const { db, env } = await makeDb();
    const c = await seedCompany(env, "c_1");
    const d = await seedDeal(env, c.id, "进口首单", { stage: "won", amount: 900 });
    expect(d.won_at).toBe(dateFromToday(0));
    const co = db.prepare("SELECT customer_since FROM crm_companies WHERE id = ?").get(c.id) as any;
    expect(co.customer_since).toBe(dateFromToday(0));
  });

  it("⑥ stats aggregate: customers_won / forecast / overdue", async () => {
    const { env } = await makeDb();
    const c1 = await seedCompany(env, "c_1");
    const c2 = await seedCompany(env, "c_2");
    await seedDeal(env, c1.id, "赢单", { stage: "won", amount: 5000 });
    await seedDeal(env, c2.id, "询盘中", { amount: 1000 });
    await seedDeal(env, c2.id, "PI", { stage: "pi_sent", amount: 2000 });
    await call(env, "POST", "/admin/api/crm/activities", {
      company_id: c2.id, type: "task", summary: "逾期任务", due_date: dateFromToday(-2),
    });
    await call(env, "POST", "/admin/api/crm/activities", {
      company_id: c2.id, type: "task", summary: "未来任务", due_date: dateFromToday(9),
    });

    const r = await call(env, "GET", "/admin/api/crm/stats");
    expect(r.status).toBe(200);
    const s = r.body.stats;
    expect(s.customers_won).toBe(1);
    expect(s.open_deals).toBe(2);
    expect(s.pipeline_amount).toBe(3000);
    // 询盘 10% + PI 50% = 100 + 1000
    expect(s.forecast_amount).toBe(1100);
    expect(s.open_tasks).toBe(2);
    expect(s.overdue_tasks).toBe(1);
    expect(r.body.won_monthly).toEqual([{ month: dateFromToday(0).slice(0, 7), total: 5000 }]);
  });

  it("funnel metrics: null without gmail_send_log, full chain once it exists", async () => {
    const { db, env } = await makeDb();

    // fail-open：gmail_send_log 缺失时漏斗返回 null，其余统计照常。
    let r = await call(env, "GET", "/admin/api/crm/stats");
    expect(r.status).toBe(200);
    expect(r.body.stats).toBeTruthy();
    expect(r.body.funnel).toBeNull();

    db.exec(`
      CREATE TABLE gmail_send_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        outreach_email_id INTEGER,
        recipient TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'sent',
        detail TEXT,
        sender_client_email TEXT,
        request_id TEXT
      );
    `);
    const c1 = await seedCompany(env, "c_1");
    await seedDeal(env, c1.id, "赢单", { stage: "won", amount: 100 });
    db.prepare("INSERT INTO crm_contacts (id, company_id, full_name, email) VALUES ('ct1', ?, 'J', 'a@acme.com')").run(c1.id);
    db.prepare("INSERT INTO gmail_send_log (recipient, status) VALUES ('a@acme.com', 'sent')").run();
    db.prepare("INSERT INTO gmail_send_log (recipient, status) VALUES ('a@acme.com', 'failed')").run();
    db.prepare(
      "INSERT INTO crm_activities (id, company_id, type, summary) VALUES ('act1', ?, 'email_received', '收到来信: x')",
    ).run(c1.id);

    r = await call(env, "GET", "/admin/api/crm/stats");
    const f = r.body.funnel;
    expect(f.companies).toBe(1);
    expect(f.contacts).toBe(1);
    expect(f.emails_sent).toBe(1); // failed 发信不计触达
    expect(f.replies).toBe(1);
    expect(f.deals).toBe(1);
    expect(f.won).toBe(1);
    expect(f.reply_rate).toBe(100);
  });
});

/* ── ② 看板排序 + 归档 ─────────────────────────────────────────────────── */

describe("② 看板 position / 归档", () => {
  it("new deals get incrementing per-stage positions and list in that order", async () => {
    const { env } = await makeDb();
    const c = await seedCompany(env, "c_1");
    const d1 = await seedDeal(env, c.id, "A");
    const d2 = await seedDeal(env, c.id, "B");
    const d3 = await seedDeal(env, c.id, "C");
    expect(d1.position).toBe(1);
    expect(d2.position).toBe(2);
    expect(d3.position).toBe(3);

    // 把 C 拖到最前（position 0.5）
    const move = await call(env, "PATCH", `/admin/api/crm/deals/${d3.id}`, { stage: "inquiry", position: 0.5 });
    expect(move.status).toBe(200);
    const list = await call(env, "GET", "/admin/api/crm/deals");
    expect(list.body.deals.map((d: any) => d.title)).toEqual(["C", "A", "B"]);
  });

  it("archived deals leave the kanban and come back on restore", async () => {
    const { env } = await makeDb();
    const c = await seedCompany(env, "c_1");
    const open = await seedDeal(env, c.id, "进行中");
    const done = await seedDeal(env, c.id, "已赢单", { stage: "won" });

    const arch = await call(env, "PATCH", `/admin/api/crm/deals/${done.id}`, { archived: true });
    expect(arch.status).toBe(200);
    expect(arch.body.deal.archived_at).toBe(dateFromToday(0));

    const active = await call(env, "GET", "/admin/api/crm/deals");
    expect(active.body.deals.map((d: any) => d.title)).toEqual(["进行中"]);
    const archived = await call(env, "GET", "/admin/api/crm/deals?archived=1");
    expect(archived.body.deals.map((d: any) => d.title)).toEqual(["已赢单"]);

    const restore = await call(env, "PATCH", `/admin/api/crm/deals/${done.id}`, { archived: false });
    expect(restore.body.deal.archived_at).toBeNull();
    const active2 = await call(env, "GET", "/admin/api/crm/deals");
    expect(active2.body.deals.length).toBe(2);
    expect(open.id).toBeTruthy();
  });
});

/* ── ③ 任务顺延 ────────────────────────────────────────────────────────── */

describe("③ 任务 due_date 顺延", () => {
  it("a task can be rescheduled; non-task rows reject due_date", async () => {
    const { env } = await makeDb();
    const c = await seedCompany(env, "c_1");
    const task = await call(env, "POST", "/admin/api/crm/activities", {
      company_id: c.id, type: "task", summary: "回访", due_date: dateFromToday(-1),
    });
    expect(task.status).toBe(201);

    const snooze = await call(env, "PATCH", `/admin/api/crm/activities/${task.body.activity.id}`, {
      due_date: dateFromToday(1),
    });
    expect(snooze.status).toBe(200);
    expect(snooze.body.activity.due_date).toBe(dateFromToday(1));

    const note = await call(env, "POST", "/admin/api/crm/activities", {
      company_id: c.id, type: "note", summary: "备注",
    });
    const bad = await call(env, "PATCH", `/admin/api/crm/activities/${note.body.activity.id}`, {
      due_date: dateFromToday(1),
    });
    expect(bad.status).toBe(400);
  });
});

/* ── ④ 联系人合并 ─────────────────────────────────────────────────────── */

describe("④ 联系人合并", () => {
  it("fills the target's gaps, escalates is_primary, deletes the source, logs the timeline", async () => {
    const { db, env } = await makeDb();
    const c = await seedCompany(env, "c_1");
    const tgt = await call(env, "POST", "/admin/api/crm/contacts", {
      company_id: c.id, full_name: "张三", email: "zhang@co.com",
    });
    const src = await call(env, "POST", "/admin/api/crm/contacts", {
      company_id: c.id, full_name: "张三（重复）", job_title: "采购总监",
      whatsapp_or_phone: "+8613800000000", is_primary: true,
    });
    expect(tgt.status).toBe(201);
    expect(src.status).toBe(201);

    const r = await call(env, "POST", "/admin/api/crm/contacts/merge", {
      target_contact_id: tgt.body.contact.id, source_contact_id: src.body.contact.id,
    });
    expect(r.status).toBe(200);
    expect(r.body.contact.job_title).toBe("采购总监");
    expect(r.body.contact.email).toBe("zhang@co.com"); // 目标已有值不被覆盖
    expect(r.body.contact.whatsapp_or_phone).toBe("+8613800000000");
    expect(r.body.contact.is_primary).toBe(1); // 主联升级而非降级

    expect(db.prepare("SELECT COUNT(*) AS n FROM crm_contacts WHERE id = ?").get(src.body.contact.id)).toMatchObject({ n: 0 });
    const acts = db.prepare("SELECT summary FROM crm_activities WHERE company_id = ?").all(c.id) as any[];
    expect(acts.some((a) => a.summary.includes("合并重复联系人"))).toBe(true);
  });

  it("rejects merging a contact into itself and 404s on unknown ids", async () => {
    const { env } = await makeDb();
    const c = await seedCompany(env, "c_1");
    const a = await call(env, "POST", "/admin/api/crm/contacts", { company_id: c.id, full_name: "A" });
    const same = await call(env, "POST", "/admin/api/crm/contacts/merge", {
      target_contact_id: a.body.contact.id, source_contact_id: a.body.contact.id,
    });
    expect(same.status).toBe(400);
    const missing = await call(env, "POST", "/admin/api/crm/contacts/merge", {
      target_contact_id: "nope", source_contact_id: a.body.contact.id,
    });
    expect(missing.status).toBe(404);
  });
});

/* ── ⑤ CSV 导入 ───────────────────────────────────────────────────────── */

describe("⑤ parseCsv", () => {
  it("handles quotes, escaped quotes, CRLF and the UTF-8 BOM", () => {
    const csv = "\uFEFFname,domain\r\n\"Acme, Inc\",\"acme.com\"\r\n\"He said \"\"hi\"\"\",\r\n";
    const rows = parseCsv(csv);
    expect(rows).toEqual([
      ["name", "domain"],
      ["Acme, Inc", "acme.com"],
      ['He said "hi"', ""],
    ]);
  });
});

describe("⑤ CSV 导入 API", () => {
  it("companies: creates, dedupes by name/domain, falls back bad tiers, reports row errors", async () => {
    const { env } = await makeDb();
    await seedCompany(env, "c_1", "已存在的公司");

    const csv = [
      "名称,域名,国家,分级",
      "新公司甲,new-a.com,德国,A",
      "已存在的公司,dup.com,美国,",
      ",nodomain.com,,",
      "新公司乙,,日本,不是分级",
    ].join("\n");
    const r = await call(env, "POST", "/admin/api/crm/import", { entity: "companies", csv });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(2);
    expect(r.body.skipped).toBe(1);
    expect(r.body.error_total).toBe(1);
    expect(r.body.errors[0]).toContain("缺少公司名称");

    const list = await call(env, "GET", "/admin/api/crm/companies?limit=200");
    const byName = new Map(list.body.companies.map((c: any) => [c.name, c]));
    expect(byName.get("新公司甲").country).toBe("德国");
    expect(byName.get("新公司甲").tier).toBe("A");
    expect(byName.get("新公司乙").tier).toBe("unqualified");
  });

  it("contacts: auto-creates the company, dedupes by email within it", async () => {
    const { env } = await makeDb();
    const csv = [
      "公司,姓名,职务,邮箱,主联",
      "Acme,张三,采购,zhang@acme.com,1",
      "Acme,张三,采购,zhang@acme.com,",
      "Acme,李四,物流,li@acme.com,",
    ].join("\n");
    const r = await call(env, "POST", "/admin/api/crm/import", { entity: "contacts", csv });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(2);
    expect(r.body.skipped).toBe(1);
    expect(r.body.companies_created).toBe(1);

    const list = await call(env, "GET", "/admin/api/crm/companies?limit=200");
    expect(list.body.total).toBe(1);
    const co = await call(env, "GET", `/admin/api/crm/companies/${list.body.companies[0].id}`);
    expect(co.body.contacts.length).toBe(2);
    expect(co.body.contacts.find((x: any) => x.full_name === "张三").is_primary).toBe(1);
  });

  it("deals: unknown stage falls back to inquiry, $1,200-style amounts parse, won imports set customer_since", async () => {
    const { env } = await makeDb();
    const csv = [
      "公司,名称,阶段,金额,预计成交",
      "Acme,大单,won,\"$1,200\",2026-12-01",
      "Acme,小单,bogus_stage,300,",
    ].join("\n");
    const r = await call(env, "POST", "/admin/api/crm/import", { entity: "deals", csv });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(2);

    const list = await call(env, "GET", "/admin/api/crm/deals");
    const byTitle = new Map(list.body.deals.map((d: any) => [d.title, d]));
    expect(byTitle.get("大单").amount).toBe(1200);
    expect(byTitle.get("大单").won_at).toBe(dateFromToday(0));
    expect(byTitle.get("小单").stage).toBe("inquiry");

    const co = await call(env, "GET", "/admin/api/crm/companies?limit=200");
    expect(co.body.companies[0].customer_since).toBe(dateFromToday(0));
  });

  it("rejects a missing required column and oversized input", async () => {
    const { env } = await makeDb();
    const noName = await call(env, "POST", "/admin/api/crm/import", {
      entity: "companies", csv: "域名\nacme.com",
    });
    expect(noName.status).toBe(400);

    const rows = ["姓名,公司"];
    for (let i = 0; i < 1001; i++) rows.push(`人${i},Acme`);
    const tooBig = await call(env, "POST", "/admin/api/crm/import", {
      entity: "contacts", csv: rows.join("\n"),
    });
    expect(tooBig.status).toBe(400);
  });
});
