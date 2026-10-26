import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AdminEnv } from "../src/admin";
import {
  detectMailProvider,
  extractEmailDomain,
  isDisposableEmailDomain,
  isFreeEmailDomain,
  listDomainChecks,
  normalizeDomain,
  recheckCompanyDomainInDb,
  recheckContactEmailInDb,
  runEmailScreeningTick,
  verifyDomain,
} from "../src/email-verify";

/* 邮箱/域名检测（0036）：DoH 全程 mock，不触网。
 * 覆盖：域名规范化、免费/一次性短路（0 fetch）、DoH 判定（valid/no_mx/
 * dead_domain/Null MX）、邮局指纹、缓存复用与 upsert、tick 队列推进
 * （状态回写、异常时间线、同域去重、预算上限、表缺失 fail-open）、
 * 面板重检与 listDomainChecks 聚合。 */

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
    CREATE TABLE domain_dns_checks (
      domain TEXT PRIMARY KEY,
      has_a_record INTEGER NOT NULL DEFAULT 0,
      has_mx_record INTEGER NOT NULL DEFAULT 0,
      has_spf_record INTEGER NOT NULL DEFAULT 0,
      mx_provider TEXT NOT NULL DEFAULT 'None',
      mx_records_json TEXT,
      is_free INTEGER NOT NULL DEFAULT 0,
      is_disposable INTEGER NOT NULL DEFAULT 0,
      email_verdict TEXT NOT NULL DEFAULT 'valid',
      feedback_notes TEXT,
      last_checked_at TEXT NOT NULL
    );
  `);
  return db;
}

function makeEnv(db: any): AdminEnv {
  return { DB: new FakeD1(db) } as unknown as AdminEnv;
}

function seedCompany(db: any, id: string, domain: string | null): void {
  db.prepare("INSERT INTO crm_companies (id, name, domain) VALUES (?, ?, ?)").run(id, `Name ${id}`, domain);
}

function seedContact(db: any, id: string, companyId: string, email: string | null): void {
  db.prepare("INSERT INTO crm_contacts (id, company_id, full_name, email) VALUES (?, ?, ?, ?)")
    .run(id, companyId, "John Doe", email);
}

/* ── DoH stub：cloudflare-dns.com JSON API，按 zones 表返回记录 ──────────── */

interface DohZone {
  a?: string[];
  mx?: string[];
  txt?: string[];
}

const DOH = "https://cloudflare-dns.com/dns-query";

function stubDoh(zones: Record<string, DohZone>) {
  return vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    if (!url.href.startsWith(DOH)) return new Response("not found", { status: 404 });
    const name = url.searchParams.get("name") ?? "";
    const type = url.searchParams.get("type") ?? "";
    const zone = zones[name];
    let answers: Array<{ name: string; type: number; data: string }> = [];
    if (zone) {
      const byType: Record<string, number> = { A: 1, MX: 15, TXT: 16 };
      const records = type === "A" ? zone.a : type === "MX" ? zone.mx : type === "TXT" ? zone.txt : [];
      for (const data of records ?? []) answers.push({ name, type: byType[type], data });
    }
    return new Response(JSON.stringify({ Status: 0, Answer: answers }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ── 纯函数 ──────────────────────────────────────────────────────────────── */

describe("normalizeDomain / extractEmailDomain", () => {
  it("剥离协议、www、路径、端口、大小写与尾点", () => {
    expect(normalizeDomain("  https://WWW.Example.com/pricing?q=1 ")).toBe("example.com");
    expect(normalizeDomain("example.com:8080")).toBe("example.com");
    expect(normalizeDomain("example.com.")).toBe("example.com");
    expect(normalizeDomain("www.example.co.uk")).toBe("example.co.uk");
  });

  it("从邮箱地址提取域名，非法输入返回 null", () => {
    expect(extractEmailDomain("john@Example.COM")).toBe("example.com");
    expect(extractEmailDomain("a@b")).toBeNull();
    expect(extractEmailDomain("@example.com")).toBeNull();
    expect(extractEmailDomain("john@")).toBeNull();
  });
});

describe("免费/一次性邮箱识别", () => {
  it("免费邮箱名单", () => {
    expect(isFreeEmailDomain("gmail.com")).toBe(true);
    expect(isFreeEmailDomain("outlook.com")).toBe(true);
    expect(isFreeEmailDomain("example.com")).toBe(false);
  });

  it("一次性名单 + 特征正则兜底", () => {
    expect(isDisposableEmailDomain("mailinator.com")).toBe(true);
    expect(isDisposableEmailDomain("yopmail.fr")).toBe(true);
    expect(isDisposableEmailDomain("my-tempmail.xyz")).toBe(true); // 正则命中
    expect(isDisposableEmailDomain("example.com")).toBe(false);
  });
});

describe("detectMailProvider 邮局指纹", () => {
  it("常见企业邮局指纹", () => {
    expect(detectMailProvider(["10 aspmx.l.google.com"])).toBe("Google Workspace");
    expect(detectMailProvider(["5 acme-com.mail.protection.outlook.com"])).toBe("Microsoft 365");
    expect(detectMailProvider(["10 mx.zoho.com"])).toBe("Zoho Mail");
    expect(detectMailProvider(["10 mx1.example-com.mimecast.com"])).toBe("Mimecast（高安全网关）");
    expect(detectMailProvider(["10 mxbiz1.qq.com"])).toBe("腾讯邮箱");
    expect(detectMailProvider(["10 mx.example.com"])).toBe("Self-Hosted / Other");
    expect(detectMailProvider([])).toBe("None");
  });
});

/* ── verifyDomain ────────────────────────────────────────────────────────── */

describe("verifyDomain 判定", () => {
  it("免费邮箱短路：不打 DoH 直接 free_email", async () => {
    const fetchMock = stubDoh({});
    vi.stubGlobal("fetch", fetchMock);
    const r = await verifyDomain("gmail.com");
    expect(r.verdict).toBe("free_email");
    expect(r.is_free).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("一次性邮箱短路：不打 DoH 直接 disposable", async () => {
    const fetchMock = stubDoh({});
    vi.stubGlobal("fetch", fetchMock);
    const r = await verifyDomain("mailinator.com");
    expect(r.verdict).toBe("disposable");
    expect(r.is_disposable).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("无顶级域的非法输入按 dead_domain 保守处理", async () => {
    const r = await verifyDomain("not-a-domain");
    expect(r.verdict).toBe("dead_domain");
  });

  it("有 MX → valid（含 SPF/A 汇总）", async () => {
    vi.stubGlobal("fetch", stubDoh({
      "example.com": {
        a: ["93.184.216.34"],
        mx: ["10 mail.example.com"],
        txt: ['"v=spf1 include:_spf.example.com ~all"'],
      },
    }));
    const r = await verifyDomain("example.com");
    expect(r.verdict).toBe("valid");
    expect(r.has_mx_record).toBe(1);
    expect(r.has_spf_record).toBe(1);
    expect(r.has_a_record).toBe(1);
    expect(r.mx_provider).toBe("Self-Hosted / Other");
  });

  it("只有 A 无 MX → no_mx", async () => {
    vi.stubGlobal("fetch", stubDoh({ "a-only.com": { a: ["1.2.3.4"] } }));
    const r = await verifyDomain("a-only.com");
    expect(r.verdict).toBe("no_mx");
    expect(r.has_a_record).toBe(1);
    expect(r.has_mx_record).toBe(0);
  });

  it('RFC 7505 Null MX（"0 ."）视为无 MX', async () => {
    vi.stubGlobal("fetch", stubDoh({ "nullmx.com": { a: ["1.2.3.4"], mx: ["0 ."] } }));
    const r = await verifyDomain("nullmx.com");
    expect(r.verdict).toBe("no_mx");
    expect(r.has_mx_record).toBe(0);
  });

  it("A/MX 全无 → dead_domain", async () => {
    vi.stubGlobal("fetch", stubDoh({}));
    const r = await verifyDomain("gone.example");
    expect(r.verdict).toBe("dead_domain");
    expect(r.has_a_record).toBe(0);
  });
});

/* ── 缓存 + tick ─────────────────────────────────────────────────────────── */

describe("runEmailScreeningTick", () => {
  it("pending 公司与联系人被筛查、状态回写、同域名去重（1 组 DoH 查询）", async () => {
    const db = makeDb();
    seedCompany(db, "co1", "example.com");
    seedContact(db, "ct1", "co1", "john@example.com");
    const fetchMock = stubDoh({
      "example.com": { a: ["1.2.3.4"], mx: ["10 mail.example.com"], txt: ['"v=spf1 -all"'] },
    });
    vi.stubGlobal("fetch", fetchMock);

    const report = await runEmailScreeningTick(makeEnv(db));
    expect(report.companies).toBe(1);
    expect(report.contacts).toBe(1);
    expect(report.domains_checked).toBe(1); // 公司域名与联系人邮箱共享一次检测
    expect(fetchMock).toHaveBeenCalledTimes(3); // A + MX + TXT

    expect(db.prepare("SELECT domain_email_status FROM crm_companies WHERE id = 'co1'").get())
      .toMatchObject({ domain_email_status: "valid" });
    expect(db.prepare("SELECT email_check_status FROM crm_contacts WHERE id = 'ct1'").get())
      .toMatchObject({ email_check_status: "valid" });
    // valid 不写时间线
    expect(db.prepare("SELECT COUNT(*) AS n FROM crm_activities").get()).toMatchObject({ n: 0 });
    // 缓存已落库
    expect(db.prepare("SELECT email_verdict, mx_provider FROM domain_dns_checks WHERE domain = 'example.com'").get())
      .toMatchObject({ email_verdict: "valid", mx_provider: "Self-Hosted / Other" });
  });

  it("异常判定（dead_domain）写时间线提醒", async () => {
    const db = makeDb();
    seedCompany(db, "co1", "dead.example");
    vi.stubGlobal("fetch", stubDoh({}));

    const report = await runEmailScreeningTick(makeEnv(db));
    expect(report.companies).toBe(1);
    const note = db.prepare("SELECT type, summary FROM crm_activities WHERE company_id = 'co1'").get() as any;
    expect(note.type).toBe("note");
    expect(String(note.summary)).toContain("邮箱检测异常");
    expect(db.prepare("SELECT domain_email_status FROM crm_companies WHERE id = 'co1'").get())
      .toMatchObject({ domain_email_status: "dead_domain" });
  });

  it("30 天内缓存直接复用，不再打 DoH", async () => {
    const db = makeDb();
    seedCompany(db, "co1", "cached.com");
    seedContact(db, "ct1", "co1", "john@cached.com");
    db.prepare(
      `INSERT INTO domain_dns_checks (domain, has_a_record, has_mx_record, has_spf_record, mx_provider,
        mx_records_json, is_free, is_disposable, email_verdict, feedback_notes, last_checked_at)
       VALUES ('cached.com', 1, 1, 0, 'Zoho Mail', '["10 mx.zoho.com"]', 0, 0, 'valid', 'ok', ?)`,
    ).run(new Date().toISOString());
    const fetchMock = stubDoh({});
    vi.stubGlobal("fetch", fetchMock);

    const report = await runEmailScreeningTick(makeEnv(db));
    expect(report.companies).toBe(1);
    expect(report.contacts).toBe(1);
    expect(report.domains_checked).toBe(0); // 全部走缓存
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prepare("SELECT email_check_status FROM crm_contacts WHERE id = 'ct1'").get())
      .toMatchObject({ email_check_status: "valid" });
  });

  it("新域名预算上限：13 个 pending 域名只检 12 个，剩余留待下个 tick", async () => {
    const db = makeDb();
    const zones: Record<string, DohZone> = {};
    for (let i = 1; i <= 13; i++) {
      const d = `budget${i}.com`;
      seedCompany(db, `co${i}`, d);
      zones[d] = { a: ["1.2.3.4"], mx: ["10 mail.example.com"] };
    }
    vi.stubGlobal("fetch", stubDoh(zones));

    const report = await runEmailScreeningTick(makeEnv(db));
    expect(report.domains_checked).toBe(12);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM crm_companies WHERE domain_email_status = 'pending'").get(),
    ).toMatchObject({ n: 1 });
  });

  it("migration 未应用（列缺失）→ 零报告 fail-open", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE crm_companies (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const fetchMock = stubDoh({});
    vi.stubGlobal("fetch", fetchMock);

    const report = await runEmailScreeningTick(makeEnv(db));
    expect(report).toMatchObject({ companies: 0, contacts: 0, domains_checked: 0, errors: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("免费邮箱联系人走短路，不打 DoH", async () => {
    const db = makeDb();
    seedCompany(db, "co1", null);
    seedContact(db, "ct1", "co1", "someone@gmail.com");
    const fetchMock = stubDoh({});
    vi.stubGlobal("fetch", fetchMock);

    const report = await runEmailScreeningTick(makeEnv(db));
    expect(report.contacts).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prepare("SELECT email_check_status FROM crm_contacts WHERE id = 'ct1'").get())
      .toMatchObject({ email_check_status: "free_email" });
  });
});

/* ── 面板重检 + 列表 ─────────────────────────────────────────────────────── */

describe("recheck / listDomainChecks", () => {
  it("recheckCompanyDomainInDb 强制重检并覆盖过期缓存", async () => {
    const db = makeDb();
    seedCompany(db, "co1", "refresh.com");
    // 40 天前的旧缓存（已过期）
    db.prepare(
      `INSERT INTO domain_dns_checks (domain, has_a_record, has_mx_record, mx_provider, email_verdict, last_checked_at)
       VALUES ('refresh.com', 0, 0, 'None', 'dead_domain', ?)`,
    ).run(new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString());
    vi.stubGlobal("fetch", stubDoh({
      "refresh.com": { a: ["1.2.3.4"], mx: ["10 aspmx.l.google.com"] },
    }));

    const r = await recheckCompanyDomainInDb(makeEnv(db), "co1");
    expect(r.verdict).toBe("valid");
    expect(r.mx_provider).toBe("Google Workspace");
    expect(db.prepare("SELECT domain_email_status FROM crm_companies WHERE id = 'co1'").get())
      .toMatchObject({ domain_email_status: "valid" });
    // upsert：同一行被更新而非新增
    expect(db.prepare("SELECT COUNT(*) AS n FROM domain_dns_checks WHERE domain = 'refresh.com'").get())
      .toMatchObject({ n: 1 });
    expect(db.prepare("SELECT email_verdict FROM domain_dns_checks WHERE domain = 'refresh.com'").get())
      .toMatchObject({ email_verdict: "valid" });
  });

  it("recheckCompanyDomainInDb 公司不存在 / 无域名时报错", async () => {
    const db = makeDb();
    seedCompany(db, "co1", null);
    vi.stubGlobal("fetch", stubDoh({}));
    await expect(recheckCompanyDomainInDb(makeEnv(db), "missing")).rejects.toThrow("公司不存在");
    await expect(recheckCompanyDomainInDb(makeEnv(db), "co1")).rejects.toThrow("没有域名");
  });

  it("recheckContactEmailInDb 回写联系人状态并在异常时记时间线", async () => {
    const db = makeDb();
    seedCompany(db, "co1", "example.com");
    seedContact(db, "ct1", "co1", "tmp@mailinator.com");
    const fetchMock = stubDoh({});
    vi.stubGlobal("fetch", fetchMock);

    const r = await recheckContactEmailInDb(makeEnv(db), "ct1");
    expect(r.verdict).toBe("disposable");
    expect(fetchMock).not.toHaveBeenCalled(); // 名单短路
    expect(db.prepare("SELECT email_check_status FROM crm_contacts WHERE id = 'ct1'").get())
      .toMatchObject({ email_check_status: "disposable" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM crm_activities WHERE company_id = 'co1'").get())
      .toMatchObject({ n: 1 });
  });

  it("recheckContactEmailInDb 联系人不存在 / 无邮箱时报错", async () => {
    const db = makeDb();
    seedCompany(db, "co1", "example.com");
    seedContact(db, "ct1", "co1", null);
    vi.stubGlobal("fetch", stubDoh({}));
    await expect(recheckContactEmailInDb(makeEnv(db), "missing")).rejects.toThrow("联系人不存在");
    await expect(recheckContactEmailInDb(makeEnv(db), "ct1")).rejects.toThrow("没有可用邮箱");
  });

  it("listDomainChecks 返回最近检测 + 状态聚合", async () => {
    const db = makeDb();
    seedCompany(db, "co1", "example.com");
    seedCompany(db, "co2", null);
    seedContact(db, "ct1", "co1", "john@example.com");
    db.prepare(
      `INSERT INTO domain_dns_checks (domain, has_a_record, has_mx_record, has_spf_record, mx_provider,
        mx_records_json, is_free, is_disposable, email_verdict, feedback_notes, last_checked_at)
       VALUES ('example.com', 1, 1, 1, 'Google Workspace', '["10 aspmx.l.google.com"]', 0, 0, 'valid', 'ok', ?)`,
    ).run("2026-01-02T03:04:05.000Z");

    const res = await listDomainChecks(makeEnv(db));
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text()) as {
      checks: Array<{ domain: string; verdict: string; last_checked_at: string; mx_provider: string }>;
      company_counts: Array<{ status: string; n: number }>;
      contact_counts: Array<{ status: string; n: number }>;
    };
    expect(body.checks).toHaveLength(1);
    expect(body.checks[0]).toMatchObject({
      domain: "example.com",
      verdict: "valid",
      mx_provider: "Google Workspace",
      last_checked_at: "2026-01-02T03:04:05.000Z",
    });
    expect(body.company_counts).toContainEqual({ status: "pending", n: 2 });
    expect(body.contact_counts).toContainEqual({ status: "pending", n: 1 });
  });
});
