import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AdminEnv } from "../src/admin";
import {
  createSequenceInDb,
  enrollInSequence,
  listEnrollmentsFor,
  listSequencesWithCounts,
  renderSequenceTemplate,
  runSequenceTick,
  setEnrollmentStatusInDb,
  setSequenceEnabledInDb,
} from "../src/sequences";

/* 多步销售序列引擎（更新.txt 第 3 项）：CRUD 校验、入册去重/重新入册、
 * tick 推进（发送 → 锚定日程、回复终止、退订终止、失败重试→连续失败停止、
 * 完成收敛、停用序列延后）。fetch 全程 mock，不触网。 */

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

function makeDb(): any {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE crm_companies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT UNIQUE, industry TEXT,
      country TEXT, tier TEXT DEFAULT 'unqualified', lead_status TEXT DEFAULT 'new',
      merged_from_ids TEXT, chinese_remarks TEXT, customer_since TEXT,
      do_not_contact INTEGER DEFAULT 0,
      domain_email_status TEXT NOT NULL DEFAULT 'pending',
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
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE crm_activities (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
      deal_id TEXT, type TEXT DEFAULT 'manual_note', summary TEXT NOT NULL,
      due_date TEXT, is_completed INTEGER DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE crm_sequences (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, brand_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE crm_sequence_steps (
      id TEXT PRIMARY KEY,
      sequence_id TEXT NOT NULL REFERENCES crm_sequences(id) ON DELETE CASCADE,
      step_no INTEGER NOT NULL,
      day_offset INTEGER NOT NULL DEFAULT 0,
      subject TEXT NOT NULL, body TEXT NOT NULL,
      UNIQUE(sequence_id, step_no)
    );
    CREATE TABLE crm_sequence_enrollments (
      id TEXT PRIMARY KEY,
      sequence_id TEXT NOT NULL REFERENCES crm_sequences(id) ON DELETE CASCADE,
      company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
      contact_id TEXT REFERENCES crm_contacts(id) ON DELETE SET NULL,
      contact_email TEXT NOT NULL,
      current_step INTEGER NOT NULL DEFAULT 0,
      next_due_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','stopped')),
      stop_reason TEXT,
      send_failures INTEGER NOT NULL DEFAULT 0,
      enrolled_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(sequence_id, contact_email)
    );
    CREATE INDEX idx_seq_enrollments_due ON crm_sequence_enrollments(status, next_due_at);
    CREATE TABLE outreach_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER, company_id TEXT, display_id TEXT, company_name TEXT,
      email_to TEXT, product_category TEXT, brand_name TEXT,
      subject TEXT, body TEXT, status TEXT DEFAULT 'draft', sent_at TIMESTAMP,
      idempotency_key TEXT, send_attempts INTEGER NOT NULL DEFAULT 0,
      locked_at TEXT, locked_by TEXT, last_error TEXT, gmail_message_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE outreach_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_name TEXT NOT NULL UNIQUE, product_category TEXT NOT NULL,
      sender_email TEXT, sender_name TEXT, company_entity TEXT, signature TEXT,
      gmail_account TEXT, enabled INTEGER DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE gmail_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT, credential_type TEXT,
      client_email TEXT NOT NULL UNIQUE, private_key TEXT NOT NULL,
      delegated_domain TEXT, daily_limit INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
      last_error TEXT, cooldown_until TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE gmail_send_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, outreach_email_id INTEGER,
      recipient TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'sent',
      detail TEXT, sender_client_email TEXT, request_id TEXT,
      sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE gmail_send_reservations (
      id TEXT PRIMARY KEY, gmail_account_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, reserved_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'reserved',
      outreach_email_id INTEGER
    );
  `);
  return db;
}

function makeEnv(db: any): AdminEnv {
  return {
    DB: new FakeD1(db),
    GMAIL_OAUTH_CLIENT_ID: "test-client-id",
    GMAIL_OAUTH_CLIENT_SECRET: "test-secret",
  } as unknown as AdminEnv;
}

function seedCompany(db: any, id = "co1"): void {
  db.prepare("INSERT INTO crm_companies (id, name, domain, country) VALUES (?, 'Acme Paddle Co', ?, 'USA')")
    .run(id, `dom-${id}.com`);
}

function seedContact(db: any, id: string, companyId: string, email: string, primary = false): void {
  db.prepare("INSERT INTO crm_contacts (id, company_id, full_name, email, is_primary) VALUES (?, ?, ?, ?, ?)")
    .run(id, companyId, "John Doe", email, primary ? 1 : 0);
}

/** 序列 + 步骤 + 品牌发信配置 + 一个 oauth_refresh 发信账号。 */
async function seedSequence(
  db: any,
  steps: Array<{ day_offset: number; subject: string; body: string }>,
): Promise<string> {
  db.prepare("INSERT INTO gmail_accounts (label, credential_type, client_email, private_key) VALUES ('t', 'oauth_refresh', 'sales@brand.com', 'rt-token')").run();
  db.prepare("INSERT INTO outreach_settings (brand_name, product_category, sender_email, sender_name, gmail_account, enabled) VALUES ('BrandA', 'cat', 'sales@brand.com', 'Toby', 'sales@brand.com', 1)").run();
  const created = await createSequenceInDb(makeEnv(db), { name: "三步开发", brand_name: "BrandA", steps });
  return created.id;
}

interface Route {
  match: (url: string) => boolean;
  status?: number;
  body: unknown;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

function stubFetch(routes: Route[]) {
  const fn = vi.fn(async (input: unknown) => {
    const url = String(input);
    for (const r of routes) {
      if (r.match(url)) {
        return new Response(
          typeof r.body === "string" ? r.body : JSON.stringify(r.body),
          { status: r.status ?? 200, headers: { "Content-Type": "application/json" } },
        );
      }
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderSequenceTemplate", () => {
  it("renders all placeholders and leaves unknown ones untouched", () => {
    const out = renderSequenceTemplate(
      "Hi {{contact_name}} from {{company}} ({{country}}, {{domain}}) — {{sender_name}} / {{other}}",
      { company: "Acme", contact_name: "John", country: "USA", domain: "acme.com", sender_name: "Toby" },
    );
    expect(out).toBe("Hi John from Acme (USA, acme.com) — Toby / {{other}}");
  });
});

describe("sequence CRUD", () => {
  it("creates a sequence with steps sorted by day_offset", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const { id, steps } = await createSequenceInDb(env, {
      name: "S",
      brand_name: "BrandA",
      steps: [
        { day_offset: 3, subject: "Follow-up", body: "B2" },
        { day_offset: 0, subject: "Intro", body: "B1" },
      ],
    });
    expect(steps).toBe(2);
    const rows = db.prepare("SELECT step_no, day_offset, subject FROM crm_sequence_steps WHERE sequence_id = ? ORDER BY step_no").all(id);
    expect(rows.map((r: any) => r.subject)).toEqual(["Intro", "Follow-up"]);
    expect(rows.map((r: any) => r.day_offset)).toEqual([0, 3]);
  });

  it("rejects invalid step payloads (empty / out-of-range day_offset / long subject)", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    await expect(createSequenceInDb(env, { name: "S", brand_name: "B", steps: [] })).rejects.toThrow(/至少 1 步/);
    await expect(createSequenceInDb(env, {
      name: "S", brand_name: "B",
      steps: [{ day_offset: 91, subject: "x", body: "y" }],
    })).rejects.toThrow(/day_offset/);
    await expect(createSequenceInDb(env, {
      name: "S", brand_name: "B",
      steps: [{ day_offset: 0, subject: "x".repeat(201), body: "y" }],
    })).rejects.toThrow(/subject/);
  });

  it("toggles enabled and lists sequences with counts", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const id = await seedSequence(db, [{ day_offset: 0, subject: "Hi {{company}}", body: "Hello {{contact_name}}" }]);
    seedCompany(db);
    seedContact(db, "ct1", "co1", "buyer@acme.com", true);
    await enrollInSequence(env, id, "co1", {});

    const res = await listSequencesWithCounts(env);
    const body = await res.json() as { sequences: Array<{ id: string; enabled: number; step_count: number; active_count: number; total_count: number; steps: unknown[] }> };
    expect(body.sequences).toHaveLength(1);
    expect(body.sequences[0]).toMatchObject({ enabled: 1, step_count: 1, active_count: 1, total_count: 1 });
    expect(body.sequences[0].steps).toHaveLength(1);

    await setSequenceEnabledInDb(env, id, false);
    const row = db.prepare("SELECT enabled FROM crm_sequences WHERE id = ?").get(id) as any;
    expect(row.enabled).toBe(0);
    await expect(setSequenceEnabledInDb(env, "missing", true)).rejects.toThrow(/不存在/);
  });
});

describe("enrollInSequence", () => {
  it("picks the primary contact by default and blocks duplicate active enrollment", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const id = await seedSequence(db, [{ day_offset: 0, subject: "Hi", body: "Hello" }]);
    seedCompany(db);
    seedContact(db, "ct1", "co1", "secondary@acme.com", false);
    seedContact(db, "ct2", "co1", "primary@acme.com", true);

    const { enrollment, reEnrolled } = await enrollInSequence(env, id, "co1", {});
    expect(reEnrolled).toBe(false);
    expect(enrollment.contact_email).toBe("primary@acme.com");

    await expect(enrollInSequence(env, id, "co1", {})).rejects.toThrow(/已在此序列中/);
    // 时间线有入册备注。
    const notes = db.prepare("SELECT summary FROM crm_activities WHERE type = 'note'").all() as any[];
    expect(notes[0].summary).toContain("加入销售序列");
  });

  it("re-enrolls a stopped enrollment from step 0 with a fresh schedule", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const id = await seedSequence(db, [{ day_offset: 0, subject: "Hi", body: "Hello" }]);
    seedCompany(db);
    seedContact(db, "ct1", "co1", "buyer@acme.com", true);
    const first = await enrollInSequence(env, id, "co1", {});
    await setEnrollmentStatusInDb(env, first.enrollment.id, "stopped", "测试终止");
    // 推进 current_step 模拟执行过一步，重新入册必须归零。
    db.prepare("UPDATE crm_sequence_enrollments SET current_step = 1 WHERE id = ?").run(first.enrollment.id);

    const second = await enrollInSequence(env, id, "co1", {});
    expect(second.reEnrolled).toBe(true);
    expect(second.enrollment.id).toBe(first.enrollment.id);
    const row = db.prepare("SELECT current_step, status, stop_reason, send_failures FROM crm_sequence_enrollments WHERE id = ?").get(first.enrollment.id) as any;
    expect(row).toMatchObject({ current_step: 0, status: "active", stop_reason: null, send_failures: 0 });
  });

  it("rejects disabled sequences and companies without an emailed contact", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const id = await seedSequence(db, [{ day_offset: 0, subject: "Hi", body: "Hello" }]);
    await setSequenceEnabledInDb(env, id, false);
    seedCompany(db);
    seedContact(db, "ct1", "co1", "buyer@acme.com", true);
    await expect(enrollInSequence(env, id, "co1", {})).rejects.toThrow(/已停用/);

    await setSequenceEnabledInDb(env, id, true);
    seedCompany(db, "co2");
    seedContact(db, "ct2", "co2", "", true);
    await expect(enrollInSequence(env, id, "co2", {})).rejects.toThrow(/带邮箱的联系人/);
  });

  it("lists enrollments for a sequence with company names", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const id = await seedSequence(db, [{ day_offset: 0, subject: "Hi", body: "Hello" }]);
    seedCompany(db);
    seedContact(db, "ct1", "co1", "buyer@acme.com", true);
    await enrollInSequence(env, id, "co1", {});
    const res = await listEnrollmentsFor(env, id);
    const body = await res.json() as { enrollments: Array<{ company_name: string; contact_email: string; status: string }> };
    expect(body.enrollments).toHaveLength(1);
    expect(body.enrollments[0]).toMatchObject({ company_name: "Acme Paddle Co", contact_email: "buyer@acme.com", status: "active" });
  });
});

describe("setEnrollmentStatusInDb", () => {
  it("pauses, resumes (due soon) and stops with a reason", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const id = await seedSequence(db, [{ day_offset: 0, subject: "Hi", body: "Hello" }]);
    seedCompany(db);
    seedContact(db, "ct1", "co1", "buyer@acme.com", true);
    const { enrollment } = await enrollInSequence(env, id, "co1", {});

    await setEnrollmentStatusInDb(env, enrollment.id, "paused", null);
    let row = db.prepare("SELECT status FROM crm_sequence_enrollments WHERE id = ?").get(enrollment.id) as any;
    expect(row.status).toBe("paused");

    await setEnrollmentStatusInDb(env, enrollment.id, "active", null);
    row = db.prepare("SELECT status, next_due_at FROM crm_sequence_enrollments WHERE id = ?").get(enrollment.id) as any;
    expect(row.status).toBe("active");
    // 恢复后 60 秒内到期。
    expect(Date.parse(row.next_due_at) - Date.now()).toBeLessThanOrEqual(60_000 + 1000);

    await setEnrollmentStatusInDb(env, enrollment.id, "stopped", "人工停止");
    row = db.prepare("SELECT status, stop_reason FROM crm_sequence_enrollments WHERE id = ?").get(enrollment.id) as any;
    expect(row).toMatchObject({ status: "stopped", stop_reason: "人工停止" });
    await expect(setEnrollmentStatusInDb(env, "missing", "paused", null)).rejects.toThrow(/不存在/);
  });
});

describe("runSequenceTick", () => {
  it("sends the due step through the single send path and anchors the next step", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const id = await seedSequence(db, [
      { day_offset: 0, subject: "Intro to {{company}}", body: "Hi {{contact_name}} from {{sender_name}}" },
      { day_offset: 3, subject: "Follow-up", body: "Any thoughts?" },
    ]);
    seedCompany(db);
    seedContact(db, "ct1", "co1", "buyer@acme.com", true);
    await enrollInSequence(env, id, "co1", {});
    const enrolledAt = (db.prepare("SELECT enrolled_at FROM crm_sequence_enrollments").get() as any).enrolled_at;

    const fn = stubFetch([
      { match: (u) => u === TOKEN_URL, body: { access_token: "tok-seq-1", expires_in: 3600 } },
      { match: (u) => u === SEND_URL, body: { id: "gm-seq-1" } },
    ]);

    const report = await runSequenceTick(env);
    expect(report).toMatchObject({ sent: 1, stopped: 0, completed: 0 });

    // 草稿 → 已发送；发送日志落 'sent'。
    const email = db.prepare("SELECT email_to, subject, body, status FROM outreach_emails").get() as any;
    expect(email).toMatchObject({ email_to: "buyer@acme.com", status: "sent" });
    expect(email.subject).toBe("Intro to Acme Paddle Co");
    expect(email.body).toContain("Hi John Doe");
    const log = db.prepare("SELECT recipient, status, sender_client_email FROM gmail_send_log").get() as any;
    expect(log).toMatchObject({ recipient: "buyer@acme.com", status: "sent", sender_client_email: "sales@brand.com" });
    // 只有一次 token + 一次发送。
    expect(fn.mock.calls).toHaveLength(2);

    // 推进到第 2 步，下一次到期 ≈ 入册时间 + 3 天（锚定日程；
    // enrolled_at 为 ISO 格式写入）。
    const en = db.prepare("SELECT current_step, status, next_due_at FROM crm_sequence_enrollments").get() as any;
    expect(en).toMatchObject({ current_step: 1, status: "active" });
    const expected = Date.parse(enrolledAt) + 3 * 24 * 3600 * 1000;
    expect(Math.abs(Date.parse(en.next_due_at) - expected)).toBeLessThan(5000);

    // 时间线记录序列发送。
    const note = db.prepare("SELECT summary FROM crm_activities WHERE type = 'note' AND summary LIKE '%序列邮件已发送%'").get() as any;
    expect(note.summary).toContain("1/2");
  });

  it("terminates on a customer reply recorded after enrollment, without sending", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const id = await seedSequence(db, [{ day_offset: 0, subject: "Hi", body: "Hello" }]);
    seedCompany(db);
    seedContact(db, "ct1", "co1", "buyer@acme.com", true);
    await enrollInSequence(env, id, "co1", {});
    // 入册后的客户回复（email_received 且摘要含联系人邮箱）。
    db.prepare("INSERT INTO crm_activities (id, company_id, type, summary) VALUES ('a1', 'co1', 'email_received', '收到客户回复 buyer@acme.com：Re: Intro')").run();

    const fn = stubFetch([]);
    const report = await runSequenceTick(env);
    expect(report).toMatchObject({ sent: 0, stopped: 1 });
    expect(fn.mock.calls).toHaveLength(0);
    const en = db.prepare("SELECT status, stop_reason FROM crm_sequence_enrollments").get() as any;
    expect(en.status).toBe("stopped");
    expect(en.stop_reason).toContain("客户已回复");
  });

  it("terminates when the contact is suppressed (unsubscribed)", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const id = await seedSequence(db, [{ day_offset: 0, subject: "Hi", body: "Hello" }]);
    seedCompany(db);
    seedContact(db, "ct1", "co1", "buyer@acme.com", true);
    await enrollInSequence(env, id, "co1", {});
    db.prepare("UPDATE crm_contacts SET unsubscribed_at = CURRENT_TIMESTAMP WHERE id = 'ct1'").run();

    const fn = stubFetch([]);
    const report = await runSequenceTick(env);
    expect(report).toMatchObject({ sent: 0, stopped: 1 });
    expect(fn.mock.calls).toHaveLength(0);
    const en = db.prepare("SELECT status, stop_reason FROM crm_sequence_enrollments").get() as any;
    expect(en.stop_reason).toContain("触达抑制");
    expect((db.prepare("SELECT COUNT(*) AS n FROM outreach_emails").get() as any).n).toBe(0);
  });

  it("retries send failures with backoff, then stops after the 3rd consecutive failure", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const id = await seedSequence(db, [{ day_offset: 0, subject: "Hi", body: "Hello" }]);
    seedCompany(db);
    seedContact(db, "ct1", "co1", "buyer@acme.com", true);
    await enrollInSequence(env, id, "co1", {});

    stubFetch([
      { match: (u) => u === TOKEN_URL, body: { access_token: "tok-seq-f", expires_in: 3600 } },
      { match: (u) => u === SEND_URL, status: 500, body: { error: { message: "Backend Error" } } },
    ]);

    // 第 1、2 次：有限重试（30 分钟退避——测试里手动把到期时间拨回当下）。
    for (let i = 1; i <= 2; i++) {
      const report = await runSequenceTick(env);
      expect(report.sent).toBe(0);
      const en = db.prepare("SELECT send_failures, status, next_due_at FROM crm_sequence_enrollments").get() as any;
      expect(en.send_failures).toBe(i);
      expect(en.status).toBe("active");
      expect(Date.parse(en.next_due_at) - Date.now()).toBeGreaterThan(25 * 60 * 1000);
      db.prepare("UPDATE crm_sequence_enrollments SET next_due_at = ?").run(new Date().toISOString());
    }
    // 第 3 次：终止。
    const report = await runSequenceTick(env);
    expect(report).toMatchObject({ sent: 0, stopped: 1 });
    const en = db.prepare("SELECT status, stop_reason FROM crm_sequence_enrollments").get() as any;
    expect(en.status).toBe("stopped");
    expect(en.stop_reason).toContain("3 次发送失败");
    // 失败记录进发送日志（可追溯）。
    const failed = db.prepare("SELECT COUNT(*) AS n FROM gmail_send_log WHERE status = 'failed'").get() as any;
    expect(failed.n).toBe(3);
  });

  it("completes a one-step sequence after the send", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const id = await seedSequence(db, [{ day_offset: 0, subject: "Hi {{company}}", body: "One shot" }]);
    seedCompany(db);
    seedContact(db, "ct1", "co1", "buyer@acme.com", true);
    await enrollInSequence(env, id, "co1", {});

    stubFetch([
      { match: (u) => u === TOKEN_URL, body: { access_token: "tok-seq-c", expires_in: 3600 } },
      { match: (u) => u === SEND_URL, body: { id: "gm-seq-c" } },
    ]);
    const report = await runSequenceTick(env);
    expect(report).toMatchObject({ sent: 1, completed: 1 });
    const en = db.prepare("SELECT status, current_step FROM crm_sequence_enrollments").get() as any;
    expect(en).toMatchObject({ status: "completed", current_step: 1 });
    // 已完成的序列不会再次被 tick 捞起。
    const again = await runSequenceTick(env);
    expect(again.sent).toBe(0);
  });

  it("defers enrollments whose sequence is disabled instead of sending", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const id = await seedSequence(db, [{ day_offset: 0, subject: "Hi", body: "Hello" }]);
    seedCompany(db);
    seedContact(db, "ct1", "co1", "buyer@acme.com", true);
    await enrollInSequence(env, id, "co1", {});
    await setSequenceEnabledInDb(env, id, false);

    const fn = stubFetch([]);
    const report = await runSequenceTick(env);
    expect(report).toMatchObject({ sent: 0, deferred: 1 });
    expect(fn.mock.calls).toHaveLength(0);
    const en = db.prepare("SELECT status, next_due_at FROM crm_sequence_enrollments").get() as any;
    expect(en.status).toBe("active");
    // 延后约 6 小时。
    expect(Date.parse(en.next_due_at) - Date.now()).toBeGreaterThan(5 * 3600 * 1000);
  });

  it("is fail-open when the sequence tables do not exist", async () => {
    // 空 schema：crm_sequence_* 不存在 → tick 捕获查询错误并静默跳过。
    const db = new DatabaseSync(":memory:");
    const report = await runSequenceTick(makeEnv(db));
    expect(report).toEqual({ sent: 0, stopped: 0, completed: 0, deferred: 0, errors: 0 });
  });
});
