import { describe, expect, it } from "vitest";
import { handleCrmApi, type CrmCompanyRow } from "../src/crm";
import { requiredPermission } from "../src/auth/rbac";
import type { AdminAuthContext, AdminEnv } from "../src/admin";

/* CRM 销售层 (src/crm.ts)：四个端到端性质最关键 ——
 *   1. 线索提升（promote）: customers 行 → crm_companies，幂等、带联系人；
 *   2. 公司合并（merge）: 单事务迁移联系人/商机/动态 + 溯源备注 + 删除来源；
 *   3. 商机阶段推进会写入时间线；
 *   4. 任务生命周期（创建 → 待办列表 → 完成）。
 * RBAC 映射（/admin/api/crm/* → customers.read/write）单独验证。 */

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
  // node:sqlite 不会默认打开 FK 约束 —— 打开它，让 ON DELETE CASCADE 的行为
  // 与 D1（默认强制 FK）一致。
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY, company_id TEXT, company_name TEXT, domain TEXT,
      industry TEXT, country TEXT, lead_score INTEGER, email TEXT
    );
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY, contact_id TEXT, company_id TEXT, seq INTEGER,
      first_name TEXT, last_name TEXT, full_name TEXT, title TEXT, department TEXT,
      email TEXT, cellphone TEXT, tel TEXT, whatsapp TEXT, linkedin_url TEXT
    );
    CREATE TABLE crm_companies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT UNIQUE, industry TEXT,
      country TEXT, tier TEXT DEFAULT 'unqualified', lead_status TEXT DEFAULT 'new',
      merged_from_ids TEXT, chinese_remarks TEXT, customer_since TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE crm_contacts (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL, job_title TEXT, email TEXT, whatsapp_or_phone TEXT,
      linkedin_url TEXT, is_primary INTEGER DEFAULT 0,
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
      due_date TEXT, is_completed INTEGER DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
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

/* ── 线索提升 ───────────────────────────────────────────────────────────── */

describe("线索提升 (promote)", () => {
  it("copies the pipeline lead into a company with contacts and a timeline row", async () => {
    const { db, env } = await makeDb();
    db.prepare(
      `INSERT INTO customers (id, company_id, company_name, domain, industry, country, lead_score, email)
       VALUES (7, 'co7', 'Acme Marine', 'acme.com', 'Boating', 'Spain', 85, 'info@acme.com')`,
    ).run();
    db.prepare(
      `INSERT INTO contacts (id, contact_id, company_id, seq, first_name, last_name, title, email, whatsapp)
       VALUES (1, 'ct1', 'co7', 1, 'Ana', 'Lopez', 'CEO', 'ana@acme.com', '+34 600')`,
    ).run();
    db.prepare(
      `INSERT INTO contacts (id, contact_id, company_id, seq, full_name, email)
       VALUES (2, 'ct2', 'co7', 2, 'Bob Sales', 'bob@acme.com')`,
    ).run();

    const r = await call(env, "POST", "/admin/api/crm/companies/promote", { customer_id: 7 });
    expect(r.status).toBe(201);
    expect(r.body.already_promoted).toBe(false);
    expect(r.body.company.id).toBe("c_7");
    expect(r.body.company.name).toBe("Acme Marine");
    expect(r.body.company.tier).toBe("A");
    expect(r.body.company.lead_status).toBe("enriched");

    const contacts = db.prepare("SELECT * FROM crm_contacts ORDER BY id").all() as any[];
    expect(contacts).toHaveLength(2);
    expect(contacts[0].id).toBe("ct_1");
    expect(contacts[0].full_name).toBe("Ana Lopez");
    expect(contacts[0].is_primary).toBe(1);
    expect(contacts[1].id).toBe("ct_2");
    expect(contacts[1].is_primary).toBe(0);

    const acts = db.prepare("SELECT * FROM crm_activities").all() as any[];
    expect(acts).toHaveLength(1);
    expect(acts[0].type).toBe("lead_promoted");
    expect(acts[0].summary).toContain("customers#7");
  });

  it("is idempotent — the second call returns the same company", async () => {
    const { db, env } = await makeDb();
    db.prepare(
      `INSERT INTO customers (id, company_id, company_name, domain, lead_score, email)
       VALUES (9, 'co9', 'Dup Co', 'dup.com', 55, 'x@dup.com')`,
    ).run();
    const first = await call(env, "POST", "/admin/api/crm/companies/promote", { customer_id: 9 });
    expect(first.status).toBe(201);
    const second = await call(env, "POST", "/admin/api/crm/companies/promote", { customer_id: 9 });
    expect(second.status).toBe(200);
    expect(second.body.already_promoted).toBe(true);
    expect(second.body.company.id).toBe("c_9");
    const count = (db.prepare("SELECT COUNT(*) AS n FROM crm_companies").get() as any).n;
    expect(count).toBe(1);
  });

  it("falls back to the import-time email when the pipeline has no contacts", async () => {
    const { db, env } = await makeDb();
    db.prepare(
      `INSERT INTO customers (id, company_id, company_name, domain, lead_score, email)
       VALUES (11, 'co11', 'Lonely Co', 'lonely.com', 30, 'buy@lonely.com')`,
    ).run();
    const r = await call(env, "POST", "/admin/api/crm/companies/promote", { customer_id: 11 });
    expect(r.status).toBe(201);
    expect(r.body.company.tier).toBe("unqualified");
    const contact = db.prepare("SELECT * FROM crm_contacts").get() as any;
    expect(contact.email).toBe("buy@lonely.com");
    expect(contact.is_primary).toBe(1);
  });

  it("rejects an unknown pipeline id with 404", async () => {
    const { env } = await makeDb();
    const r = await call(env, "POST", "/admin/api/crm/companies/promote", { customer_id: 999 });
    expect(r.status).toBe(404);
  });

  it("blocks promotion when another company already owns the domain (409)", async () => {
    const { db, env } = await makeDb();
    db.prepare(
      `INSERT INTO crm_companies (id, name, domain) VALUES ('manual-1', 'Manual Co', 'clash.com')`,
    ).run();
    db.prepare(
      `INSERT INTO customers (id, company_id, company_name, domain, lead_score, email)
       VALUES (12, 'co12', 'Clash Co', 'clash.com', 70, 'c@clash.com')`,
    ).run();
    const r = await call(env, "POST", "/admin/api/crm/companies/promote", { customer_id: 12 });
    expect(r.status).toBe(409);
  });
});

/* ── 公司合并 ───────────────────────────────────────────────────────────── */

describe("公司合并 (merge)", () => {
  it("migrates contacts/deals/activities, records traceability and deletes the source", async () => {
    const { db, env } = await makeDb();
    await call(env, "POST", "/admin/api/crm/companies", {
      name: "Target GmbH",
      domain: "target.de",
      country: "Germany",
    });
    await call(env, "POST", "/admin/api/crm/companies", {
      name: "Target Dupe",
      domain: "dupe.de",
      country: "Germany",
    });
    const companies = db
      .prepare("SELECT * FROM crm_companies ORDER BY name")
      .all() as any[];
    const target = companies.find((c: any) => c.name === "Target GmbH") as CrmCompanyRow;
    const source = companies.find((c: any) => c.name === "Target Dupe") as CrmCompanyRow;

    await call(env, "POST", "/admin/api/crm/contacts", {
      company_id: source.id,
      full_name: "Hans Dup",
      email: "hans@dupe.de",
    });
    await call(env, "POST", "/admin/api/crm/contacts", {
      company_id: target.id,
      full_name: "Greta Target",
    });
    const deal = await call(env, "POST", "/admin/api/crm/deals", {
      company_id: source.id,
      title: "Q4 order",
      amount: 12500,
      incoterms: "FOB",
    });
    expect(deal.status).toBe(201);
    const task = await call(env, "POST", "/admin/api/crm/activities", {
      company_id: source.id,
      type: "task",
      summary: "给客户回电话",
      due_date: "2026-11-02",
    });
    expect(task.status).toBe(201);
    await call(env, "POST", "/admin/api/crm/activities", {
      company_id: source.id,
      type: "note",
      summary: "老系统备注",
    });

    const merged = await call(env, "POST", "/admin/api/crm/companies/merge", {
      target_company_id: target.id,
      source_company_id: source.id,
    });
    expect(merged.status).toBe(200);

    // 来源已删除
    const sourceRow = db.prepare("SELECT * FROM crm_companies WHERE id = ?").get(source.id);
    expect(sourceRow).toBeUndefined();

    // 联系人/商机/任务全部迁到目标
    const contacts = db.prepare("SELECT * FROM crm_contacts ORDER BY full_name").all() as any[];
    expect(contacts).toHaveLength(2);
    for (const c of contacts) expect(c.company_id).toBe(target.id);
    const deals = db.prepare("SELECT * FROM crm_deals").all() as any[];
    expect(deals).toHaveLength(1);
    expect(deals[0].company_id).toBe(target.id);
    const activities = db.prepare("SELECT * FROM crm_activities").all() as any[];
    expect(activities).toHaveLength(3); // note + task + 合并记录
    for (const a of activities) expect(a.company_id).toBe(target.id);
    const mergedAct = activities.find((a: any) => a.type === "company_merged");
    expect(mergedAct).toBeDefined();
    expect(mergedAct.summary).toContain(source.name);

    // 溯源：merged_from_ids + 中文备注
    const targetRow = db.prepare("SELECT * FROM crm_companies WHERE id = ?").get(target.id) as any;
    expect(targetRow.merged_from_ids).toBe(source.id);
    expect(targetRow.chinese_remarks).toContain("[合并]");
    expect(targetRow.chinese_remarks).toContain(source.id);

    // 迁移后的任务仍在待办列表里（company_id 已指向目标）
    const openTasks = await call(env, "GET", "/admin/api/crm/activities");
    const summaries = openTasks.body.activities.map((a: any) => a.summary);
    expect(summaries).toContain("给客户回电话");
  });

  it("refuses to merge a company into itself (400)", async () => {
    const { env } = await makeDb();
    await call(env, "POST", "/admin/api/crm/companies", { name: "Solo" });
    const r = await call(env, "POST", "/admin/api/crm/companies/merge", {
      target_company_id: "x",
      source_company_id: "x",
    });
    expect(r.status).toBe(400);
  });

  it("404s when the source company does not exist", async () => {
    const { env } = await makeDb();
    await call(env, "POST", "/admin/api/crm/companies", { name: "Real" });
    const real = (await call(env, "GET", "/admin/api/crm/companies")).body.companies[0];
    const r = await call(env, "POST", "/admin/api/crm/companies/merge", {
      target_company_id: real.id,
      source_company_id: "ghost",
    });
    expect(r.status).toBe(404);
  });
});

/* ── 商机阶段 ───────────────────────────────────────────────────────────── */

describe("商机阶段推进", () => {
  it("records the stage move in the company timeline", async () => {
    const { db, env } = await makeDb();
    await call(env, "POST", "/admin/api/crm/companies", { name: "Stage Co" });
    const company = (await call(env, "GET", "/admin/api/crm/companies")).body.companies[0];
    const created = await call(env, "POST", "/admin/api/crm/deals", {
      company_id: company.id,
      title: "样单",
      amount: 800,
    });
    const dealId = created.body.deal.id;

    const moved = await call(env, "PATCH", `/admin/api/crm/deals/${dealId}`, {
      stage: "sample_quoted",
    });
    expect(moved.status).toBe(200);
    expect(moved.body.deal.stage).toBe("sample_quoted");

    const acts = db.prepare("SELECT * FROM crm_activities").all() as any[];
    expect(acts).toHaveLength(1);
    expect(acts[0].summary).toContain("inquiry");
    expect(acts[0].summary).toContain("sample_quoted");
    expect(acts[0].deal_id).toBe(dealId);
  });

  it("rejects an invalid stage (400)", async () => {
    const { env } = await makeDb();
    await call(env, "POST", "/admin/api/crm/companies", { name: "V Co" });
    const company = (await call(env, "GET", "/admin/api/crm/companies")).body.companies[0];
    const created = await call(env, "POST", "/admin/api/crm/deals", {
      company_id: company.id,
      title: "D",
    });
    const r = await call(
      env,
      "PATCH",
      `/admin/api/crm/deals/${created.body.deal.id}`,
      { stage: "teleported" },
    );
    expect(r.status).toBe(400);
  });
});

/* ── 任务生命周期 ───────────────────────────────────────────────────────── */

describe("任务生命周期", () => {
  it("creates a task, lists it, completes it, and drops it from the open list", async () => {
    const { env } = await makeDb();
    await call(env, "POST", "/admin/api/crm/companies", { name: "Task Co" });
    const company = (await call(env, "GET", "/admin/api/crm/companies")).body.companies[0];
    const created = await call(env, "POST", "/admin/api/crm/activities", {
      company_id: company.id,
      type: "task",
      summary: "发送节日问候",
      due_date: "2026-12-20",
    });
    expect(created.status).toBe(201);
    expect(created.body.activity.due_date).toBe("2026-12-20");

    const open = await call(env, "GET", "/admin/api/crm/activities");
    expect(open.body.activities).toHaveLength(1);
    expect(open.body.activities[0].summary).toBe("发送节日问候");
    expect(open.body.activities[0].company_name).toBe("Task Co");

    const done = await call(env, "PATCH", `/admin/api/crm/activities/${created.body.activity.id}`, {
      is_completed: true,
    });
    expect(done.status).toBe(200);
    const after = await call(env, "GET", "/admin/api/crm/activities");
    expect(after.body.activities).toHaveLength(0);
  });

  it("rejects due_date on non-task types (400)", async () => {
    const { env } = await makeDb();
    await call(env, "POST", "/admin/api/crm/companies", { name: "N Co" });
    const company = (await call(env, "GET", "/admin/api/crm/companies")).body.companies[0];
    const r = await call(env, "POST", "/admin/api/crm/activities", {
      company_id: company.id,
      type: "note",
      summary: "备注带到期日",
      due_date: "2026-12-20",
    });
    expect(r.status).toBe(400);
  });
});

/* ── 公司 CRUD 细节 ─────────────────────────────────────────────────────── */

describe("公司 CRUD", () => {
  it("rejects duplicate domains with 409", async () => {
    const { env } = await makeDb();
    const a = await call(env, "POST", "/admin/api/crm/companies", {
      name: "A",
      domain: "same.com",
    });
    expect(a.status).toBe(201);
    const b = await call(env, "POST", "/admin/api/crm/companies", {
      name: "B",
      domain: "same.com",
    });
    expect(b.status).toBe(409);
  });

  it("updates tier/lead_status/remarks via PATCH and returns the company", async () => {
    const { env } = await makeDb();
    await call(env, "POST", "/admin/api/crm/companies", { name: "Patch Co" });
    const company = (await call(env, "GET", "/admin/api/crm/companies")).body.companies[0];
    const r = await call(env, "PATCH", `/admin/api/crm/companies/${company.id}`, {
      tier: "VIP",
      lead_status: "qualified",
      chinese_remarks: "重点客户，老板直接对接",
    });
    expect(r.status).toBe(200);
    expect(r.body.company.tier).toBe("VIP");
    expect(r.body.company.lead_status).toBe("qualified");
    expect(r.body.company.chinese_remarks).toContain("重点客户");
  });

  it("deletes a company and cascades to contacts/deals/activities", async () => {
    const { db, env } = await makeDb();
    await call(env, "POST", "/admin/api/crm/companies", { name: "Del Co" });
    const company = (await call(env, "GET", "/admin/api/crm/companies")).body.companies[0];
    await call(env, "POST", "/admin/api/crm/contacts", {
      company_id: company.id,
      full_name: "X",
    });
    await call(env, "POST", "/admin/api/crm/deals", { company_id: company.id, title: "D" });
    const r = await call(env, "DELETE", `/admin/api/crm/companies/${company.id}`);
    expect(r.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM crm_contacts").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM crm_deals").get()).toEqual({ n: 0 });
  });
});

/* ── RBAC 映射 ──────────────────────────────────────────────────────────── */

describe("RBAC 映射 (/admin/api/crm/*)", () => {
  it("maps reads to customers.read and mutations to customers.write", () => {
    const read = requiredPermission(
      new URL("https://w.example.com/admin/api/crm/companies"),
      "GET",
    );
    expect(read).toBe("customers.read");
    const write = requiredPermission(
      new URL("https://w.example.com/admin/api/crm/companies/merge"),
      "POST",
    );
    expect(write).toBe("customers.write");
  });
});
