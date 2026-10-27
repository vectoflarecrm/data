import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { handleCrmApi, nextStepTaskFor } from "../src/crm";
import { escapeIcsText } from "../src/crm-calendar";
import type { AdminAuthContext, AdminEnv } from "../src/admin";

/* 阶段五（更新.txt ⑤⑧，migration 0038）HTTP 层：任务日历
 * （月视图 / 逾期 / 今日待办 / ICS 订阅源）+ 阶段推进自动下一步任务
 * + 任务负责人（crm_activities.owner）。 */

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

/** 0038 对齐 schema（crm_activities.owner / crm_companies.source）。 */
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

async function callRaw(env: AdminEnv, method: string, path: string, body?: unknown) {
  return handleCrmApi(req(method, path, body), env, AUTH);
}

async function call(env: AdminEnv, method: string, path: string, body?: unknown) {
  const res = await callRaw(env, method, path, body);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function seedCompany(env: AdminEnv, id: string, name = `公司 ${id}`, tier = "B") {
  const r = await call(env, "POST", "/admin/api/crm/companies", {
    name, domain: `${id}.example.com`, tier,
  });
  expect(r.status).toBe(201);
  return r.body.company as { id: string; name: string };
}

function makeEnv(): { db: any; env: AdminEnv } {
  const db = makeDb();
  return { db, env: { DB: new FakeD1(db) } as unknown as AdminEnv };
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ── ⑧ nextStepTaskFor / escapeIcsText 单元测试 ─────────────────────────── */

describe("⑧ nextStepTaskFor", () => {
  it("各阶段生成对应文案与偏移天数", () => {
    expect(nextStepTaskFor("inquiry", "桨板")).toBeNull();
    expect(nextStepTaskFor("lost", "桨板")).toBeNull();
    expect(nextStepTaskFor("sample_quoted", "桨板首单")).toEqual({
      summary: "跟进样品报价反馈：商机「桨板首单」",
      dueOffsetDays: 3,
    });
    expect(nextStepTaskFor("pi_sent", "桨板首单")).toMatchObject({ dueOffsetDays: 3 });
    expect(nextStepTaskFor("deposit_paid", "桨板首单")).toMatchObject({ dueOffsetDays: 5 });
    expect(nextStepTaskFor("won", "桨板首单")).toMatchObject({ dueOffsetDays: 7 });
  });
});

describe("⑧ escapeIcsText", () => {
  it("转义反斜杠/分号/逗号/换行（RFC 5545 TEXT）", () => {
    expect(escapeIcsText("a,b;c\\d")).toBe("a\\,b\\;c\\\\d");
    expect(escapeIcsText("第一行\n第二行")).toBe("第一行\\n第二行");
    expect(escapeIcsText("普通文本")).toBe("普通文本");
  });
});

/* ── ⑧ 任务日历月视图 ───────────────────────────────────────────────────── */

describe("⑧ 任务日历 API", () => {
  it("月视图：今日/逾期/负责人/计数；已完成与无期限任务不出现", async () => {
    const { env } = makeEnv();
    const c = await seedCompany(env, "c_1", "Acme Marine", "A");
    const today = isoDaysFromNow(0);

    // 今日任务（带负责人）
    const t1 = await call(env, "POST", "/admin/api/crm/activities", {
      company_id: c.id, type: "task", summary: "今日跟进定金", due_date: today, owner: "小王",
    });
    expect(t1.status).toBe(201);
    // 逾期任务（2 天前）
    await call(env, "POST", "/admin/api/crm/activities", {
      company_id: c.id, type: "task", summary: "逾期未跟", due_date: isoDaysFromNow(-2),
    });
    // 已完成任务 + 无期限任务 → 不进日历
    await call(env, "POST", "/admin/api/crm/activities", {
      company_id: c.id, type: "task", summary: "已完成的任务", due_date: today, owner: "小李",
    }).then(async (r) => {
      await call(env, "PATCH", `/admin/api/crm/activities/${r.body.activity.id}`, { is_completed: true });
    });
    await call(env, "POST", "/admin/api/crm/activities", {
      company_id: c.id, type: "task", summary: "无期限任务",
    });

    const r = await call(env, "GET", "/admin/api/crm/calendar");
    expect(r.status).toBe(200);
    expect(r.body.month).toBe(today.slice(0, 7));
    expect(r.body.counts).toMatchObject({ overdue: 1, today: 1 });
    // 跨月边界（月初运行时逾期任务落在上月）→ 至少含今日任务
    expect(Number(r.body.counts.month_open)).toBeGreaterThanOrEqual(1);

    const overdue = r.body.overdue as any[];
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toMatchObject({ summary: "逾期未跟", overdue_days: 2, tier: "A", owner: null });

    const todayTasks = r.body.today_tasks as any[];
    expect(todayTasks).toHaveLength(1);
    expect(todayTasks[0]).toMatchObject({ summary: "今日跟进定金", owner: "小王", company_name: "Acme Marine" });

    const days = r.body.days as Record<string, any[]>;
    expect(Array.isArray(days[today])).toBe(true);
    expect(days[today].some((t) => t.summary === "今日跟进定金")).toBe(true);
  });

  it("month 参数：合法月份返回该月；非法回退当前月", async () => {
    const { env } = makeEnv();
    const c = await seedCompany(env, "c_1");
    await call(env, "POST", "/admin/api/crm/activities", {
      company_id: c.id, type: "task", summary: "今日任务", due_date: isoDaysFromNow(0),
    });

    const past = await call(env, "GET", "/admin/api/crm/calendar?month=2020-01");
    expect(past.body.month).toBe("2020-01");
    expect(past.body.days).toEqual({});
    // 今日到期 → 逾期 0、今日 1、2020-01 月内 0
    expect(past.body.counts).toMatchObject({ month_open: 0, overdue: 0, today: 1 });

    const bad = await call(env, "GET", "/admin/api/crm/calendar?month=2020-13");
    expect(bad.body.month).toBe(isoDaysFromNow(0).slice(0, 7));
  });
});

/* ── ⑧ ICS 订阅源 ───────────────────────────────────────────────────────── */

describe("⑧ ICS 订阅源", () => {
  it("RFC 5545：CRLF 行尾 + VEVENT + DTSTART 日期格式 + TEXT 转义", async () => {
    const { env } = makeEnv();
    const c = await seedCompany(env, "c_1", "Acme, Co; Ltd");
    const created = await call(env, "POST", "/admin/api/crm/activities", {
      company_id: c.id, type: "task", summary: "跟进 PI 确认", due_date: isoDaysFromNow(3), owner: "小王",
    });
    const id = created.body.activity.id as string;

    const res = await callRaw(env, "GET", "/admin/api/crm/calendar.ics");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/calendar");
    const text = await res.text();

    expect(text).toContain("BEGIN:VCALENDAR");
    expect(text).toContain("END:VCALENDAR");
    expect(text).toContain("VERSION:2.0");
    expect(text).toContain("\r\n");
    expect(text).toContain(`UID:${id}@vectoflarecrm`);
    expect(text).toContain(`DTSTART;VALUE=DATE:${isoDaysFromNow(3).replace(/-/g, "")}`);
    // 公司名含逗号/分号 → RFC 5545 转义
    expect(text).toContain("Acme\\, Co\\; Ltd");
    expect(text).toContain("跟进 PI 确认");
  });

  it("无任务时输出空日历骨架", async () => {
    const { env } = makeEnv();
    const res = await callRaw(env, "GET", "/admin/api/crm/calendar.ics");
    const text = await res.text();
    expect(text).toContain("BEGIN:VCALENDAR");
    expect(text).not.toContain("BEGIN:VEVENT");
  });
});

/* ── ⑧ 阶段推进自动下一步任务 + 负责人 ─────────────────────────────────── */

describe("⑧ 自动下一步任务与负责人", () => {
  it("阶段推进 sample_quoted → 自动建任务；回退再推进不重复（dup guard）", async () => {
    const { db, env } = makeEnv();
    const c = await seedCompany(env, "c_1");
    const dl = await call(env, "POST", "/admin/api/crm/deals", { company_id: c.id, title: "桨板首单" });
    const dealId = dl.body.deal.id as string;

    await call(env, "PATCH", `/admin/api/crm/deals/${dealId}`, { stage: "sample_quoted" });
    const openTasks = () =>
      db
        .prepare(
          "SELECT id, due_date, owner FROM crm_activities WHERE type = 'task' AND is_completed = 0 AND summary = ?",
        )
        .all("跟进样品报价反馈：商机「桨板首单」");
    const first = openTasks();
    expect(first).toHaveLength(1);
    // 到期 = 今天 + 3 天
    expect(first[0].due_date).toBe(isoDaysFromNow(3));

    // 回退 inquiry（不生成任务），再次推进 → dup guard 生效
    await call(env, "PATCH", `/admin/api/crm/deals/${dealId}`, { stage: "inquiry" });
    await call(env, "PATCH", `/admin/api/crm/deals/${dealId}`, { stage: "sample_quoted" });
    expect(openTasks()).toHaveLength(1);
  });

  it("owner：任务创建/改派；非任务类型带 owner → 400", async () => {
    const { env } = makeEnv();
    const c = await seedCompany(env, "c_1");
    const created = await call(env, "POST", "/admin/api/crm/activities", {
      company_id: c.id, type: "task", summary: "任务A", due_date: isoDaysFromNow(1), owner: "小王",
    });
    expect(created.body.activity.owner).toBe("小王");

    const reassigned = await call(env, "PATCH", `/admin/api/crm/activities/${created.body.activity.id}`, {
      owner: "小李",
    });
    expect(reassigned.body.activity.owner).toBe("小李");

    const note = await call(env, "POST", "/admin/api/crm/activities", {
      company_id: c.id, type: "note", summary: "备注", owner: "小王",
    });
    expect(note.status).toBe(400);

    const badPatch = await call(env, "PATCH", `/admin/api/crm/activities/${created.body.activity.id}`, {
      owner: "",
    });
    expect(badPatch.status).toBe(200);
    expect(badPatch.body.activity.owner).toBeNull();
  });
});
