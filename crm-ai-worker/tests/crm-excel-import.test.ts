import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { handleCrmApi } from "../src/crm";
import {
  cleanDomainValue,
  decodeBase64,
  detectEntity,
  excelSerialToIsoDate,
  listZipEntries,
  matchColumns,
  matchHeader,
  normalizeStageValue,
  parseXlsx,
} from "../src/crm-excel-import";
import type { AdminAuthContext, AdminEnv } from "../src/admin";

/* Excel 智能导入（更新.txt 阶段五后续）：零依赖 xlsx 解析、模糊表头匹配、
 * 实体自动识别、值清洗（URL 域名 / Excel 日期序列号 / 中文阶段），
 * 以及 handleCrmApi 集成（xlsx_base64 入口 + 响应列映射报告）。 */

/* ── 测试用 xlsx 构建（内存 ZIP：stored + deflate 两种压缩） ──────────────── */

function u16(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff];
}

function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as unknown as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface ZipFile {
  name: string;
  content: string;
  /** true = method 8 (deflate-raw)；默认 stored (method 0)。 */
  deflate?: boolean;
}

async function buildZip(files: ZipFile[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const local: number[] = [];
  const central: number[] = [];
  for (const f of files) {
    const nameBytes = Array.from(enc.encode(f.name));
    const data = enc.encode(f.content);
    const payload = f.deflate ? await deflateRaw(data) : data;
    const localOff = local.length;
    local.push(
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(f.deflate ? 8 : 0),
      ...u32(0), ...u32(0), ...u32(payload.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0),
      ...nameBytes, ...Array.from(payload),
    );
    central.push(
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(f.deflate ? 8 : 0),
      ...u32(0), ...u32(0), ...u32(payload.length), ...u32(data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(localOff), ...nameBytes,
    );
  }
  const cdOff = local.length;
  return new Uint8Array([
    ...local,
    ...central,
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(central.length), ...u32(cdOff), ...u16(0),
  ]);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 0 → A、1 → B …（单元格列引用）。 */
function colRef(c: number): string {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

type Cell =
  | { kind: "inline"; v: string }
  | { kind: "num"; v: string }
  | { kind: "shared"; idx: number };

/** 行列 → sheet XML（inlineStr / 数字 / sharedStrings 引用三种单元格）。 */
function sheetXml(rows: Cell[][]): string {
  let body = "";
  rows.forEach((cells, r) => {
    let cs = "";
    cells.forEach((cell, c) => {
      const ref = `${colRef(c)}${r + 1}`;
      if (cell.kind === "inline") {
        cs += `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(cell.v)}</t></is></c>`;
      } else if (cell.kind === "num") {
        cs += `<c r="${ref}"><v>${cell.v}</v></c>`;
      } else {
        cs += `<c r="${ref}" t="s"><v>${cell.idx}</v></c>`;
      }
    });
    body += `<row r="${r + 1}">${cs}</row>`;
  });
  return `<?xml version="1.0"?><worksheet><sheetData>${body}</sheetData></worksheet>`;
}

function sharedStringsXml(items: string[]): string {
  return (
    `<?xml version="1.0"?><sst count="${items.length}" uniqueCount="${items.length}">` +
    items.map((t) => `<si><t>${escapeXml(t)}</t></si>`).join("") +
    `</sst>`
  );
}

function inline(rows: string[][]): Cell[][] {
  return rows.map((r) => r.map((v) => ({ kind: "inline", v }) as Cell));
}

/* ── handleCrmApi 测试基座（与 crm-graph.test.ts 同构） ────────────────────── */

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
      id TEXT PRIMARY KEY, actor_user_id TEXT, actor_role TEXT,
      action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT,
      request_id TEXT, metadata_json TEXT, ip_hash TEXT, user_agent_hash TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function makeEnv() {
  const db = makeDb();
  return { db, env: { DB: new FakeD1(db) } as unknown as AdminEnv };
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

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ── ZIP / parseXlsx 单元 ─────────────────────────────────────────────────── */

describe("parseXlsx（零依赖 ZIP + sheet XML 解析）", () => {
  it("stored 条目：inlineStr 单元格 → 行列矩阵，空单元格补空串", async () => {
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([
        ["公司", "姓名", "邮箱"],
        ["Acme", "张三", "zhang@acme.com"],
        ["Bob Corp", "", "bob@bob.com"],
      ])) },
    ]);
    const rows = await parseXlsx(xlsx);
    expect(rows).toEqual([
      ["公司", "姓名", "邮箱"],
      ["Acme", "张三", "zhang@acme.com"],
      ["Bob Corp", "", "bob@bob.com"],
    ]);
  });

  it("deflate(method 8) 条目同样可读", async () => {
    const content = sheetXml(inline([["名称", "域名"], ["Acme", "acme.com"]]));
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content, deflate: true },
    ]);
    const rows = await parseXlsx(xlsx);
    expect(rows).toEqual([["名称", "域名"], ["Acme", "acme.com"]]);
  });

  it("sharedStrings 引用 + 富文本 run 拼接 + 数字单元格", async () => {
    const content =
      `<?xml version="1.0"?><worksheet><sheetData>` +
      `<row r="1">` +
      `<c r="A1" t="s"><v>0</v></c>` +
      `<c r="B1" t="s"><v>1</v></c>` +
      `<c r="C1"><v>45658</v></c>` +
      `</row></sheetData></worksheet>`;
    const shared = `<?xml version="1.0"?><sst>` +
      `<si><r><t>客户</t></r><r><t>名称</t></r></si>` +
      `<si><t>金额</t></si></sst>`;
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content },
      { name: "xl/sharedStrings.xml", content: shared },
    ]);
    const rows = await parseXlsx(xlsx);
    expect(rows).toEqual([["客户名称", "金额", "45658"]]);
  });

  it("按文件名数字序取第一张 sheet（sheet1 优先于 sheet2）", async () => {
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet2.xml", content: sheetXml(inline([["不是这张"]])) },
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([["是这张"], ["数据"]])) },
    ]);
    const rows = await parseXlsx(xlsx);
    expect(rows).toEqual([["是这张"], ["数据"]]);
  });

  it("XML 实体解码（&amp; / &lt; / 数字实体）", async () => {
    const content =
      `<?xml version="1.0"?><worksheet><sheetData>` +
      `<row r="1"><c r="A1" t="inlineStr"><is>` +
      `<t>A &amp; B &lt;Co&gt; &#x4e2d;&#25991;</t>` +
      `</is></c></row></sheetData></worksheet>`;
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content },
    ]);
    const rows = await parseXlsx(xlsx);
    expect(rows[0][0]).toBe("A & B <Co> 中文");
  });

  it("非 ZIP 内容 → 报错；listZipEntries 可列出条目", async () => {
    await expect(parseXlsx(new Uint8Array([1, 2, 3]))).rejects.toThrow(/不是有效的/);
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([["x"]])) },
      { name: "dir/", content: "" },
    ]);
    const names = listZipEntries(xlsx).map((e) => e.name);
    expect(names).toEqual(["xl/worksheets/sheet1.xml"]); // 目录项被忽略
  });

  it("decodeBase64 还原字节", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    expect(decodeBase64(b64(bytes))).toEqual(bytes);
  });
});

/* ── 智能列匹配 / 实体识别 / 值清洗单元 ───────────────────────────────────── */

describe("matchHeader / matchColumns / detectEntity", () => {
  it("后缀优先：联系人邮箱 → email（不被「联系人」抢成 full_name）", () => {
    expect(matchHeader("contacts", "联系人邮箱")).toBe("email");
    expect(matchHeader("contacts", "联系人姓名")).toBe("full_name");
  });

  it("归一化后精确匹配：空格/括号/大小写/冒号无关", () => {
    expect(matchHeader("companies", "Customer Name")).toBe("name");
    expect(matchHeader("companies", "客户名称（必填）")).toBe("name");
    expect(matchHeader("deals", "预计成交日期：")).toBe("expected_close_date");
    expect(matchHeader("deals", "Closedate")).toBe("expected_close_date");
  });

  it("包含匹配取最长别名：新手机号 → whatsapp_or_phone", () => {
    expect(matchHeader("contacts", "新手机号")).toBe("whatsapp_or_phone");
  });

  it("matchColumns：一列一字段，重复列第二列让位", () => {
    const { keyByIndex, keys } = matchColumns("companies", ["客户名称", "公司", "网址"]);
    expect(keyByIndex).toEqual(["name", null, "domain"]); // 公司 与 客户名称 都归 name，第二列让位
    expect(keys.has("name")).toBe(true);
    expect(keys.has("domain")).toBe(true);
  });

  it("detectEntity：contacts → deals → companies 顺序识别", () => {
    expect(detectEntity(["公司", "姓名", "邮箱"])).toBe("contacts");
    expect(detectEntity(["公司名称", "商机名称", "金额"])).toBe("deals");
    expect(detectEntity(["公司名称", "国家"])).toBe("companies");
    expect(detectEntity(["乱七八糟"])).toBe("companies"); // 兜底
  });

  it("cleanDomainValue：URL/前缀 www/尾斜杠清洗", () => {
    expect(cleanDomainValue("https://www.Acme.com/path/")).toBe("acme.com");
    expect(cleanDomainValue("http://Acme.com")).toBe("acme.com");
    expect(cleanDomainValue("WWW.Example.com/")).toBe("example.com");
    expect(cleanDomainValue("acme.com")).toBe("acme.com");
    expect(cleanDomainValue("  ")).toBe("");
  });

  it("excelSerialToIsoDate：5 位序列号转 ISO，其余原样", () => {
    expect(excelSerialToIsoDate("45658")).toBe("2025-01-01"); // Excel 序列号（45292 = 2024-01-01）
    expect(excelSerialToIsoDate("25569")).toBe("1970-01-01");
    expect(excelSerialToIsoDate("2026-12-01")).toBe("2026-12-01");
    expect(excelSerialToIsoDate("12345")).toBe("12345"); // 序列号过小 → 原样
  });

  it("normalizeStageValue：中文阶段 → 英文；未知原样", () => {
    expect(normalizeStageValue("询盘")).toBe("inquiry");
    expect(normalizeStageValue("样品报价")).toBe("sample_quoted");
    expect(normalizeStageValue("已收定金")).toBe("deposit_paid");
    expect(normalizeStageValue("赢单")).toBe("won");
    expect(normalizeStageValue("输单")).toBe("lost");
    expect(normalizeStageValue("won")).toBe("won");
    expect(normalizeStageValue("bogus_stage")).toBe("bogus_stage");
  });
});

/* ── handleCrmApi 集成：xlsx_base64 / auto / 列映射报告 ──────────────────── */

describe("POST /admin/api/crm/import — Excel 智能导入", () => {
  it("模糊中文表头 + URL 域名 → companies 自动识别，返回列映射报告", async () => {
    const { env } = makeEnv();
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([
        ["客户名称", "网址", "国家地区", "客户分级", "无关列"],
        ["Acme 有限公司", "https://www.acme.com/about", "德国", "A", "x"],
      ])) },
    ]);
    const r = await call(env, "POST", "/admin/api/crm/import", {
      xlsx_base64: b64(xlsx),
    });
    expect(r.status).toBe(200);
    expect(r.body.entity_used).toBe("companies");
    expect(r.body.created).toBe(1);
    expect(r.body.columns).toMatchObject({
      客户名称: "name", 网址: "domain", 国家地区: "country", 客户分级: "tier",
    });
    expect(r.body.unmapped).toEqual(["无关列"]);

    const list = await call(env, "GET", "/admin/api/crm/companies?limit=200");
    const co = list.body.companies.find((c: any) => c.name === "Acme 有限公司");
    expect(co.domain).toBe("acme.com"); // URL → 域名清洗
    expect(co.country).toBe("德国");
    expect(co.tier).toBe("A");
  });

  it("联系人表自动识别，公司不存在自动创建", async () => {
    const { env } = makeEnv();
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([
        ["公司名称", "联系人姓名", "Email", "手机号码"],
        ["Acme", "张三", "zhang@acme.com", "+49 151 1234567"],
      ])) },
    ]);
    const r = await call(env, "POST", "/admin/api/crm/import", {
      entity: "auto",
      xlsx_base64: b64(xlsx),
    });
    expect(r.status).toBe(200);
    expect(r.body.entity_used).toBe("contacts");
    expect(r.body.created).toBe(1);
    expect(r.body.companies_created).toBe(1);

    const list = await call(env, "GET", "/admin/api/crm/companies?limit=200");
    const co = await call(env, "GET", `/admin/api/crm/companies/${list.body.companies[0].id}`);
    expect(co.body.contacts).toHaveLength(1);
    expect(co.body.contacts[0]).toMatchObject({
      full_name: "张三", email: "zhang@acme.com", whatsapp_or_phone: "+49 151 1234567",
    });
  });

  it("商机表：Excel 日期序列号 + 中文阶段（赢单）+ 自动建公司 + customer_since", async () => {
    const { env } = makeEnv();
    const content = sheetXml([
      [
        { kind: "inline", v: "公司" }, { kind: "inline", v: "订单名称" },
        { kind: "inline", v: "阶段" }, { kind: "inline", v: "金额" },
        { kind: "inline", v: "预计成交日期" },
      ],
      [
        { kind: "inline", v: "Acme" }, { kind: "inline", v: "大单" },
        { kind: "inline", v: "赢单" }, { kind: "num", v: "1200" },
        { kind: "num", v: "45658" },
      ],
    ]);
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content },
    ]);
    const r = await call(env, "POST", "/admin/api/crm/import", {
      xlsx_base64: b64(xlsx),
    });
    expect(r.status).toBe(200);
    expect(r.body.entity_used).toBe("deals");
    expect(r.body.created).toBe(1);

    const list = await call(env, "GET", "/admin/api/crm/deals");
    expect(list.body.deals).toHaveLength(1);
    expect(list.body.deals[0]).toMatchObject({
      title: "大单",
      stage: "won",
      amount: 1200,
      expected_close_date: "2025-01-01", // Excel 序列号 45658
      won_at: new Date().toISOString().slice(0, 10),
    });
    const co = await call(env, "GET", "/admin/api/crm/companies?limit=200");
    expect(co.body.companies[0].customer_since).toBe(new Date().toISOString().slice(0, 10));
  });

  it("非 ZIP 的 xlsx_base64 → 400；旧版 .xls（D0 CF 头）→ 400 并提示另存", async () => {
    const { env } = makeEnv();
    const bad = await call(env, "POST", "/admin/api/crm/import", {
      xlsx_base64: b64(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])),
    });
    expect(bad.status).toBe(400);
    expect(String(bad.body.detail)).toMatch(/xlsx|ZIP|工作表|表头/);

    const xls = await call(env, "POST", "/admin/api/crm/import", {
      xlsx_base64: b64(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4, 5, 6])),
    });
    expect(xls.status).toBe(400);
    expect(String(xls.body.detail)).toContain(".xls");
  });

  it("CSV 路径同样享受智能匹配：模糊表头 + entity 省略 → auto + 列映射报告", async () => {
    const { env } = makeEnv();
    const csv = ["客户名称,官网", "Beta 公司,https://www.beta.com"].join("\n");
    const r = await call(env, "POST", "/admin/api/crm/import", { csv });
    expect(r.status).toBe(200);
    expect(r.body.entity_used).toBe("companies");
    expect(r.body.columns).toMatchObject({ 客户名称: "name", 官网: "domain" });
    expect(r.body.created).toBe(1);

    const list = await call(env, "GET", "/admin/api/crm/companies?limit=200");
    expect(list.body.companies[0].domain).toBe("beta.com");
  });

  it("CSV 联系人邮箱后缀匹配 → email 字段（回归旧表头行为兼容）", async () => {
    const { env } = makeEnv();
    const csv = ["公司,联系人邮箱,姓名", "Acme,a@acme.com,李四"].join("\n");
    const r = await call(env, "POST", "/admin/api/crm/import", { entity: "contacts", csv });
    expect(r.status).toBe(200);
    expect(r.body.entity_used).toBe("contacts");
    expect(r.body.created).toBe(1);

    const list = await call(env, "GET", "/admin/api/crm/companies?limit=200");
    const co = await call(env, "GET", `/admin/api/crm/companies/${list.body.companies[0].id}`);
    expect(co.body.contacts[0]).toMatchObject({ full_name: "李四", email: "a@acme.com" });
  });
});
