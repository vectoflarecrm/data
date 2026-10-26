import { afterEach, describe, expect, it, vi } from "vitest";
import { parseFromAddress, syncInboundGmail } from "../src/crm-gmail-sync";
import type { GmailEnv } from "../src/gmail";

/* ⑦ Gmail 入站同步：联系人邮箱 → 公司域名两级匹配、crm_mail_seen 幂等去重、
 * crm_mail_sync 游标推进、403 退避。fetch 全程 mock，不触网。 */

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

async function makeDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE outreach_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_name TEXT NOT NULL UNIQUE,
      product_category TEXT NOT NULL,
      sender_email TEXT,
      gmail_account TEXT,
      enabled INTEGER DEFAULT 1
    );
    CREATE TABLE gmail_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT,
      credential_type TEXT NOT NULL DEFAULT 'service_account',
      client_email TEXT NOT NULL UNIQUE,
      private_key TEXT NOT NULL,
      delegated_domain TEXT,
      daily_limit INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_error TEXT,
      cooldown_until TIMESTAMP
    );
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
    CREATE TABLE crm_mail_sync (
      mailbox TEXT PRIMARY KEY,
      last_internal_date INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT,
      last_error TEXT,
      error_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE crm_mail_seen (
      mailbox TEXT NOT NULL,
      message_id TEXT NOT NULL,
      received_at TEXT,
      PRIMARY KEY (mailbox, message_id)
    );
  `);
  return db;
}

function makeEnv(db: any): GmailEnv {
  return {
    DB: new FakeD1(db),
    GMAIL_OAUTH_CLIENT_ID: "test-client-id",
    GMAIL_OAUTH_CLIENT_SECRET: "test-secret",
  } as unknown as GmailEnv;
}

function seedAccount(db: any, clientEmail: string, credentialType: string): void {
  db.prepare("INSERT INTO gmail_accounts (label, credential_type, client_email, private_key) VALUES ('t', ?, ?, 'rt-token')")
    .run(credentialType, clientEmail);
}

function seedSettings(db: any, sender: string, gmailAccount: string | null): void {
  db.prepare("INSERT INTO outreach_settings (brand_name, product_category, sender_email, gmail_account) VALUES ('BrandA', 'cat', ?, ?)")
    .run(sender, gmailAccount);
}

function gmailMessage(
  id: string,
  from: string,
  subject: string,
  internalDate: string,
  extra?: { snippet?: string; headers?: Array<{ name: string; value: string }> },
) {
  return {
    id,
    threadId: `t-${id}`,
    internalDate,
    snippet: extra?.snippet,
    payload: {
      headers: [
        { name: "From", value: from },
        { name: "Subject", value: subject },
        ...(extra?.headers ?? []),
      ],
    },
  };
}

interface Route {
  match: (url: string) => boolean;
  status?: number;
  body: unknown;
}

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

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseFromAddress", () => {
  it("parses angle-bracket, bare and garbage From headers", () => {
    expect(parseFromAddress('"John Doe" <BUYER@Acme.com>')).toBe("buyer@acme.com");
    expect(parseFromAddress("buyer@acme.com")).toBe("buyer@acme.com");
    expect(parseFromAddress("no-reply")).toBe("");
    expect(parseFromAddress("Mailer <news@list.example.com>")).toBe("news@list.example.com");
  });
});

describe("syncInboundGmail", () => {
  it("matches a reply by contact email → email_received activity + cursor", async () => {
    const db = await makeDb();
    seedAccount(db, "sales1@brand.com", "oauth_refresh");
    seedSettings(db, "sales1@brand.com", "sales1@brand.com");
    db.prepare("INSERT INTO crm_companies (id, name, domain) VALUES ('c1', 'Acme', 'acme.com')").run();
    db.prepare("INSERT INTO crm_contacts (id, company_id, full_name, email) VALUES ('ct1', 'c1', 'John', 'buyer@acme.com')").run();

    stubFetch([
      { match: (u) => u === TOKEN_URL, body: { access_token: "tok-1", expires_in: 3600 } },
      { match: (u) => u.startsWith(`${API}/`) && u.includes("/messages?"), body: { messages: [{ id: "m1", threadId: "t1" }] } },
      {
        match: (u) => u.includes("/messages/m1?"),
        body: gmailMessage("m1", "John <buyer@acme.com>", "Re: quotation", "1770000000000"),
      },
    ]);

    const report = await syncInboundGmail(makeEnv(db));
    expect(report).toEqual({ mailboxes: 1, processed: 1, matched: 1, errors: 0 });

    const activity = db.prepare("SELECT * FROM crm_activities").get() as any;
    expect(activity.company_id).toBe("c1");
    expect(activity.type).toBe("email_received");
    expect(activity.summary).toContain("Re: quotation");
    expect(activity.summary).toContain("buyer@acme.com");
    expect(activity.summary).toContain("John");

    const sync = db.prepare("SELECT * FROM crm_mail_sync WHERE mailbox = 'sales1@brand.com'").get() as any;
    expect(sync.last_internal_date).toBe(1770000000000);
    expect(sync.error_count).toBe(0);
    expect(sync.last_error).toBeNull();

    const seen = db.prepare("SELECT * FROM crm_mail_seen").all() as any[];
    expect(seen).toHaveLength(1);
    expect(seen[0].message_id).toBe("m1");
  });

  it("falls back to company-domain matching when the sender is an unknown mailbox", async () => {
    const db = await makeDb();
    seedAccount(db, "sales2@brand.com", "oauth_refresh");
    seedSettings(db, "sales2@brand.com", "sales2@brand.com");
    db.prepare("INSERT INTO crm_companies (id, name, domain) VALUES ('c1', 'Acme', 'acme.com')").run();

    stubFetch([
      { match: (u) => u === TOKEN_URL, body: { access_token: "tok-2", expires_in: 3600 } },
      { match: (u) => u.startsWith(`${API}/`) && u.includes("/messages?"), body: { messages: [{ id: "m2", threadId: "t2" }] } },
      {
        match: (u) => u.includes("/messages/m2?"),
        body: gmailMessage("m2", "newperson@acme.com", "Interested in samples", "1770000001000"),
      },
    ]);

    const report = await syncInboundGmail(makeEnv(db));
    expect(report.matched).toBe(1);
    const activity = db.prepare("SELECT * FROM crm_activities").get() as any;
    expect(activity.company_id).toBe("c1");
    expect(activity.summary).toContain("newperson@acme.com");
  });

  it("records unmatched mail in the dedupe table without a timeline row", async () => {
    const db = await makeDb();
    seedAccount(db, "sales3@brand.com", "oauth_refresh");
    seedSettings(db, "sales3@brand.com", "sales3@brand.com");

    stubFetch([
      { match: (u) => u === TOKEN_URL, body: { access_token: "tok-3", expires_in: 3600 } },
      { match: (u) => u.startsWith(`${API}/`) && u.includes("/messages?"), body: { messages: [{ id: "m3", threadId: "t3" }] } },
      {
        match: (u) => u.includes("/messages/m3?"),
        body: gmailMessage("m3", "stranger@unknown.org", "Hello", "1770000002000"),
      },
    ]);

    const report = await syncInboundGmail(makeEnv(db));
    expect(report).toEqual({ mailboxes: 1, processed: 1, matched: 0, errors: 0 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM crm_activities").get() as any).n).toBe(0);
    const seen = db.prepare("SELECT * FROM crm_mail_seen").all() as any[];
    expect(seen).toHaveLength(1);
    expect(seen[0].received_at).toContain("2026-");
  });

  it("skips already-seen messages (idempotent across overlapping ticks)", async () => {
    const db = await makeDb();
    seedAccount(db, "sales4@brand.com", "oauth_refresh");
    seedSettings(db, "sales4@brand.com", "sales4@brand.com");
    db.prepare("INSERT INTO crm_mail_sync (mailbox, last_internal_date) VALUES ('sales4@brand.com', 1770000000000)").run();
    db.prepare("INSERT INTO crm_mail_seen (mailbox, message_id, received_at) VALUES ('sales4@brand.com', 'm1', '2026-02-02')").run();

    const fn = stubFetch([
      { match: (u) => u === TOKEN_URL, body: { access_token: "tok-4", expires_in: 3600 } },
      { match: (u) => u.startsWith(`${API}/`) && u.includes("/messages?"), body: { messages: [{ id: "m1", threadId: "t1" }] } },
    ]);

    const report = await syncInboundGmail(makeEnv(db));
    expect(report.processed).toBe(0);
    const urls = fn.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/messages/m1?"))).toBe(false);
  });

  it("records a 403 as a sync error, then backs off after repeated failures", async () => {
    const db = await makeDb();
    seedAccount(db, "sales5@brand.com", "oauth_refresh");
    seedSettings(db, "sales5@brand.com", "sales5@brand.com");

    stubFetch([
      { match: (u) => u === TOKEN_URL, body: { access_token: "tok-5", expires_in: 3600 } },
      {
        match: (u) => u.startsWith(`${API}/`) && u.includes("/messages?"),
        status: 403,
        body: { error: { message: "Requested client not authorized" } },
      },
    ]);

    const report = await syncInboundGmail(makeEnv(db));
    expect(report.errors).toBe(1);
    const sync = db.prepare("SELECT * FROM crm_mail_sync WHERE mailbox = 'sales5@brand.com'").get() as any;
    expect(sync.error_count).toBe(1);
    expect(sync.last_error).toContain("403");

    // 连续失败达到退避阈值 → 本 tick 直接跳过：不处理任何消息、不发任何请求。
    db.prepare("UPDATE crm_mail_sync SET error_count = 5, last_run_at = ? WHERE mailbox = 'sales5@brand.com'")
      .run(new Date().toISOString());
    const fn = stubFetch([]);
    const report2 = await syncInboundGmail(makeEnv(db));
    expect(report2.processed).toBe(0);
    expect(report2.matched).toBe(0);
    expect(report2.errors).toBe(0);
    expect(fn.mock.calls).toHaveLength(0);
  });

  it("skips service accounts that have no inbox of their own", async () => {
    const db = await makeDb();
    seedAccount(db, "sa@proj.iam.gserviceaccount.com", "service_account");
    seedSettings(db, "sa@proj.iam.gserviceaccount.com", "sa@proj.iam.gserviceaccount.com");

    const fn = stubFetch([]);
    const report = await syncInboundGmail(makeEnv(db));
    expect(report).toEqual({ mailboxes: 0, processed: 0, matched: 0, errors: 0 });
    expect(fn.mock.calls).toHaveLength(0);
  });

  it("classifies a bounce: marks the original recipient invalid and logs to their company", async () => {
    const db = await makeDb();
    seedAccount(db, "sales6@brand.com", "oauth_refresh");
    seedSettings(db, "sales6@brand.com", "sales6@brand.com");
    db.prepare("INSERT INTO crm_companies (id, name, domain) VALUES ('c1', 'Acme', 'acme.com')").run();
    db.prepare("INSERT INTO crm_contacts (id, company_id, full_name, email) VALUES ('ct1', 'c1', 'John', 'buyer@acme.com')").run();

    stubFetch([
      { match: (u) => u === TOKEN_URL, body: { access_token: "tok-6", expires_in: 3600 } },
      { match: (u) => u.startsWith(`${API}/`) && u.includes("/messages?"), body: { messages: [{ id: "m4", threadId: "t4" }] } },
      {
        match: (u) => u.includes("/messages/m4?"),
        body: gmailMessage(
          "m4",
          "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
          "Delivery Status Notification (Failure)",
          "1770000003000",
          { snippet: "The address buyer@acme.com was not found. 550 5.1.1" },
        ),
      },
    ]);

    const report = await syncInboundGmail(makeEnv(db));
    expect(report.matched).toBe(1);

    const contact = db.prepare("SELECT * FROM crm_contacts WHERE id = 'ct1'").get() as any;
    expect(contact.email_status).toBe("invalid");
    expect(contact.email_verified_at).toBeTruthy();

    const activity = db.prepare("SELECT * FROM crm_activities").get() as any;
    expect(activity.company_id).toBe("c1");
    expect(activity.summary).toContain("退信");
    expect(activity.summary).toContain("buyer@acme.com");
    expect(activity.summary).toContain("邮箱已标记无效");
  });

  it("classifies an unsubscribe request: suppresses the sender and annotates the timeline", async () => {
    const db = await makeDb();
    seedAccount(db, "sales7@brand.com", "oauth_refresh");
    seedSettings(db, "sales7@brand.com", "sales7@brand.com");
    db.prepare("INSERT INTO crm_companies (id, name, domain) VALUES ('c1', 'Acme', 'acme.com')").run();
    db.prepare("INSERT INTO crm_contacts (id, company_id, full_name, email) VALUES ('ct1', 'c1', 'John', 'buyer@acme.com')").run();

    stubFetch([
      { match: (u) => u === TOKEN_URL, body: { access_token: "tok-7", expires_in: 3600 } },
      { match: (u) => u.startsWith(`${API}/`) && u.includes("/messages?"), body: { messages: [{ id: "m5", threadId: "t5" }] } },
      {
        match: (u) => u.includes("/messages/m5?"),
        body: gmailMessage(
          "m5",
          "John <buyer@acme.com>",
          "Please unsubscribe me",
          "1770000004000",
          { snippet: "请不要再来邮件，取消订阅你们的产品目录。" },
        ),
      },
    ]);

    const report = await syncInboundGmail(makeEnv(db));
    expect(report.matched).toBe(1);

    const contact = db.prepare("SELECT * FROM crm_contacts WHERE id = 'ct1'").get() as any;
    expect(contact.do_not_contact).toBe(1);
    expect(contact.unsubscribed_at).toBeTruthy();

    const activity = db.prepare("SELECT * FROM crm_activities").get() as any;
    expect(activity.summary).toContain("退订请求");
    expect(activity.summary).toContain("已自动标记禁止联系");
  });

  it("classifies an out-of-office auto-reply via the Auto-Submitted header", async () => {
    const db = await makeDb();
    seedAccount(db, "sales8@brand.com", "oauth_refresh");
    seedSettings(db, "sales8@brand.com", "sales8@brand.com");
    db.prepare("INSERT INTO crm_companies (id, name, domain) VALUES ('c1', 'Acme', 'acme.com')").run();
    db.prepare("INSERT INTO crm_contacts (id, company_id, full_name, email) VALUES ('ct1', 'c1', 'John', 'buyer@acme.com')").run();

    stubFetch([
      { match: (u) => u === TOKEN_URL, body: { access_token: "tok-8", expires_in: 3600 } },
      { match: (u) => u.startsWith(`${API}/`) && u.includes("/messages?"), body: { messages: [{ id: "m6", threadId: "t6" }] } },
      {
        match: (u) => u.includes("/messages/m6?"),
        body: gmailMessage("m6", "John <buyer@acme.com>", "Out of office", "1770000005000", {
          snippet: "I am on vacation until Monday. For urgent matters contact my colleague interested in your catalog.",
          headers: [{ name: "Auto-Submitted", value: "auto-replied" }],
        }),
      },
    ]);

    const report = await syncInboundGmail(makeEnv(db));
    expect(report.matched).toBe(1);
    // 头部证据优先：虽含目录等意向词，仍按自动回复分类，且不标记禁联。
    const contact = db.prepare("SELECT * FROM crm_contacts WHERE id = 'ct1'").get() as any;
    expect(contact.do_not_contact).toBe(0);
    const activity = db.prepare("SELECT * FROM crm_activities").get() as any;
    expect(activity.summary).toContain("自动回复");
  });

  it("creates a quote follow-up task and bumps lead_status for interest replies (deduped)", async () => {
    const db = await makeDb();
    seedAccount(db, "sales9@brand.com", "oauth_refresh");
    seedSettings(db, "sales9@brand.com", "sales9@brand.com");
    db.prepare("INSERT INTO crm_companies (id, name, domain, lead_status) VALUES ('c1', 'Acme', 'acme.com', 'new')").run();
    db.prepare("INSERT INTO crm_contacts (id, company_id, full_name, email) VALUES ('ct1', 'c1', 'John', 'buyer@acme.com')").run();

    stubFetch([
      { match: (u) => u === TOKEN_URL, body: { access_token: "tok-9", expires_in: 3600 } },
      { match: (u) => u.startsWith(`${API}/`) && u.includes("/messages?"), body: { messages: [{ id: "m8", threadId: "t8" }] } },
      {
        match: (u) => u.includes("/messages/m8?"),
        body: gmailMessage("m8", "John <buyer@acme.com>", "Quotation request", "1770000006000", {
          snippet: "Please send price list and catalog",
        }),
      },
    ]);

    await syncInboundGmail(makeEnv(db));
    const tasks = db.prepare("SELECT * FROM crm_activities WHERE type = 'task'").all() as any[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].summary).toContain("报价跟进");
    expect(tasks[0].summary).toContain("buyer@acme.com");
    expect(tasks[0].due_date).toBeTruthy();
    const co = db.prepare("SELECT lead_status FROM crm_companies WHERE id = 'c1'").get() as any;
    expect(co.lead_status).toBe("contacted");

    // 同一来信人的第二封兴趣回复：时间线照写，但不重复建任务。
    stubFetch([
      { match: (u) => u === TOKEN_URL, body: { access_token: "tok-10", expires_in: 3600 } },
      { match: (u) => u.startsWith(`${API}/`) && u.includes("/messages?"), body: { messages: [{ id: "m9", threadId: "t9" }] } },
      {
        match: (u) => u.includes("/messages/m9?"),
        body: gmailMessage("m9", "John <buyer@acme.com>", "Re: Quotation request", "1770000007000", {
          snippet: "Also interested in samples",
        }),
      },
    ]);
    await syncInboundGmail(makeEnv(db));
    expect((db.prepare("SELECT COUNT(*) AS n FROM crm_activities WHERE type = 'task'").get() as any).n).toBe(1);
  });

  it("does not create tasks or bump lead_status for plain replies", async () => {
    const db = await makeDb();
    seedAccount(db, "sales10@brand.com", "oauth_refresh");
    seedSettings(db, "sales10@brand.com", "sales10@brand.com");
    db.prepare("INSERT INTO crm_companies (id, name, domain, lead_status) VALUES ('c1', 'Acme', 'acme.com', 'new')").run();
    db.prepare("INSERT INTO crm_contacts (id, company_id, full_name, email) VALUES ('ct1', 'c1', 'John', 'buyer@acme.com')").run();

    stubFetch([
      { match: (u) => u === TOKEN_URL, body: { access_token: "tok-11", expires_in: 3600 } },
      { match: (u) => u.startsWith(`${API}/`) && u.includes("/messages?"), body: { messages: [{ id: "m10", threadId: "t10" }] } },
      {
        match: (u) => u.includes("/messages/m10?"),
        body: gmailMessage("m10", "John <buyer@acme.com>", "Thanks for reaching out", "1770000008000", {
          snippet: "Not for now, maybe later",
        }),
      },
    ]);

    const report = await syncInboundGmail(makeEnv(db));
    expect(report.matched).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM crm_activities WHERE type = 'task'").get() as any).n).toBe(0);
    const co = db.prepare("SELECT lead_status FROM crm_companies WHERE id = 'c1'").get() as any;
    expect(co.lead_status).toBe("new");
  });
});
