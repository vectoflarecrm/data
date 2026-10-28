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
      industry TEXT, country TEXT, lead_score INTEGER, email TEXT,
      social_accounts_verified TEXT
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
      address TEXT, external_id TEXT, dealer_brands TEXT,
      legal_name TEXT, trading_name TEXT, zip_city TEXT, city TEXT, region TEXT,
      postal_code TEXT, country_code TEXT, tel TEXT, whatsapp TEXT,
      products_services TEXT, business_tag TEXT, company_type TEXT, business_model TEXT,
      founded_year TEXT, employee_range TEXT, description TEXT, target_markets TEXT,
      customer_segment TEXT, product_categories TEXT, company_size TEXT,
      geographic_coverage TEXT,
      facebook_url TEXT, instagram_url TEXT, linkedin_url TEXT,
      youtube_url TEXT, tiktok_url TEXT, twitter_url TEXT,
      is_manufacturer INTEGER DEFAULT 0, is_importer INTEGER DEFAULT 0,
      is_distributor INTEGER DEFAULT 0, is_wholesaler INTEGER DEFAULT 0,
      is_retailer INTEGER DEFAULT 0, is_ecommerce INTEGER DEFAULT 0,
      is_rental INTEGER DEFAULT 0, is_oem INTEGER DEFAULT 0,
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

  it("copies pipeline contact tel/cellphone/whatsapp into separate columns (0042 三列直拷)", async () => {
    const { db, env } = await makeDb();
    db.prepare(
      `INSERT INTO customers (id, company_id, company_name, domain, lead_score, email)
       VALUES (21, 'co21', 'Three Phone Co', '3phone.com', 60, 'x@3phone.com')`,
    ).run();
    db.prepare(
      `INSERT INTO contacts (id, contact_id, company_id, seq, full_name, tel, cellphone, whatsapp)
       VALUES (5, 'ct5', 'co21', 1, 'Pablo Phone', '+1 787-100-2000', '+1 787-100-2001', '+1 7871002002')`,
    ).run();
    const r = await call(env, "POST", "/admin/api/crm/companies/promote", { customer_id: 21 });
    expect(r.status).toBe(201);
    const row = db.prepare("SELECT * FROM crm_contacts WHERE id = 'ct_5'").get() as any;
    // 三列各自直拷，不再 COALESCE 合并成一个号
    expect(row.tel).toBe("+1 787-100-2000");
    expect(row.cellphone).toBe("+1 787-100-2001");
    expect(row.whatsapp).toBe("+1 7871002002");
    // 遗留镜像列 = WhatsApp 首选值（老面板兼容）
    expect(row.whatsapp_or_phone).toBe("+1 7871002002");
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

  it("splits verified social accounts into company columns on promote (0044 社媒拆列)", async () => {
    const { db, env } = await makeDb();
    db.prepare(
      `INSERT INTO customers (id, company_id, company_name, domain, lead_score, email, social_accounts_verified)
       VALUES (31, 'co31', 'Social Co', 'social.com', 70, 'x@social.com', ?)`,
    ).run(
      JSON.stringify([
        { platform: "Facebook", url: "https://facebook.com/socialco", verified: true },
        { platform: "linkedin", url: "https://linkedin.com/company/social-co", verified: true },
        { platform: "pinterest", url: "https://pinterest.com/socialco", verified: true },
      ]),
    );
    const r = await call(env, "POST", "/admin/api/crm/companies/promote", { customer_id: 31 });
    expect(r.status).toBe(201);
    const row = db.prepare("SELECT * FROM crm_companies WHERE id = 'c_31'").get() as any;
    // 已知平台按列拆入（平台名大小写不敏感）
    expect(row.facebook_url).toBe("https://facebook.com/socialco");
    expect(row.linkedin_url).toBe("https://linkedin.com/company/social-co");
    // 未知平台（pinterest 无对应列）静默忽略，其余社媒列保持 NULL
    expect(row.twitter_url).toBeNull();
    expect(row.instagram_url).toBeNull();
    expect(row.tiktok_url).toBeNull();
    expect(row.youtube_url).toBeNull();
  });

  it("promotes successfully even when social_accounts_verified is malformed JSON (fail-open)", async () => {
    const { db, env } = await makeDb();
    db.prepare(
      `INSERT INTO customers (id, company_id, company_name, domain, lead_score, email, social_accounts_verified)
       VALUES (32, 'co32', 'Bad Json Co', 'badjson.com', 70, 'x@badjson.com', '{"platform":')`,
    ).run();
    const r = await call(env, "POST", "/admin/api/crm/companies/promote", { customer_id: 32 });
    expect(r.status).toBe(201);
    const row = db.prepare("SELECT * FROM crm_companies WHERE id = 'c_32'").get() as any;
    expect(row.facebook_url).toBeNull();
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

  it("inherits the source domain after the source row is freed (UNIQUE domain)", async () => {
    // 生产事故回归：domain 是 UNIQUE 列，域名继承 UPDATE 若排在 DELETE
    // 来源之前，来源行还占着该域名时目标写入撞唯一约束 → 整批 500。
    const { db, env } = await makeDb();
    db.prepare(
      `INSERT INTO crm_companies (id, name, source)
       VALUES ('tgt_d', 'No Domain Co', 'csv_import'),
              ('src_d', 'Has Domain Co', 'csv_import')`,
    ).run();
    db.prepare(
      `UPDATE crm_companies SET domain = 'hasdomain.com' WHERE id = 'src_d'`,
    ).run();
    const merged = await call(env, "POST", "/admin/api/crm/companies/merge", {
      target_company_id: "tgt_d",
      source_company_id: "src_d",
    });
    expect(merged.status).toBe(200);
    const row = db.prepare("SELECT * FROM crm_companies WHERE id = 'tgt_d'").get() as any;
    expect(row.domain).toBe("hasdomain.com");
    expect(db.prepare("SELECT id FROM crm_companies WHERE id = 'src_d'").get()).toBeUndefined();
  });

  it("preserves source 0041 fields and remarks when merging (数据保全)", async () => {
    const { db, env } = await makeDb();
    // 目标：已有行业/地址，无编号/经销品牌/来源备注（0041 字段面板创建
    // 接口不收，直接 INSERT 构造）。
    db.prepare(
      `INSERT INTO crm_companies (id, name, domain, country, industry, address, chinese_remarks, source)
       VALUES ('tgt_1', 'Keep Co', 'keep.com', 'PR', 'Marine', 'Carr 1', '目标备注', 'csv_import')`,
    ).run();
    // 来源：有编号/经销品牌/中文备注，行业/地址为空
    db.prepare(
      `INSERT INTO crm_companies (id, name, external_id, dealer_brands, chinese_remarks, source)
       VALUES ('src_1', 'Dupe Co', 'PR-999', 'cressi, Garmin', '来源方重要备注', 'csv_import')`,
    ).run();
    const target = db.prepare("SELECT * FROM crm_companies WHERE id = 'tgt_1'").get() as any;
    const source = db.prepare("SELECT * FROM crm_companies WHERE id = 'src_1'").get() as any;

    const merged = await call(env, "POST", "/admin/api/crm/companies/merge", {
      target_company_id: target.id,
      source_company_id: source.id,
    });
    expect(merged.status).toBe(200);
    const row = db.prepare("SELECT * FROM crm_companies WHERE id = ?").get(target.id) as any;
    // 目标已有字段不被覆盖
    expect(row.industry).toBe("Marine");
    expect(row.address).toBe("Carr 1");
    // 来源非空、目标为空的字段回填保全
    expect(row.external_id).toBe("PR-999");
    expect(row.dealer_brands).toBe("cressi, Garmin");
    // 来源备注以 [并入备注] 追加保留
    expect(row.chinese_remarks).toContain("目标备注");
    expect(row.chinese_remarks).toContain("[合并]");
    expect(row.chinese_remarks).toContain("[并入备注] Dupe Co: 来源方重要备注");
  });

  it("backfills 0042 admin-parity fields and is_* flags when merging (只升不降)", async () => {
    const { db, env } = await makeDb();
    db.prepare(
      `INSERT INTO crm_companies (id, name, city, founded_year, is_retailer, source)
       VALUES ('tgt_p', 'Keep City Co', 'Rincón', '1995', 1, 'csv_import')`,
    ).run();
    db.prepare(
      `INSERT INTO crm_companies (id, name, legal_name, city, founded_year, is_manufacturer, is_retailer, source)
       VALUES ('src_p', 'Dupe City Co', 'Keep City LLC', 'Aguadilla', '1990s', 1, 0, 'csv_import')`,
    ).run();
    const merged = await call(env, "POST", "/admin/api/crm/companies/merge", {
      target_company_id: "tgt_p",
      source_company_id: "src_p",
    });
    expect(merged.status).toBe(200);
    const row = db.prepare("SELECT * FROM crm_companies WHERE id = 'tgt_p'").get() as any;
    // 目标已有字段不被覆盖
    expect(row.city).toBe("Rincón");
    expect(row.founded_year).toBe("1995");
    // 来源非空、目标为空 → 回填
    expect(row.legal_name).toBe("Keep City LLC");
    // is_* 数值特判：source=1 && target=0 → 升为 1
    expect(row.is_manufacturer).toBe(1);
    // 目标已有 1 不被来源 0 覆盖（只升不降）
    expect(row.is_retailer).toBe(1);
  });

  it("preserves social links when merging (0044 社媒保全)", async () => {
    const { db, env } = await makeDb();
    // 目标：已有 Facebook；来源：有 Instagram + 另一个 Facebook
    db.prepare(
      `INSERT INTO crm_companies (id, name, facebook_url, source)
       VALUES ('tgt_s', 'Keep Social Co', 'https://facebook.com/keep', 'csv_import')`,
    ).run();
    db.prepare(
      `INSERT INTO crm_companies (id, name, facebook_url, instagram_url, source)
       VALUES ('src_s', 'Dupe Social Co', 'https://facebook.com/dupe', 'https://instagram.com/dupe', 'csv_import')`,
    ).run();
    const merged = await call(env, "POST", "/admin/api/crm/companies/merge", {
      target_company_id: "tgt_s",
      source_company_id: "src_s",
    });
    expect(merged.status).toBe(200);
    const row = db.prepare("SELECT * FROM crm_companies WHERE id = 'tgt_s'").get() as any;
    // 目标已有社媒不被来源覆盖
    expect(row.facebook_url).toBe("https://facebook.com/keep");
    // 来源独有社媒回填保全
    expect(row.instagram_url).toBe("https://instagram.com/dupe");
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

  it("lists duplicate candidates by ≥2 criteria, strong name match, or contact overlap", async () => {
    const { db, env } = await makeDb();
    db.prepare(
      `INSERT INTO crm_companies (id, name, domain, source)
       VALUES ('dup_a', 'Kayaking Puerto Rico', 'kayakingpr.com', 'csv_import'),
              ('dup_b', 'Mini Boat Adventures', NULL, 'csv_import'),
              ('name_a', 'BOATS R US', 'boatsruspr.com', 'csv_import'),
              ('name_b', 'Boats R Us Corp', NULL, 'csv_import'),
              ('wk_a', 'Crashboat Surf & Skate', NULL, 'csv_import'),
              ('wk_b', 'Crashboat Surf Shop', NULL, 'csv_import'),
              ('solo', 'Solo Co', 'solo.com', 'csv_import')`,
    ).run();
    // dup_a/dup_b：同联系人（同邮箱+同电话）→ 电话/邮箱后缀/联系人重合 3 项
    for (const cid of ["dup_a", "dup_b"]) {
      await call(env, "POST", "/admin/api/crm/contacts", {
        company_id: cid,
        full_name: "Rick Morales",
        email: "rick@kayakingpr.com",
        whatsapp_or_phone: "787-555-0199",
      });
    }

    // 阶段一：名称强匹配（BOATS R US ⊂ Boats R Us Corp）单独入选；
    // 仅名称弱近似（Crashboat 对）1 项不入选
    const list1 = await call(env, "GET", "/admin/api/crm/companies/duplicates");
    expect(list1.status).toBe(200);
    let dups = list1.body.duplicates;
    expect(dups).toHaveLength(2);
    const dupPair = dups.find((d: any) => d.a_id === "dup_a");
    expect(dupPair.reasons).toEqual(["电话/WhatsApp", "邮箱后缀", "联系人重合"]);
    const namePair = dups.find((d: any) => d.a_id === "name_a");
    expect(namePair.reasons).toEqual(["名称包含"]);
    expect(JSON.stringify(dups)).not.toContain("wk_");

    // 阶段二：给 name_a/name_b 补相同地址 → 名称包含+地址近似
    db.prepare(
      `UPDATE crm_companies SET address = 'Carr 2, Rincón' WHERE id IN ('name_a','name_b')`,
    ).run();
    const list2 = await call(env, "GET", "/admin/api/crm/companies/duplicates");
    dups = list2.body.duplicates;
    expect(dups).toHaveLength(2);
    expect(dups.find((d: any) => d.a_id === "name_a").reasons).toEqual(["名称包含", "地址近似"]);

    // 阶段三：Crashboat 对补同联系人姓名 → 名称相似+联系人重合 2 项入选
    for (const cid of ["wk_a", "wk_b"]) {
      await call(env, "POST", "/admin/api/crm/contacts", {
        company_id: cid,
        full_name: "Juan Carlo",
      });
    }
    const list3 = await call(env, "GET", "/admin/api/crm/companies/duplicates");
    dups = list3.body.duplicates;
    expect(dups).toHaveLength(3);
    expect(dups.find((d: any) => d.a_id === "wk_a").reasons).toEqual(["名称相似", "联系人重合"]);

    // 免费邮箱后缀不算信号：给 solo 加 gmail 联系人，不产生任何配对
    await call(env, "POST", "/admin/api/crm/contacts", {
      company_id: "solo",
      full_name: "Someone Else",
      email: "someone@gmail.com",
    });
    const list4 = await call(env, "GET", "/admin/api/crm/companies/duplicates");
    expect(list4.body.duplicates).toHaveLength(3);
    expect(JSON.stringify(list4.body.duplicates)).not.toContain("solo");

    // 合并联系人重合对后该配对消失，其余对仍在
    const merged = await call(env, "POST", "/admin/api/crm/companies/merge", {
      target_company_id: "dup_a",
      source_company_id: "dup_b",
    });
    expect(merged.status).toBe(200);
    const after = await call(env, "GET", "/admin/api/crm/companies/duplicates");
    expect(after.body.duplicates).toHaveLength(2);
    expect(JSON.stringify(after.body.duplicates)).not.toContain("dup_b");
  });

  it("detects shared phones from the 0042 tel/cellphone/whatsapp columns (重复检测读新列)", async () => {
    const { db, env } = await makeDb();
    // 名字完全不同，唯一信号是联系人 whatsapp 新列（0042 回填后的老数据形态：
    // 新列有值、遗留 whatsapp_or_phone 为空）
    db.prepare(
      `INSERT INTO crm_companies (id, name, domain, source)
       VALUES ('ph_a', 'Aurora Marine', 'auroramarine.com', 'csv_import'),
              ('ph_b', 'Zephyr Trading', NULL, 'csv_import')`,
    ).run();
    db.prepare(
      `INSERT INTO crm_contacts (id, company_id, full_name, whatsapp)
       VALUES ('pc1', 'ph_a', 'Wa A', '+1 7877007001')`,
    ).run();
    db.prepare(
      `INSERT INTO crm_contacts (id, company_id, full_name, whatsapp)
       VALUES ('pc2', 'ph_b', 'Wa B', '+1 7877007001')`,
    ).run();
    const r = await call(env, "GET", "/admin/api/crm/companies/duplicates");
    expect(r.status).toBe(200);
    const pair = r.body.duplicates.find((d: any) => d.a_id === "ph_a" && d.b_id === "ph_b");
    expect(pair).toBeDefined();
    expect(pair.reasons).toContain("电话/WhatsApp");
    expect(pair.reasons).toContain("联系人重合");
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
    // 0038 ⑧：阶段推进 → 时间线 note + 自动下一步任务
    expect(acts).toHaveLength(2);
    const note = acts.find((a) => a.type === "note");
    expect(note.summary).toContain("inquiry");
    expect(note.summary).toContain("sample_quoted");
    expect(note.deal_id).toBe(dealId);
    const task = acts.find((a) => a.type === "task");
    expect(task.summary).toContain("跟进样品报价反馈");
    expect(task.due_date).toBe(
      new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
    );
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

  it("edits imported 0041 fields (address/external_id/dealer_brands) via PATCH", async () => {
    const { db, env } = await makeDb();
    db.prepare(
      `INSERT INTO crm_companies (id, name, address, external_id, dealer_brands, source)
       VALUES ('imp_1', 'Imported Co', 'Carr 3, Aguadilla', 'PR-001', 'cressi, Garmin', 'csv_import')`,
    ).run();
    const r = await call(env, "PATCH", "/admin/api/crm/companies/imp_1", {
      name: "Imported Co PR",
      address: "Carr 2 Km 12, Rincón",
      dealer_brands: "garmin, starboard",
    });
    expect(r.status).toBe(200);
    expect(r.body.company.name).toBe("Imported Co PR");
    expect(r.body.company.address).toBe("Carr 2 Km 12, Rincón");
    expect(r.body.company.dealer_brands).toBe("garmin, starboard");
    // 未提交的字段不动
    expect(r.body.company.external_id).toBe("PR-001");

    // 清空导入字段：空串 → NULL
    const cleared = await call(env, "PATCH", "/admin/api/crm/companies/imp_1", {
      external_id: "",
      address: "",
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.company.external_id).toBeNull();
    expect(cleared.body.company.address).toBeNull();

    const row = db.prepare("SELECT * FROM crm_companies WHERE id = 'imp_1'").get() as any;
    expect(row.name).toBe("Imported Co PR");
  });

  it("edits 0042 admin-parity fields (city/legal_name/founded_year/is_* booleans) via PATCH", async () => {
    const { env } = await makeDb();
    const created = await call(env, "POST", "/admin/api/crm/companies", { name: "Parity Co" });
    expect(created.status).toBe(201);
    const id = created.body.company.id;
    const r = await call(env, "PATCH", `/admin/api/crm/companies/${id}`, {
      legal_name: "Parity LLC",
      trading_name: "Parity Trading",
      city: "San Juan",
      zip_city: "00901 San Juan",
      postal_code: "00901",
      country_code: "PR",
      products_services: "Surfboards, SUP",
      company_type: "Retailer",
      business_model: "B2C",
      founded_year: "1990s",
      employee_range: "10-50",
      target_markets: "Caribbean",
      is_manufacturer: true,
      is_retailer: true,
    });
    expect(r.status).toBe(200);
    expect(r.body.company.legal_name).toBe("Parity LLC");
    expect(r.body.company.zip_city).toBe("00901 San Juan");
    expect(r.body.company.founded_year).toBe("1990s");
    expect(r.body.company.products_services).toBe("Surfboards, SUP");
    expect(r.body.company.is_manufacturer).toBe(1);
    expect(r.body.company.is_retailer).toBe(1);
    expect(r.body.company.is_oem).toBe(0);

    // 关闭勾选 / 空串清空
    const off = await call(env, "PATCH", `/admin/api/crm/companies/${id}`, {
      is_retailer: false,
      city: "",
    });
    expect(off.status).toBe(200);
    expect(off.body.company.is_retailer).toBe(0);
    expect(off.body.company.is_manufacturer).toBe(1);
    expect(off.body.company.city).toBeNull();
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

/* ── 联系人电话三列 (0042) ──────────────────────────────────────────────── */

describe("联系人电话三列 (0042)", () => {
  it("creates a contact with tel/cellphone/whatsapp kept separate (mirror in legacy column)", async () => {
    const { env } = await makeDb();
    await call(env, "POST", "/admin/api/crm/companies", { name: "Phone Co" });
    const company = (await call(env, "GET", "/admin/api/crm/companies")).body.companies[0];
    const r = await call(env, "POST", "/admin/api/crm/contacts", {
      company_id: company.id,
      full_name: "Tres Telefonos",
      tel: "+1 787-200-3000",
      cellphone: "+1 787-200-3001",
      whatsapp: "+1 7872003002",
    });
    expect(r.status).toBe(201);
    expect(r.body.contact.tel).toBe("+1 787-200-3000");
    expect(r.body.contact.cellphone).toBe("+1 787-200-3001");
    expect(r.body.contact.whatsapp).toBe("+1 7872003002");
    // 遗留列镜像 WhatsApp（老面板兼容）
    expect(r.body.contact.whatsapp_or_phone).toBe("+1 7872003002");

    // PATCH 手机号 → 手机列更新，WhatsApp/固定电话不动，镜像跟随 WhatsApp
    const patched = await call(env, "PATCH", `/admin/api/crm/contacts/${r.body.contact.id}`, {
      cellphone: "+1 787-999-8888",
    });
    expect(patched.status).toBe(200);
    expect(patched.body.contact.cellphone).toBe("+1 787-999-8888");
    expect(patched.body.contact.whatsapp).toBe("+1 7872003002");
    expect(patched.body.contact.tel).toBe("+1 787-200-3000");
    expect(patched.body.contact.whatsapp_or_phone).toBe("+1 7872003002");
  });

  it("still accepts the legacy whatsapp_or_phone key (老缓存面板兼容 → 写入 whatsapp)", async () => {
    const { env } = await makeDb();
    await call(env, "POST", "/admin/api/crm/companies", { name: "Legacy Co" });
    const company = (await call(env, "GET", "/admin/api/crm/companies")).body.companies[0];
    const r = await call(env, "POST", "/admin/api/crm/contacts", {
      company_id: company.id,
      full_name: "Legacy Panel",
      whatsapp_or_phone: "+1 787-300-4000",
    });
    expect(r.status).toBe(201);
    expect(r.body.contact.whatsapp).toBe("+1 787-300-4000");
    expect(r.body.contact.whatsapp_or_phone).toBe("+1 787-300-4000");

    // PATCH 遗留键 → whatsapp 跟随 + 镜像同步
    const patched = await call(env, "PATCH", `/admin/api/crm/contacts/${r.body.contact.id}`, {
      whatsapp_or_phone: "+1 787-500-6000",
    });
    expect(patched.status).toBe(200);
    expect(patched.body.contact.whatsapp).toBe("+1 787-500-6000");
    expect(patched.body.contact.whatsapp_or_phone).toBe("+1 787-500-6000");
  });

  it("merges contacts keeping tel/cellphone/whatsapp each intact (三列各自保全)", async () => {
    const { env } = await makeDb();
    await call(env, "POST", "/admin/api/crm/companies", { name: "Merge Phones Co" });
    const company = (await call(env, "GET", "/admin/api/crm/companies")).body.companies[0];
    const target = await call(env, "POST", "/admin/api/crm/contacts", {
      company_id: company.id,
      full_name: "Target Person",
      cellphone: "+1 787-111-0001",
    });
    const source = await call(env, "POST", "/admin/api/crm/contacts", {
      company_id: company.id,
      full_name: "Source Person",
      tel: "+1 787-111-0002",
      whatsapp: "+1 7871110003",
    });
    const merged = await call(env, "POST", "/admin/api/crm/contacts/merge", {
      target_contact_id: target.body.contact.id,
      source_contact_id: source.body.contact.id,
    });
    expect(merged.status).toBe(200);
    // 三列各自独立保全、互不覆盖（0042 前「只保一个号」的痛点）
    expect(merged.body.contact.cellphone).toBe("+1 787-111-0001");
    expect(merged.body.contact.tel).toBe("+1 787-111-0002");
    expect(merged.body.contact.whatsapp).toBe("+1 7871110003");
    // 遗留镜像列 COALESCE 目标值优先（目标建联系人时镜像了自己的手机号）
    expect(merged.body.contact.whatsapp_or_phone).toBe("+1 787-111-0001");
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
