import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { handleCrmApi } from "../src/crm";
import type { AdminAuthContext, AdminEnv } from "../src/admin";

/* 阶段四（更新.txt ⑥⑦，migration 0037）HTTP 层：联系人角色推断/PATCH、
 * 商机 ↔ 联系人图谱边（crm_deal_contacts）增删、getCompany 附带
 * deals.contacts + signals、signals 总览/立即检查/watch 配置。 */

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
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
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
    CREATE TABLE crm_contacts (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL, job_title TEXT, email TEXT, whatsapp_or_phone TEXT,
      tel TEXT, cellphone TEXT, whatsapp TEXT,
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
      role_in_deal TEXT, added_at TEXT NOT NULL,
      UNIQUE(deal_id, contact_id)
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
    CREATE TABLE audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT, actor_user_id TEXT,
      actor_username TEXT, actor_role TEXT, action TEXT, resource_type TEXT,
      resource_id TEXT, metadata TEXT, ip_hash TEXT, user_agent_hash TEXT,
      status INTEGER, created_at TEXT
    );
  `);
  return db;
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

async function seedCompany(env: AdminEnv, id: string, name = `公司 ${id}`) {
  const r = await call(env, "POST", "/admin/api/crm/companies", { name, domain: `${id}.example.com` });
  expect(r.status).toBe(201);
  return r.body.company as { id: string; name: string };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ── ⑦ 联系人角色（创建推断 / 职位变更重推断 / 显式覆盖） ───────────────── */

describe("⑦ 联系人角色 API", () => {
  it("创建联系人时按职位自动推断角色并记录依据", async () => {
    const { db, env } = makeDb2();
    const c = await seedCompany(env, "c_1");
    const r = await call(env, "POST", "/admin/api/crm/contacts", {
      company_id: c.id, full_name: "张三", job_title: "采购总监",
    });
    expect(r.status).toBe(201);
    expect(r.body.contact).toMatchObject({ procurement_role: "procurement" });
    expect(r.body.contact.role_evidence).toContain("采购");
    expect(r.body.contact.role_updated_at).toBeTruthy();
  });

  it("无职位创建 → unknown；改职位 → 重新推断", async () => {
    const { db, env } = makeDb2();
    const c = await seedCompany(env, "c_1");
    const created = await call(env, "POST", "/admin/api/crm/contacts", { company_id: c.id, full_name: "John" });
    expect(created.body.contact).toMatchObject({ procurement_role: "unknown" });

    const upd = await call(env, "PATCH", `/admin/api/crm/contacts/${created.body.contact.id}`, { job_title: "Founder & CEO" });
    expect(upd.status).toBe(200);
    expect(upd.body.contact).toMatchObject({ procurement_role: "owner" });
  });

  it("显式 procurement_role 覆盖 + 依据；同请求显式角色优先于职位重推断", async () => {
    const { db, env } = makeDb2();
    const c = await seedCompany(env, "c_1");
    const created = await call(env, "POST", "/admin/api/crm/contacts", {
      company_id: c.id, full_name: "王五", job_title: "Sales Manager",
    });
    expect(created.body.contact.procurement_role).toBe("sales");

    // 显式覆盖为渠道负责人
    const override = await call(env, "PATCH", `/admin/api/crm/contacts/${created.body.contact.id}`, {
      procurement_role: "channel", role_evidence: "客户自述负责渠道合作",
    });
    expect(override.body.contact).toMatchObject({ procurement_role: "channel" });
    expect(override.body.contact.role_evidence).toBe("客户自述负责渠道合作");

    // 同请求带 job_title + 显式角色 → 显式角色胜出
    const both = await call(env, "PATCH", `/admin/api/crm/contacts/${created.body.contact.id}`, {
      job_title: "Purchasing Manager", procurement_role: "channel",
    });
    expect(both.body.contact).toMatchObject({ procurement_role: "channel", job_title: "Purchasing Manager" });

    // 非法角色 400
    const bad = await call(env, "PATCH", `/admin/api/crm/contacts/${created.body.contact.id}`, { procurement_role: "boss" });
    expect(bad.status).toBe(400);
  });
});

/* ── ⑦ 商机 ↔ 联系人图谱边 ─────────────────────────────────────────────── */

describe("⑦ 商机-联系人图谱边 API", () => {
  it("关联 → getCompany 的 deals 携带 contacts；重复关联 409；解除后消失", async () => {
    const { db, env } = makeDb2();
    const c = await seedCompany(env, "c_1");
    const ct = await call(env, "POST", "/admin/api/crm/contacts", { company_id: c.id, full_name: "李四", job_title: "采购经理" });
    const dl = await call(env, "POST", "/admin/api/crm/deals", { company_id: c.id, title: "桨板首单" });
    const deal = dl.body.deal as { id: string };
    const contact = ct.body.contact as { id: string };

    const link = await call(env, "POST", `/admin/api/crm/deals/${deal.id}/contacts`, {
      contact_id: contact.id, role_in_deal: "采购对接人",
    });
    expect(link.status).toBe(201);
    expect(link.body.edge).toMatchObject({ deal_id: deal.id, contact_id: contact.id, full_name: "李四" });

    // 重复关联 → 409
    const dup = await call(env, "POST", `/admin/api/crm/deals/${deal.id}/contacts`, { contact_id: contact.id });
    expect(dup.status).toBe(409);

    // getCompany：deals[].contacts 携带图谱边
    const detail = await call(env, "GET", `/admin/api/crm/companies/${c.id}`);
    expect(detail.status).toBe(200);
    const deals = detail.body.deals as Array<{ id: string; contacts: Array<{ contact_id: string; role_in_deal: string }> }>;
    expect(deals).toHaveLength(1);
    expect(deals[0].contacts).toHaveLength(1);
    expect(deals[0].contacts[0]).toMatchObject({ contact_id: contact.id, role_in_deal: "采购对接人" });

    // 解除关联
    const unlink = await call(env, "DELETE", `/admin/api/crm/deals/${deal.id}/contacts/${contact.id}`);
    expect(unlink.status).toBe(200);
    const after = await call(env, "GET", `/admin/api/crm/companies/${c.id}`);
    expect((after.body.deals as any[])[0].contacts).toHaveLength(0);
    // 再解除 → 404
    const gone = await call(env, "DELETE", `/admin/api/crm/deals/${deal.id}/contacts/${contact.id}`);
    expect(gone.status).toBe(404);
  });

  it("跨公司联系人禁止关联（400）；联系人/商机不存在 404", async () => {
    const { db, env } = makeDb2();
    const c1 = await seedCompany(env, "c_1");
    const c2 = await seedCompany(env, "c_2");
    const ct2 = await call(env, "POST", "/admin/api/crm/contacts", { company_id: c2.id, full_name: "外人" });
    const dl1 = await call(env, "POST", "/admin/api/crm/deals", { company_id: c1.id, title: "商机" });

    const cross = await call(env, "POST", `/admin/api/crm/deals/${dl1.body.deal.id}/contacts`, {
      contact_id: ct2.body.contact.id,
    });
    expect(cross.status).toBe(400);

    const noDeal = await call(env, "POST", "/admin/api/crm/deals/none/contacts", { contact_id: ct2.body.contact.id });
    expect(noDeal.status).toBe(404);
    const noContact = await call(env, "POST", `/admin/api/crm/deals/${dl1.body.deal.id}/contacts`, { contact_id: "none" });
    expect(noContact.status).toBe(404);
  });

  it("删除联系人时图谱边级联清理", async () => {
    const { db, env } = makeDb2();
    const c = await seedCompany(env, "c_1");
    const ct = await call(env, "POST", "/admin/api/crm/contacts", { company_id: c.id, full_name: "赵六" });
    const dl = await call(env, "POST", "/admin/api/crm/deals", { company_id: c.id, title: "商机" });
    await call(env, "POST", `/admin/api/crm/deals/${dl.body.deal.id}/contacts`, { contact_id: ct.body.contact.id });
    expect(db.prepare("SELECT COUNT(*) AS n FROM crm_deal_contacts").get()).toMatchObject({ n: 1 });

    await call(env, "DELETE", `/admin/api/crm/contacts/${ct.body.contact.id}`);
    expect(db.prepare("SELECT COUNT(*) AS n FROM crm_deal_contacts").get()).toMatchObject({ n: 0 });
  });
});

/* ── ⑥ 意向监测 HTTP 层 ─────────────────────────────────────────────────── */

describe("⑥ 意向监测 API", () => {
  it("GET /crm/signals 返回总览；check-signals 触发检查；watch PATCH 改配置", async () => {
    const { db, env } = makeDb2();
    const c = await seedCompany(env, "c_1", "Acme Marine");
    // DDG stub：distributor 查询命中一条
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("html.duckduckgo.com") && decodeURIComponent(url).includes("distributor")) {
        return new Response(
          '<a class="result__a" href="https://n.example/d">Acme Marine seeks distributors</a><a class="result__snippet"></a>',
          { status: 200 },
        );
      }
      return new Response("", { status: 200 });
    }));

    const check = await call(env, "POST", `/admin/api/crm/companies/${c.id}/check-signals`);
    expect(check.status).toBe(200);
    expect(check.body.report).toMatchObject({ company_id: c.id, new_signals: 1 });

    const overview = await call(env, "GET", "/admin/api/crm/signals");
    expect(overview.status).toBe(200);
    expect(overview.body.signals).toHaveLength(1);
    expect(overview.body.signals[0]).toMatchObject({ signal_type: "distributor", company_name: "Acme Marine" });
    expect(overview.body.watch).toHaveLength(1);

    // watch PATCH：停用 + 改周期
    const watch = await call(env, "PATCH", `/admin/api/crm/companies/${c.id}/watch`, { enabled: false, interval_days: 7 });
    expect(watch.status).toBe(200);
    expect(watch.body.watch).toMatchObject({ enabled: 0, interval_days: 7 });

    // 公司详情携带 signals
    const detail = await call(env, "GET", `/admin/api/crm/companies/${c.id}`);
    expect(detail.body.signals).toHaveLength(1);
  });

  it("check-signals 公司不存在 404", async () => {
    const { db, env } = makeDb2();
    const r = await call(env, "POST", "/admin/api/crm/companies/none/check-signals");
    expect(r.status).toBe(404);
  });
});

/* makeDb2：makeDb 的 { db, env } 包装（两种调用形态共存于本文件）。 */
function makeDb2(): { db: any; env: AdminEnv } {
  const db = makeDb();
  return { db, env: { DB: new FakeD1(db) } as unknown as AdminEnv };
}
