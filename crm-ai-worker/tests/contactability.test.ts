import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyInboundEmail,
  extractBouncedAddress,
  isContactBlocked,
  markContactUnsubscribed,
  markEmailInvalid,
} from "../src/contactability";

/* 触达质量闭环：回复分类纯函数 + 发送前统一策略检查
 * （联系人退订/禁联 → 公司禁联 → 域名级 → invalid 邮箱）+ 抑制动作。 */

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
    CREATE TABLE crm_companies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT UNIQUE,
      do_not_contact INTEGER DEFAULT 0,
      domain_email_status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE crm_contacts (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES crm_companies(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL, email TEXT,
      email_status TEXT DEFAULT 'unknown', email_verified_at TEXT,
      email_check_status TEXT NOT NULL DEFAULT 'pending',
      unsubscribed_at TEXT, do_not_contact INTEGER DEFAULT 0
    );
  `);
  return db;
}

function makeEnv(db: any) {
  return { DB: new FakeD1(db) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("classifyInboundEmail", () => {
  it("classifies mailer-daemon as bounce", () => {
    expect(classifyInboundEmail({ fromEmail: "mailer-daemon@googlemail.com", subject: "Failure", snippet: "" }).kind).toBe("bounce");
    expect(classifyInboundEmail({ fromEmail: "postmaster@acme.com", subject: "x", snippet: "" }).kind).toBe("bounce");
  });

  it("classifies unsubscribe keywords in Chinese and English", () => {
    expect(classifyInboundEmail({ fromEmail: "a@acme.com", subject: "取消订阅", snippet: "" }).kind).toBe("unsubscribe");
    expect(classifyInboundEmail({ fromEmail: "a@acme.com", subject: "Hello", snippet: "Please remove me from your list" }).kind).toBe("unsubscribe");
  });

  it("treats Auto-Submitted != no as an auto-reply even when the body has interest words", () => {
    const cls = classifyInboundEmail({
      fromEmail: "a@acme.com",
      subject: "Re: catalog",
      snippet: "interested in your catalog, on vacation",
      autoSubmitted: "auto-replied",
    });
    expect(cls.kind).toBe("auto_reply");
  });

  it("treats Precedence bulk as an auto-reply", () => {
    expect(classifyInboundEmail({ fromEmail: "a@acme.com", subject: "Re: hi", snippet: "x", precedence: "bulk" }).kind).toBe("auto_reply");
  });

  it("classifies purchase-intent keywords as interest", () => {
    expect(classifyInboundEmail({ fromEmail: "a@acme.com", subject: "Quotation request", snippet: "please send price list" }).kind).toBe("interest");
    expect(classifyInboundEmail({ fromEmail: "a@acme.com", subject: "Re: hello", snippet: "我们想了解样品和报价" }).kind).toBe("interest");
  });

  it("falls back to plain reply", () => {
    expect(classifyInboundEmail({ fromEmail: "a@acme.com", subject: "Re: hello", snippet: "thanks for reaching out" }).kind).toBe("reply");
  });
});

describe("extractBouncedAddress", () => {
  it("pulls the original recipient out of a DSN body, skipping the daemon", () => {
    expect(extractBouncedAddress("The address buyer@acme.com was not found. 550 5.1.1")).toBe("buyer@acme.com");
    expect(extractBouncedAddress("")).toBe("");
    expect(extractBouncedAddress("no addresses here")).toBe("");
  });
});

describe("isContactBlocked", () => {
  it("blocks on contact-level do_not_contact", async () => {
    const db = await makeDb();
    db.prepare("INSERT INTO crm_companies (id, name, domain) VALUES ('c1', 'Acme', 'acme.com')").run();
    db.prepare("INSERT INTO crm_contacts (id, company_id, full_name, email, do_not_contact) VALUES ('ct1', 'c1', 'J', 'a@acme.com', 1)").run();
    const r = await isContactBlocked(makeEnv(db), "A@ACME.COM");
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("禁止联系");
  });

  it("blocks on unsubscribed_at with the unsubscribe date in the reason", async () => {
    const db = await makeDb();
    db.prepare("INSERT INTO crm_companies (id, name, domain) VALUES ('c1', 'Acme', 'acme.com')").run();
    db.prepare("INSERT INTO crm_contacts (id, company_id, full_name, email, unsubscribed_at) VALUES ('ct1', 'c1', 'J', 'a@acme.com', '2026-02-01T00:00:00.000Z')").run();
    const r = await isContactBlocked(makeEnv(db), "a@acme.com");
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("2026-02-01");
  });

  it("blocks on company-level do_not_contact (direct and via domain)", async () => {
    const db = await makeDb();
    db.prepare("INSERT INTO crm_companies (id, name, domain, do_not_contact) VALUES ('c1', 'Acme', 'acme.com', 1)").run();
    db.prepare("INSERT INTO crm_contacts (id, company_id, full_name, email) VALUES ('ct1', 'c1', 'J', 'a@acme.com')").run();
    expect((await isContactBlocked(makeEnv(db), "a@acme.com")).blocked).toBe(true);
    // 未录入联系人的邮箱也能按公司域名拦截。
    expect((await isContactBlocked(makeEnv(db), "stranger@acme.com")).blocked).toBe(true);
  });

  it("blocks on an invalid (bounced) email status", async () => {
    const db = await makeDb();
    db.prepare("INSERT INTO crm_companies (id, name, domain) VALUES ('c1', 'Acme', 'acme.com')").run();
    db.prepare("INSERT INTO crm_contacts (id, company_id, full_name, email, email_status) VALUES ('ct1', 'c1', 'J', 'a@acme.com', 'invalid')").run();
    const r = await isContactBlocked(makeEnv(db), "a@acme.com");
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("invalid");
  });

  it("lets clean contacts through", async () => {
    const db = await makeDb();
    db.prepare("INSERT INTO crm_companies (id, name, domain) VALUES ('c1', 'Acme', 'acme.com')").run();
    db.prepare("INSERT INTO crm_contacts (id, company_id, full_name, email) VALUES ('ct1', 'c1', 'J', 'a@acme.com')").run();
    expect((await isContactBlocked(makeEnv(db), "a@acme.com")).blocked).toBe(false);
    expect((await isContactBlocked(makeEnv(db), "nobody@unknown.org")).blocked).toBe(false);
    expect((await isContactBlocked(makeEnv(db), "")).blocked).toBe(false);
  });

  it("fails open when the CRM tables are missing", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE unrelated (id TEXT)");
    expect((await isContactBlocked(makeEnv(db), "a@acme.com")).blocked).toBe(false);
  });
});

describe("markContactUnsubscribed / markEmailInvalid", () => {
  it("marks all contacts sharing the mailbox, keeps first unsubscribe date", async () => {
    const db = await makeDb();
    db.prepare("INSERT INTO crm_companies (id, name) VALUES ('c1', 'Acme')").run();
    db.prepare("INSERT INTO crm_contacts (id, company_id, full_name, email) VALUES ('ct1', 'c1', 'J', 'a@acme.com')").run();
    db.prepare("INSERT INTO crm_contacts (id, company_id, full_name, email) VALUES ('ct2', 'c1', 'K', 'A@ACME.com')").run();
    db.prepare("UPDATE crm_contacts SET unsubscribed_at = '2026-01-01T00:00:00.000Z' WHERE id = 'ct1'").run();

    expect(await markContactUnsubscribed(makeEnv(db), "a@acme.com")).toBe(true);
    const rows = db.prepare("SELECT * FROM crm_contacts ORDER BY id").all() as any[];
    expect(rows.map((r) => r.do_not_contact)).toEqual([1, 1]);
    expect(rows[0].unsubscribed_at).toBe("2026-01-01T00:00:00.000Z"); // 首次退订时间保留
    expect(rows[1].unsubscribed_at).toBeTruthy();
  });

  it("returns false when nothing matched", async () => {
    const db = await makeDb();
    expect(await markContactUnsubscribed(makeEnv(db), "ghost@nowhere.com")).toBe(false);
    expect(await markEmailInvalid(makeEnv(db), "ghost@nowhere.com")).toBe(false);
  });

  it("marks email invalid idempotently", async () => {
    const db = await makeDb();
    db.prepare("INSERT INTO crm_companies (id, name) VALUES ('c1', 'Acme')").run();
    db.prepare("INSERT INTO crm_contacts (id, company_id, full_name, email) VALUES ('ct1', 'c1', 'J', 'a@acme.com')").run();

    expect(await markEmailInvalid(makeEnv(db), "a@acme.com")).toBe(true);
    const first = db.prepare("SELECT * FROM crm_contacts").get() as any;
    const stampedAt = first.email_verified_at;
    expect(first.email_status).toBe("invalid");
    expect(stampedAt).toBeTruthy();

    expect(await markEmailInvalid(makeEnv(db), "a@acme.com")).toBe(false); // 已 invalid，不再重复盖戳
    const second = db.prepare("SELECT * FROM crm_contacts").get() as any;
    expect(second.email_verified_at).toBe(stampedAt);
  });
});
