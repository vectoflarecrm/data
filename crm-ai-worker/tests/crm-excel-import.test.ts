import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { handleCrmApi } from "../src/crm";
import {
  cleanDomainValue,
  decodeBase64,
  detectEntity,
  excelSerialToIsoDate,
  hasContactName,
  isExcelErrorValue,
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
      address TEXT, external_id TEXT, dealer_brands TEXT,
      legal_name TEXT, trading_name TEXT, zip_city TEXT, city TEXT, region TEXT,
      postal_code TEXT, country_code TEXT, tel TEXT, whatsapp TEXT,
      products_services TEXT, business_tag TEXT, company_type TEXT, business_model TEXT,
      founded_year TEXT, employee_range TEXT, description TEXT, target_markets TEXT,
      customer_segment TEXT, product_categories TEXT, company_size TEXT,
      geographic_coverage TEXT,
      is_manufacturer INTEGER DEFAULT 0, is_importer INTEGER DEFAULT 0,
      is_distributor INTEGER DEFAULT 0, is_wholesaler INTEGER DEFAULT 0,
      is_retailer INTEGER DEFAULT 0, is_ecommerce INTEGER DEFAULT 0,
      is_rental INTEGER DEFAULT 0, is_oem INTEGER DEFAULT 0,
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

  it("真实 xlsx 布局：[Content_Types].xml 等非工作表条目排在前面也能选中 sheet1（回归）", async () => {
    // 真实导出的 xlsx 第一个条目恒为 [Content_Types].xml；曾经 filter 用
    // `x.n !== null` 判空（?.[1] 失败产生 undefined 而非 null）导致恒真，
    // sheets[0] 错拿 [Content_Types].xml → parse 出 0 行、导入必败。
    const xlsx = await buildZip([
      { name: "[Content_Types].xml", content: '<?xml version="1.0"?><Types/>' },
      { name: "_rels/.rels", content: '<?xml version="1.0"?><Relationships/>' },
      { name: "xl/workbook.xml", content: '<?xml version="1.0"?><workbook/>' },
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([["公司"], ["Acme"]])) },
      { name: "xl/sharedStrings.xml", content: sharedStringsXml([]) },
      { name: "docProps/core.xml", content: '<?xml version="1.0"?><coreProperties/>' },
    ]);
    const rows = await parseXlsx(xlsx);
    expect(rows).toEqual([["公司"], ["Acme"]]);
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

  it("包含匹配取最长别名：新手机号 → cellphone（拆分电话键）", () => {
    expect(matchHeader("contacts", "新手机号")).toBe("cellphone");
  });

  it("拆分电话列：TEL / Cellphone / WhatsApp 各归各键，不再互相抢占", () => {
    expect(matchHeader("contacts", "TEL")).toBe("tel");
    expect(matchHeader("contacts", "Telephone")).toBe("tel");
    expect(matchHeader("contacts", "Phone Number")).toBe("tel");
    expect(matchHeader("contacts", "联系电话")).toBe("tel");
    expect(matchHeader("contacts", "Cellphone")).toBe("cellphone");
    expect(matchHeader("contacts", "Mobile")).toBe("cellphone");
    expect(matchHeader("contacts", "手机号码")).toBe("cellphone");
    expect(matchHeader("contacts", "WhatsApp")).toBe("whatsapp");
  });

  it("拆分姓名列：First Name / Last Name 各归各键（Puerto Rico 表布局）", () => {
    expect(matchHeader("contacts", "First Name")).toBe("first_name");
    expect(matchHeader("contacts", "Last Name")).toBe("last_name");
    expect(matchHeader("contacts", "姓氏")).toBe("last_name");
    expect(matchHeader("contacts", "姓名")).toBe("full_name"); // 单列姓名不变
  });

  it("产品与服务类列 → companies.products_services（0042 与行业分开保存）", () => {
    expect(matchHeader("companies", "Products & Services in English")).toBe("products_services");
    expect(matchHeader("companies", "产品与服务")).toBe("products_services");
    expect(matchHeader("companies", "主营产品")).toBe("products_services");
    expect(matchHeader("companies", "行业")).toBe("industry");
  });

  it("法定/交易名称列不被 deals 抢成 title（公司表不误判成商机表）", () => {
    // 0042 companies 新增 法定名称/交易名称 别名后，deals 的「名称」包含匹配
    // 会把它们抢成商机名 → 公司名称 + 法定名称 的公司表被识别成 deals。
    expect(matchHeader("deals", "法定名称")).toBeNull();
    expect(matchHeader("deals", "交易名称")).toBeNull();
    expect(matchHeader("deals", "Legal Name")).toBeNull();
    expect(matchHeader("companies", "法定名称")).toBe("legal_name");
    expect(matchHeader("companies", "Legal Name")).toBe("legal_name");
    // 公司表识别：公司名称 + 法定名称 → companies（不再落 deals）
    expect(detectEntity(["公司名称", "法定名称", "成立年份"])).toBe("companies");
    // 真商机表不受影响：商机名称 等别名照常识别
    expect(detectEntity(["公司名称", "商机名称", "金额"])).toBe("deals");
    expect(matchHeader("deals", "商机名称")).toBe("title");
  });

  it("detectEntity：拆分姓名（First/Last Name）+ 公司 → contacts", () => {
    expect(detectEntity(["company name", "First Name", "Last Name", "EMAIL"])).toBe("contacts");
    expect(hasContactName(new Set(["first_name", "last_name"]))).toBe(true);
    expect(hasContactName(new Set(["company"]))).toBe(false);
  });

  it("isExcelErrorValue：#N/A 等公式错误字面量按空值处理", () => {
    expect(isExcelErrorValue("#N/A")).toBe(true);
    expect(isExcelErrorValue("#n/a")).toBe(true);
    expect(isExcelErrorValue("#N/A/N/A")).toBe(true); // WPS 变体
    expect(isExcelErrorValue("#REF!")).toBe(true);
    expect(isExcelErrorValue("#DIV/0!")).toBe(true);
    expect(isExcelErrorValue("N/A")).toBe(false); // 无 # 前缀是普通文本
    expect(isExcelErrorValue("#Acme")).toBe(false);
  });

  it("0041 扩展属性：Street address / company ID / from 各归新列", () => {
    expect(matchHeader("companies", "Street address")).toBe("address");
    expect(matchHeader("companies", "street")).toBe("address");
    expect(matchHeader("companies", "地址")).toBe("address");
    expect(matchHeader("companies", "company ID")).toBe("external_id");
    expect(matchHeader("companies", "公司编号")).toBe("external_id");
    expect(matchHeader("companies", "from")).toBe("dealer_brands");
    expect(matchHeader("companies", "经销品牌")).toBe("dealer_brands");
    expect(matchHeader("companies", "Distributors")).toBe("dealer_brands");
    // contacts 整表视角：from / company ID 不误吸字段（company name 先占 company，
    // company ID 的包含匹配被 taken 拦下 → 保持未识别，由 companyMap 接管）。
    const { keyByIndex } = matchColumns("contacts", ["company ID", "company name", "from"]);
    expect(keyByIndex).toEqual([null, "company", null]);
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

  it("cleanDomainValue：社交平台主页 URL 不是公司域名（多家共用会撞唯一约束/错配）", () => {
    expect(cleanDomainValue("https://www.facebook.com/1OceanWatersportsPR/")).toBe("");
    expect(cleanDomainValue("https://m.facebook.com/x")).toBe("");
    expect(cleanDomainValue("instagram.com/someone")).toBe("");
    expect(cleanDomainValue("https://www.linkedin.com/company/acme")).toBe("");
    expect(cleanDomainValue("https://shop.example.com")).toBe("shop.example.com"); // 子域名保留
    expect(cleanDomainValue("acme.com")).toBe("acme.com");
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
      full_name: "张三", email: "zhang@acme.com", cellphone: "+49 151 1234567",
      whatsapp_or_phone: "+49 151 1234567",
    });
  });

  it("Puerto Rico 式混合表：拆分姓名 + 多电话列 + 公司级列补全 + Facebook 主页 + 无名公司行", async () => {
    const { env } = makeEnv();
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([
        ["company ID", "company name", "First Name", "Last Name", "TITLE", "Country",
          "TEL", "EMAIL", "Website", "Cellphone", "WhatsApp", "Products & Services in English", "中文备注", "from"],
        ["PR0001", "1 OCEAN WATERSPORTS", "Carlos", "Turrino", "Owner", "Puerto Rico",
          "+1 787-111-2222", "#N/A", "https://www.facebook.com/1OceanPR/", "787-111-2222", "7871112222", "Watersports Charters", "备注一", "x"],
        ["PR0002", "Advanced Surf & Sail", "Orlando", "Puig", "Owner", "Puerto Rico",
          "+1 787-333-4444", "osp@msn.com", "https://www.facebook.com/AdvancedSurf/", "", "", "Windsurfing gear", "备注二", ""],
        ["PR0003", "787 Yachts", "Isaias", "Rodriguez", "Owner/CEO", "Puerto Rico",
          "+1 787-555-6666", "info@787yachts.com", "787yachts.com", "+1 787-555-6666", "+1 7875556666", "Yacht brokerage", "备注三", ""],
        ["PR0004", "Company Only Row", "", "", "", "Puerto Rico",
          "", "", "companyonly.com", "", "", "Pool construction", "只有公司没有联系人", ""],
      ])) },
    ]);
    const r = await call(env, "POST", "/admin/api/crm/import", { xlsx_base64: b64(xlsx) });
    expect(r.status).toBe(200);
    expect(r.body.entity_used).toBe("contacts");
    expect(r.body.created).toBe(3); // 3 个有姓名的联系人
    expect(r.body.companies_created).toBe(4); // 4 家公司全部创建（含无名公司行）
    expect(r.body.skipped).toBe(1); // 无名公司行：公司入库、无联系人
    expect(r.body.error_total).toBe(0);
    expect(r.body.columns).toMatchObject({
      "First Name": "first_name", "Last Name": "last_name", TEL: "tel",
      Country: "country", Website: "domain", "中文备注": "chinese_remarks",
      "Products & Services in English": "products_services",
      "company ID": "external_id", "from": "dealer_brands",
    });
    expect(r.body.unmapped).toEqual([]);

    const list = await call(env, "GET", "/admin/api/crm/companies?limit=200");
    const byName = new Map(list.body.companies.map((c: any) => [c.name, c]));
    // 两家 Facebook 主页公司互不合并、都不带域名（社交主页 ≠ 官网）
    expect(byName.get("1 OCEAN WATERSPORTS").domain).toBeNull();
    expect(byName.get("Advanced Surf & Sail").domain).toBeNull();
    expect(byName.get("787 Yachts").domain).toBe("787yachts.com");
    // 公司级列补全到自动创建的公司（0041：地址/编号/经销品牌；0042：产品与服务独立列）
    expect(byName.get("787 Yachts")).toMatchObject({
      country: "Puerto Rico", products_services: "Yacht brokerage", chinese_remarks: "备注三",
      external_id: "PR0003",
    });
    expect(byName.get("1 OCEAN WATERSPORTS")).toMatchObject({
      address: null, external_id: "PR0001", dealer_brands: "x",
    });
    expect(byName.get("Company Only Row")).toMatchObject({
      domain: "companyonly.com", country: "Puerto Rico", chinese_remarks: "只有公司没有联系人",
    });

    const co = await call(env, "GET", `/admin/api/crm/companies/${byName.get("1 OCEAN WATERSPORTS").id}`);
    expect(co.body.contacts).toHaveLength(1);
    expect(co.body.contacts[0]).toMatchObject({
      // First + Last 拼接，0042 电话三列各自独立入库（TEL/Cellphone/WhatsApp），
      // 遗留列镜像 WhatsApp 首选值；EMAIL 列的 #N/A 公式错误按空值处理。
      full_name: "Carlos Turrino", email: null,
      tel: "+1 787-111-2222", cellphone: "787-111-2222", whatsapp: "7871112222",
      whatsapp_or_phone: "7871112222",
      job_title: "Owner",
    });
    const co2 = await call(env, "GET", `/admin/api/crm/companies/${byName.get("Advanced Surf & Sail").id}`);
    expect(co2.body.contacts[0]).toMatchObject({
      // 无 WhatsApp、无 Cellphone → 座机 TEL 列兜底（三列 + 镜像均为 TEL 值）
      full_name: "Orlando Puig", tel: "+1 787-333-4444", whatsapp_or_phone: "+1 787-333-4444", email: "osp@msn.com",
    });
  });

  it("导入响应带 created_companies 清单（面板据此渲染「加入待办」入口）", async () => {
    const { env } = makeEnv();
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([
        ["公司名称", "联系人姓名", "Email"],
        ["Acme", "张三", "zhang@acme.com"],
        ["Beta", "李四", "li@beta.com"],
      ])) },
    ]);
    const r = await call(env, "POST", "/admin/api/crm/import", { xlsx_base64: b64(xlsx) });
    expect(r.status).toBe(200);
    expect(r.body.entity_used).toBe("contacts");
    const created = r.body.created_companies as Array<{ id: string; name: string }>;
    expect(created.map((c) => c.name).sort()).toEqual(["Acme", "Beta"]);
    // id 与库中实际公司一致（按钮要按 id 建待办）
    const list = await call(env, "GET", "/admin/api/crm/companies?limit=200");
    const ids = new Set<string>(list.body.companies.map((c: { id: string }) => c.id));
    for (const c of created) expect(ids.has(c.id)).toBe(true);
    // 重复导入（全部跳过）不新建，但匹配到的已有公司进 matched_companies
    //（面板据此为重传的表也提供批量加入待办）
    const again = await call(env, "POST", "/admin/api/crm/import", { xlsx_base64: b64(xlsx) });
    expect(again.body.created).toBe(0);
    expect(again.body.created_companies).toEqual([]);
    const matched = again.body.matched_companies as Array<{ id: string; name: string }>;
    expect(matched.map((c) => c.name).sort()).toEqual(["Acme", "Beta"]);
    expect(new Set(matched.map((c) => c.id)).size).toBe(2);
    // 修复模式：不新建，但表内匹配到的公司同样列出
    const repair = await call(env, "POST", "/admin/api/crm/import", {
      entity: "contacts", mode: "repair", xlsx_base64: b64(xlsx),
    });
    expect(repair.body.mode).toBe("repair");
    expect(repair.body.created_companies).toEqual([]);
    expect(
      (repair.body.matched_companies as Array<{ name: string }>).map((c) => c.name).sort(),
    ).toEqual(["Acme", "Beta"]);
  });

  it("重复导入同一张联系人表：邮箱行与无邮箱行都去重，不重复建联系人", async () => {
    const { env } = makeEnv();
    const sheet = sheetXml(inline([
      ["company name", "First Name", "Last Name", "EMAIL", "Website"],
      ["Acme", "张", "三", "zhang@acme.com", "acme.com"],
      ["Beta", "李", "四", "", "beta.com"], // 无邮箱行：按公司+姓名去重
    ]));
    const xlsx = await buildZip([{ name: "xl/worksheets/sheet1.xml", content: sheet }]);
    const first = await call(env, "POST", "/admin/api/crm/import", { xlsx_base64: b64(xlsx) });
    expect(first.status).toBe(200);
    expect(first.body.created).toBe(2);

    const again = await call(env, "POST", "/admin/api/crm/import", { xlsx_base64: b64(xlsx) });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(0);
    expect(again.body.skipped).toBe(2);
    expect(again.body.companies_created).toBe(0); // 公司按名称/域名匹配，不重建
  });

  it("重复导入回填已有公司的 0041 空列（地址/编号/经销品牌），不覆盖已有值", async () => {
    const { env, db } = makeEnv();
    // 模拟生产现状：公司已按旧逻辑入库，缺 address/external_id/dealer_brands。
    db.prepare(
      `INSERT INTO crm_companies (id, name, domain, country, tier, lead_status, source)
       VALUES ('c_1', '1 OCEAN WATERSPORTS', NULL, 'Puerto Rico', 'unqualified', 'new', 'csv_import')`,
    ).run();
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([
        ["company ID", "company name", "First Name", "Last Name", "Street address", "from"],
        ["PR0001", "1 OCEAN WATERSPORTS", "Carlos", "Turrino", "Carr. 187 Km 4.2, Loíza", '"cressi, Garmin"'],
      ])) },
    ]);
    const r = await call(env, "POST", "/admin/api/crm/import", { xlsx_base64: b64(xlsx) });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(1); // 联系人新建
    expect(r.body.companies_created).toBe(0); // 公司按名称匹配，不重建
    const row = db.prepare("SELECT * FROM crm_companies WHERE id = 'c_1'").get() as any;
    expect(row.address).toBe("Carr. 187 Km 4.2, Loíza");
    expect(row.external_id).toBe("PR0001");
    expect(row.dealer_brands).toBe("cressi, Garmin"); // CSV 残留引号被清洗

    // 再导一次：已有值不被覆盖（NULLIF 条件更新），数据不变。
    const again = await call(env, "POST", "/admin/api/crm/import", { xlsx_base64: b64(xlsx) });
    expect(again.body.created).toBe(0);
    const row2 = db.prepare("SELECT * FROM crm_companies WHERE id = 'c_1'").get() as any;
    expect(row2).toMatchObject({
      address: "Carr. 187 Km 4.2, Loíza", external_id: "PR0001", dealer_brands: "cressi, Garmin",
    });
  });

  it("companies 表 0042 新字段表头（法定名称/邮编城市/成立年份/is manufacturer）落新列", async () => {
    const { env, db } = makeEnv();
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([
        ["公司名称", "法定名称", "邮编城市", "产品与服务", "成立年份", "员工人数", "is manufacturer", "零售商", "目标市场"],
        ["Parity Boats", "Parity Boats LLC", "00646 Utuado", "Boat sales", "1998", "10-50", "TRUE", "是", "Caribbean"],
      ])) },
    ]);
    const r = await call(env, "POST", "/admin/api/crm/import", { xlsx_base64: b64(xlsx) });
    expect(r.status).toBe(200);
    expect(r.body.entity_used).toBe("companies");
    expect(r.body.created).toBe(1);
    expect(r.body.columns).toMatchObject({
      法定名称: "legal_name", 邮编城市: "zip_city", "产品与服务": "products_services",
      成立年份: "founded_year", 员工人数: "employee_range", "is manufacturer": "is_manufacturer",
      零售商: "is_retailer", 目标市场: "target_markets",
    });
    const row = db.prepare("SELECT * FROM crm_companies").get() as any;
    expect(row.legal_name).toBe("Parity Boats LLC");
    expect(row.zip_city).toBe("00646 Utuado");
    expect(row.products_services).toBe("Boat sales");
    expect(row.founded_year).toBe("1998");
    expect(row.employee_range).toBe("10-50");
    expect(row.target_markets).toBe("Caribbean");
    expect(row.is_manufacturer).toBe(1);
    expect(row.is_retailer).toBe(1);
    expect(row.is_oem).toBe(0);
  });

  it("重复导入回填已有公司的 0042 空列与 is_* 勾选（TRUE/是 → 只升不降）", async () => {
    const { env, db } = makeEnv();
    // 生产现状：公司已入库，0042 新列全空，is_retailer 已是 1（不被降级）。
    db.prepare(
      `INSERT INTO crm_companies (id, name, is_retailer, source)
       VALUES ('c_2', 'Parity Boats', 1, 'csv_import')`,
    ).run();
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([
        ["公司名称", "法定名称", "城市", "is manufacturer"],
        ["Parity Boats", "Parity Boats LLC", "Utuado", "TRUE"],
      ])) },
    ]);
    const r = await call(env, "POST", "/admin/api/crm/import", { xlsx_base64: b64(xlsx) });
    expect(r.status).toBe(200);
    expect(r.body.companies_created).toBe(0); // 按名称匹配，不重建
    const row = db.prepare("SELECT * FROM crm_companies WHERE id = 'c_2'").get() as any;
    expect(row.legal_name).toBe("Parity Boats LLC");
    expect(row.city).toBe("Utuado");
    expect(row.is_manufacturer).toBe(1); // TRUE → 升为 1
    expect(row.is_retailer).toBe(1); // 已有 1 保持

    // 再导一次带 is_oem=TRUE 的表 → 只升；is_manufacturer 不变
    const xlsx2 = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([
        ["公司名称", "OEM"],
        ["Parity Boats", "y"],
      ])) },
    ]);
    const again = await call(env, "POST", "/admin/api/crm/import", { xlsx_base64: b64(xlsx2) });
    expect(again.status).toBe(200);
    const row2 = db.prepare("SELECT * FROM crm_companies WHERE id = 'c_2'").get() as any;
    expect(row2.is_oem).toBe(1); // y → 1
    expect(row2.is_manufacturer).toBe(1);
    expect(row2.is_retailer).toBe(1);
  });

  it("首行是 Facebook 主页、后续行才有真官网 → 域名回填不丢（Kanoa Kayaks 场景）", async () => {
    const { env, db } = makeEnv();
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([
        ["company name", "First Name", "Last Name", "Website"],
        ["Kanoa Kayaks", "A", "B", "facebook.com/kanoakayaks"], // 社交主页 → 清洗为空
        ["KANOA Kayaks", "C", "D", "https://kanoapr.com/"], // 大小写变体 + 真官网
      ])) },
    ]);
    const r = await call(env, "POST", "/admin/api/crm/import", { xlsx_base64: b64(xlsx) });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(2); // 大小写归并成一家公司，两个联系人都入库
    expect(r.body.companies_created).toBe(1);
    const co = db.prepare("SELECT * FROM crm_companies").get() as any;
    expect(co.domain).toBe("kanoapr.com"); // 后续行的真官网回填成功
  });

  it("域名已被其他公司占用 → 不抢绑（经销商共用品牌官网场景）", async () => {
    const { env, db } = makeEnv();
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([
        ["company name", "First Name", "Last Name", "Website"],
        ["West Marine (Fajardo)", "A", "B", "westmarine.com"],
        ["West Marine San Juan", "C", "D", "westmarine.com"], // 同域名不同公司
      ])) },
    ]);
    const r = await call(env, "POST", "/admin/api/crm/import", { xlsx_base64: b64(xlsx) });
    expect(r.status).toBe(200);
    expect(r.body.companies_created).toBe(2); // 两家独立公司
    const rows = (db.prepare("SELECT name, domain FROM crm_companies ORDER BY name").all() as any[]);
    expect(rows[0]).toMatchObject({ name: "West Marine (Fajardo)", domain: "westmarine.com" });
    expect(rows[1]).toMatchObject({ name: "West Marine San Juan", domain: null }); // 不抢
  });

  it("deals 导入：表内公司级列（国家/官网）同样补全到自动创建的公司", async () => {
    const { env } = makeEnv();
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([
        ["公司", "商机名称", "阶段", "国家", "网址"],
        ["Acme", "大单", "询盘", "德国", "https://www.acme.com/x"],
      ])) },
    ]);
    const r = await call(env, "POST", "/admin/api/crm/import", { xlsx_base64: b64(xlsx) });
    expect(r.status).toBe(200);
    expect(r.body.entity_used).toBe("deals");
    expect(r.body.created).toBe(1);
    expect(r.body.companies_created).toBe(1);

    const list = await call(env, "GET", "/admin/api/crm/companies?limit=200");
    expect(list.body.companies[0]).toMatchObject({ name: "Acme", domain: "acme.com", country: "德国" });
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

/* ── 修复模式（mode=repair）：旧规则存量重上传，只回填不新建 ─────────────── */

describe("POST /admin/api/crm/import — 修复模式 (mode=repair)", () => {
  it("旧规则存量（电话塌缩/产品错放 industry）重传同表 → 回填三列电话 + industry 归位，不新建", async () => {
    const { env, db } = makeEnv();
    // 生产现状形态：0042 前导入 —— 产品文本在 industry，联系人电话全塌缩在
    // 遗留列（迁移后镜像到 whatsapp），tel/cellphone 为空。
    db.prepare(
      `INSERT INTO crm_companies (id, name, domain, country, industry, source)
       VALUES ('c_1', '787 Yachts', '787yachts.com', 'Puerto Rico',
               'Yacht brokerage, sales and luxury charters.', 'csv_import')`,
    ).run();
    db.prepare(
      `INSERT INTO crm_contacts (id, company_id, full_name, job_title, email, whatsapp_or_phone, whatsapp)
       VALUES ('ct_1', 'c_1', 'Isaias Rodriguez', 'Owner/CEO', 'info@787yachts.com',
               '+1 7876054927', '+1 7876054927')`,
    ).run();
    const before = {
      companies: (db.prepare("SELECT COUNT(*) AS n FROM crm_companies").get() as any).n,
      contacts: (db.prepare("SELECT COUNT(*) AS n FROM crm_contacts").get() as any).n,
    };
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([
        ["company name", "First Name", "Last Name", "TEL", "EMAIL", "Website", "Cellphone", "WhatsApp", "Products & Services in English"],
        ["787 Yachts", "Isaias", "Rodriguez", "+1 787-605-4927", "info@787yachts.com", "787yachts.com", "+1 787-605-4927", "+1 7876054927", "Yacht brokerage, sales and luxury charters."],
      ])) },
    ]);
    const r = await call(env, "POST", "/admin/api/crm/import", { mode: "repair", xlsx_base64: b64(xlsx) });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("repair");
    expect(r.body.created).toBe(0);
    expect(r.body.companies_created).toBe(0);
    expect(r.body.repaired_contacts).toBe(1);
    expect(r.body.repaired_companies).toBe(1);
    // 不新建任何行
    expect((db.prepare("SELECT COUNT(*) AS n FROM crm_companies").get() as any).n).toBe(before.companies);
    expect((db.prepare("SELECT COUNT(*) AS n FROM crm_contacts").get() as any).n).toBe(before.contacts);
    // 联系人三列电话就位（whatsapp 已有值保持）
    const ct = db.prepare("SELECT * FROM crm_contacts WHERE id = 'ct_1'").get() as any;
    expect(ct.tel).toBe("+1 787-605-4927");
    expect(ct.cellphone).toBe("+1 787-605-4927");
    expect(ct.whatsapp).toBe("+1 7876054927");
    // 公司：产品归位 products_services，industry 不再存同一文本
    const co = db.prepare("SELECT * FROM crm_companies WHERE id = 'c_1'").get() as any;
    expect(co.products_services).toBe("Yacht brokerage, sales and luxury charters.");
    expect(co.industry).toBeNull();
  });

  it("表内 WhatsApp 为空的行：塌缩进遗留列的手机号/座机归位（whatsapp 清空，tel/cellphone 补上）", async () => {
    const { env, db } = makeEnv();
    db.prepare(
      `INSERT INTO crm_companies (id, name, source) VALUES ('c_2', 'Abe Snorkeling', 'csv_import')`,
    ).run();
    // 旧导入只保了一个号（TEL 塌缩进遗留列），表内 WhatsApp 本来就是空
    db.prepare(
      `INSERT INTO crm_contacts (id, company_id, full_name, whatsapp_or_phone, whatsapp)
       VALUES ('ct_2', 'c_2', 'Abe Gutierrez', '+1 787-741-2134', '+1 787-741-2134')`,
    ).run();
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([
        ["company name", "First Name", "Last Name", "TEL", "Cellphone", "WhatsApp"],
        ["Abe Snorkeling", "Abe", "Gutierrez", "+1 787-741-2134", "+1 787-435-1362", ""],
      ])) },
    ]);
    const r = await call(env, "POST", "/admin/api/crm/import", { mode: "repair", xlsx_base64: b64(xlsx) });
    expect(r.status).toBe(200);
    expect(r.body.repaired_contacts).toBe(1);
    const ct = db.prepare("SELECT * FROM crm_contacts WHERE id = 'ct_2'").get() as any;
    expect(ct.tel).toBe("+1 787-741-2134");
    expect(ct.cellphone).toBe("+1 787-435-1362");
    expect(ct.whatsapp).toBeNull(); // 不再冒充 WhatsApp（表内 WhatsApp 为空）
    expect(ct.whatsapp_or_phone).toBe("+1 787-741-2134"); // 遗留镜像不动
  });

  it("合并后的源公司不复活：表内公司/联系人库里没有 → 跳过，零新建", async () => {
    const { env, db } = makeEnv();
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([
        ["company name", "First Name", "Last Name", "EMAIL", "TEL"],
        ["Ghost Co", "Nobody", "Here", "nobody@ghost.com", "+1 787-000-0000"],
      ])) },
    ]);
    const r = await call(env, "POST", "/admin/api/crm/import", { mode: "repair", xlsx_base64: b64(xlsx) });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(0);
    expect(r.body.companies_created).toBe(0);
    expect(r.body.repaired_contacts).toBe(0);
    expect(r.body.repaired_companies).toBe(0);
    expect(r.body.skipped).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM crm_companies").get() as any).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM crm_contacts").get() as any).n).toBe(0);
  });

  it("源公司已合并删除：联系人按全局邮箱命中修复，不复活源公司", async () => {
    const { env, db } = makeEnv();
    // 合并后形态：源公司已删除，联系人搬到目标公司名下（旧规则电话塌缩）
    db.prepare(
      `INSERT INTO crm_companies (id, name, source) VALUES ('c_3', 'Crashboat Surf & Skate', 'csv_import')`,
    ).run();
    db.prepare(
      `INSERT INTO crm_contacts (id, company_id, full_name, email, whatsapp_or_phone, whatsapp)
       VALUES ('ct_3', 'c_3', 'Rick Morales', 'rick@crashboat.com', '787-555-0199', '787-555-0199')`,
    ).run();
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([
        ["company name", "First Name", "Last Name", "TEL", "EMAIL", "Cellphone", "WhatsApp"],
        ["Crashboat Surf Shop", "Rick", "Morales", "787-555-0199", "rick@crashboat.com", "787-555-0199", "787-555-0199"],
      ])) },
    ]);
    const r = await call(env, "POST", "/admin/api/crm/import", { mode: "repair", xlsx_base64: b64(xlsx) });
    expect(r.status).toBe(200);
    expect(r.body.repaired_contacts).toBe(1);
    expect(r.body.repaired_companies).toBe(0); // 源公司不复活，无公司可修
    expect(r.body.created).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM crm_companies").get() as any).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM crm_contacts").get() as any).n).toBe(1);
    const ct = db.prepare("SELECT * FROM crm_contacts WHERE id = 'ct_3'").get() as any;
    expect(ct.tel).toBe("787-555-0199");
    expect(ct.cellphone).toBe("787-555-0199");
    expect(ct.company_id).toBe("c_3"); // 留在合并后的目标公司
  });

  it("修复模式不支持商机表 → 400", async () => {
    const { env } = makeEnv();
    const xlsx = await buildZip([
      { name: "xl/worksheets/sheet1.xml", content: sheetXml(inline([
        ["公司名称", "商机名称", "金额"],
        ["Acme", "大单", "1200"],
      ])) },
    ]);
    const r = await call(env, "POST", "/admin/api/crm/import", { mode: "repair", xlsx_base64: b64(xlsx) });
    expect(r.status).toBe(400);
    expect(String(r.body.detail)).toContain("修复模式");
  });
});
