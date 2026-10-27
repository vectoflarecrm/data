import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { handleCrmApi } from "../src/crm";
import type { AdminAuthContext, AdminEnv } from "../src/admin";

/* 阶段五（更新.txt ⑤⑧，migration 0038）HTTP 层：来源 ROI 归因
 * （五维聚合 + win_rate/平均周期 + 序列维度）、来源打标与人工修正。 */

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

/** 0038 对齐 schema（crm_companies.source / crm_activities.owner）。 */
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
    CREATE TABLE crm_sequences (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, brand_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE crm_sequence_steps (
      id TEXT PRIMARY KEY,
      sequence_id TEXT NOT NULL REFERENCES crm_sequences(id) ON DELETE CASCADE,
      step_no INTEGER NOT NULL, day_offset INTEGER NOT NULL DEFAULT 0,
      subject TEXT NOT NULL, body TEXT NOT NULL,
      UNIQUE(sequence_id, step_no)
    );
    CREATE TABLE crm_sequence_enrollments (
      id TEXT PRIMARY KEY,
      sequence_id TEXT NOT NULL REFERENCES crm_sequences(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
      contact_id TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
      contact_email TEXT NOT NULL, current_step INTEGER NOT NULL DEFAULT 0,
      next_due_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','stopped')),
      stop_reason TEXT, send_failures INTEGER NOT NULL DEFAULT 0,
      enrolled_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(sequence_id, contact_email)
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

async function seedCompany(env: AdminEnv, id: string, extra: Record<string, unknown> = {}) {
  const r = await call(env, "POST", "/admin/api/crm/companies", {
    name: `公司 ${id}`,
    domain: `${id}.example.com`,
    ...extra,
  });
  expect(r.status).toBe(201);
  return r.body.company as { id: string; name: string; source: string };
}

function makeEnv(): { db: any; env: AdminEnv } {
  const db = makeDb();
  return { db, env: { DB: new FakeD1(db) } as unknown as AdminEnv };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ── ⑤ 来源打标（创建路径）与人工修正 ───────────────────────────────────── */

describe("⑤ 来源打标与修正", () => {
  it("手工创建 → source='manual'；PATCH 可修正来源；非法来源 400", async () => {
    const { env } = makeEnv();
    const c = await seedCompany(env, "c_1");
    expect(c.source).toBe("manual");

    const fixed = await call(env, "PATCH", `/admin/api/crm/companies/${c.id}`, { source: "referral" });
    expect(fixed.status).toBe(200);
    expect(fixed.body.company.source).toBe("referral");

    const bad = await call(env, "PATCH", `/admin/api/crm/companies/${c.id}`, { source: "youtube" });
    expect(bad.status).toBe(400);
  });
});

/* ── ⑤ 五维 ROI 归因 ────────────────────────────────────────────────────── */

describe("⑤ ROI 归因 API", () => {
  it("来源/国家/行业/角色四维聚合 + win_rate + 营收 + 平均周期", async () => {
    const { db, env } = makeEnv();
    const c = await seedCompany(env, "c_1", { country: "US", industry: "Marine" });
    await call(env, "PATCH", `/admin/api/crm/companies/${c.id}`, { source: "referral", tier: "A" });
    await call(env, "POST", "/admin/api/crm/contacts", {
      company_id: c.id, full_name: "张三", job_title: "采购总监",
    });
    const dl = await call(env, "POST", "/admin/api/crm/deals", {
      company_id: c.id, title: "桨板首单", amount: 1200.5,
    });
    const dealId = dl.body.deal.id as string;
    // 固定商机创建时间 → 赢单周期 = 2026-01-01 → 赢单日的正天数
    db.prepare("UPDATE crm_deals SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(dealId);
    await call(env, "PATCH", `/admin/api/crm/deals/${dealId}`, { stage: "sample_quoted" });
    await call(env, "PATCH", `/admin/api/crm/deals/${dealId}`, { stage: "won" });
    // 一封来信 → 回复数 1（type 由服务器产生，测试直接落库）
    db.prepare(
      "INSERT INTO crm_activities (id, company_id, type, summary) VALUES ('a_mail', ?, 'email_received', 'Re: quote')",
    ).run(c.id);

    const r = await call(env, "GET", "/admin/api/crm/attribution");
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(true);

    const src = (r.body.sources as any[]).find((x) => x.dim === "referral");
    expect(src).toMatchObject({
      companies: 1, contacts: 1, replies: 1, deals: 1, quoted: 1, won: 1,
      revenue: 1200.5, win_rate: 100,
    });
    expect(src.avg_cycle_days).not.toBeNull();
    expect(Number(src.avg_cycle_days)).toBeGreaterThan(0);

    // 国家 / 行业 / 角色维度
    const ctry = (r.body.countries as any[]).find((x) => x.dim === "US");
    expect(ctry).toMatchObject({ companies: 1, won: 1 });
    const ind = (r.body.industries as any[]).find((x) => x.dim === "Marine");
    expect(ind).toMatchObject({ companies: 1 });
    const role = (r.body.roles as any[]).find((x) => x.dim === "procurement");
    expect(role).toMatchObject({ companies: 1, won: 1 });

    // 空维度兜底
    expect(Array.isArray(r.body.sequences)).toBe(true);
  });

  it("序列维度：报名/状态计数 + 公司漏斗；无报名公司不计入", async () => {
    const { db, env } = makeEnv();
    const c = await seedCompany(env, "c_1");
    db.prepare("INSERT INTO crm_sequences (id, name, brand_name) VALUES ('seq_1', '冷启动序列', 'BrandX')").run();
    db.prepare(
      `INSERT INTO crm_sequence_enrollments (id, sequence_id, company_id, contact_email, next_due_at, status)
       VALUES ('enr_1', 'seq_1', ?, 'a@b.com', '2026-01-01', 'active')`,
    ).run(c.id);

    const r = await call(env, "GET", "/admin/api/crm/attribution");
    const seq = (r.body.sequences as any[]).find((x) => x.dim === "seq_1");
    expect(seq).toMatchObject({
      label: "冷启动序列", companies: 1, enrolled: 1, active: 1, stopped: 0, completed: 0,
    });
  });

  it("排序按营收降序；输单/归档商机不计入 deals/quoted", async () => {
    const { env } = makeEnv();
    const c1 = await seedCompany(env, "c_1");
    const c2 = await seedCompany(env, "c_2");
    // c_1 赢单 5000；c_2 输单
    const d1 = await call(env, "POST", "/admin/api/crm/deals", { company_id: c1.id, title: "大单", amount: 5000 });
    await call(env, "PATCH", `/admin/api/crm/deals/${d1.body.deal.id}`, { stage: "won" });
    const d2 = await call(env, "POST", "/admin/api/crm/deals", { company_id: c2.id, title: "输单", amount: 900 });
    await call(env, "PATCH", `/admin/api/crm/deals/${d2.body.deal.id}`, { stage: "lost", lost_reason: "价格" });

    const r = await call(env, "GET", "/admin/api/crm/attribution");
    const srcs = r.body.sources as any[];
    // 手工来源两家都算公司数，但营收排序下带赢单的排最前
    const manual = srcs.find((x) => x.dim === "manual");
    expect(manual).toMatchObject({ companies: 2, won: 1, revenue: 5000 });
    // 输单商机：deals 排除 lost、quoted 不含 lost
    expect(manual.deals).toBe(1);
    expect(manual.quoted).toBe(1);
  });

  it("0038 未应用（无 source 列）→ fail-open available:false", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`
      CREATE TABLE crm_companies (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT UNIQUE, industry TEXT,
        country TEXT, tier TEXT DEFAULT 'unqualified', lead_status TEXT DEFAULT 'new',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE crm_contacts (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
        full_name TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE crm_deals (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
        title TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE crm_activities (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
        type TEXT, summary TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE crm_sequences (id TEXT PRIMARY KEY, name TEXT NOT NULL, brand_name TEXT NOT NULL);
      CREATE TABLE crm_sequence_enrollments (
        id TEXT PRIMARY KEY, sequence_id TEXT NOT NULL, company_id TEXT NOT NULL,
        contact_email TEXT NOT NULL, next_due_at TEXT NOT NULL, status TEXT NOT NULL
      );
    `);
    const env = { DB: new FakeD1(db) } as unknown as AdminEnv;
    const r = await call(env, "GET", "/admin/api/crm/attribution");
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(false);
    expect(r.body.sources).toEqual([]);
    expect(r.body.sequences).toEqual([]);
  });
});
