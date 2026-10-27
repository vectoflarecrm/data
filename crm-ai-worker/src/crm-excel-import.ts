// 智能 Excel(.xlsx) 导入（用户需求：客户 Excel 表格不同列自动正确识别入库）。
//
// 三个能力，全部服务端实现（vitest 可测）：
//   1. parseXlsx   — .xlsx = ZIP（deflate-raw 解压）+ sheet XML → 行列字符串矩阵。
//                    零依赖：ZIP 手工解析（EOCD → central directory → local
//                    header），解压用运行时自带 DecompressionStream('deflate-raw')
//                    （Workers / Node 18+ 均原生支持）。
//   2. 智能列识别  — 表头不再要求精确命中别名：归一化（去空格/括号/下划线、
//                    小写）后先精确、再包含匹配；每列只归一个字段，识别结果
//                    随响应回传（columns / unmapped），未识别列安全忽略。
//   3. 实体自动识别 — entity:'auto' 时按表头推断 companies/contacts/deals。
// 配套值清洗：Website URL → 域名、Excel 日期序列号 → ISO 日期、中文阶段 →
// 英文 stage、千分位金额（crm.ts 已有）。
//
// 局限（注释明示）：按文件名序取第一张 sheet（xl/worksheets/sheet1.xml），
// 绝大多数导出工具的第一张表即数据表；旧版二进制 .xls 不支持（400 提示）。

/** 单元格值上限：超长内容截断，防御异常 XML。 */
const CELL_MAX = 2000;

/* ── ZIP 解析（只需读，不需写） ──────────────────────────────────────────── */

interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate。 */
  method: number;
  data: Uint8Array; // 压缩/原始数据（local header 之后的部分）
}

function readU16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function readU32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/** 定位 End of Central Directory（尾部 22 字节起，向前扫注释区）。 */
function findEocd(b: Uint8Array): number {
  const min = 22;
  if (b.length < min) return -1;
  const start = Math.max(0, b.length - min - 65535);
  for (let i = b.length - min; i >= start; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) return i;
  }
  return -1;
}

function latin1(b: Uint8Array, from: number, len: number): string {
  let out = "";
  const end = Math.min(b.length, from + len);
  for (let i = from; i < end; i++) out += String.fromCharCode(b[i]);
  return out;
}

/** 列出 ZIP 内全部条目（central directory 只读遍历，忽略目录项）。 */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  const eocd = findEocd(bytes);
  if (eocd < 0) throw new Error("不是有效的 .xlsx 文件（缺少 ZIP 结构）");
  const count = readU16(bytes, eocd + 10);
  let off = readU32(bytes, eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > bytes.length || readU32(bytes, off) !== 0x02014b50) {
      throw new Error("xlsx ZIP 中央目录损坏");
    }
    const method = readU16(bytes, off + 10);
    const compSize = readU32(bytes, off + 20);
    const nameLen = readU16(bytes, off + 28);
    const extraLen = readU16(bytes, off + 30);
    const commentLen = readU16(bytes, off + 32);
    const localOff = readU32(bytes, off + 42);
    const name = latin1(bytes, off + 46, nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // 目录项
    // local file header：数据从 30 + 文件名长 + 额外区长 之后开始。
    if (localOff + 30 > bytes.length || readU32(bytes, localOff) !== 0x04034b50) {
      throw new Error("xlsx ZIP 本地头损坏");
    }
    const lNameLen = readU16(bytes, localOff + 26);
    const lExtraLen = readU16(bytes, localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    entries.push({ name, method, data: bytes.subarray(dataStart, dataStart + compSize) });
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntry(entry: ZipEntry): Promise<string> {
  const raw = entry.method === 8 ? await inflateRaw(entry.data) : entry.data;
  // xlsx 内 XML 一律 UTF-8。
  return new TextDecoder("utf-8").decode(raw);
}

/* ── XML 辅助（无 DOMParser，Workers 环境用正则） ───────────────────────── */

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&"); // &amp; 最后解，避免二次解码
}

/** 列引用字母（A1 的 A）→ 0 起列号。 */
function colFromRef(ref: string): number {
  const letters = ref.replace(/\d+$/, "");
  let col = 0;
  for (const ch of letters) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return -1;
    col = col * 26 + (code - 64);
  }
  return col - 1;
}

/** 解析 xl/sharedStrings.xml → 字符串表（富文本 run 拼接）。 */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let si: RegExpExecArray | null;
  while ((si = siRe.exec(xml)) !== null) {
    let text = "";
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(si[1])) !== null) text += decodeXmlEntities(t[1]);
    out.push(text.slice(0, CELL_MAX));
  }
  return out;
}

/**
 * 解析 .xlsx → 行列字符串矩阵（含表头行）。
 * 取文件名序的第一张 sheet；空单元格补 ""，行按最大列对齐。
 */
export async function parseXlsx(bytes: Uint8Array): Promise<string[][]> {
  const entries = listZipEntries(bytes);
  const sheetRe = /^xl\/worksheets\/sheet(\d+)\.xml$/;
  const sheets = entries
    .map((e) => ({ e, n: sheetRe.exec(e.name)?.[1] }))
    // 注意 ?.[1] 匹配失败产生 undefined（不是 null），必须排除 undefined，
    // 否则 filter 恒真、全部条目涌入，sheets[0] 会错拿 [Content_Types].xml
    // 等非工作表条目（真实 xlsx 的第一个条目），parse 出 0 行。
    .filter((x): x is { e: ZipEntry; n: string } => x.n !== undefined)
    .sort((a, b) => Number(a.n) - Number(b.n));
  if (!sheets.length) throw new Error("xlsx 中没有工作表（xl/worksheets/sheetN.xml）");

  const shared = entries.find((e) => e.name === "xl/sharedStrings.xml");
  const sharedStrings = shared ? parseSharedStrings(await readEntry(shared)) : [];

  const sheetXml = await readEntry(sheets[0].e);
  const rows: string[][] = [];
  const rowRe = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  let maxCol = 0;
  const pending: Array<{ cells: Array<{ col: number; v: string }> }> = [];
  while ((rowMatch = rowRe.exec(sheetXml)) !== null) {
    const cells: Array<{ col: number; v: string }> = [];
    const cRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c: RegExpExecArray | null;
    while ((c = cRe.exec(rowMatch[1])) !== null) {
      const attrs = c[1] ?? "";
      const body = c[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "";
      const type = /\bt="([a-zA-Z]+)"/.exec(attrs)?.[1] ?? "n";
      const col = colFromRef(ref);
      if (col < 0) continue;
      let value = "";
      if (type === "s") {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "-1");
        value = Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] : "";
      } else if (type === "inlineStr") {
        let text = "";
        const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
        let t: RegExpExecArray | null;
        while ((t = tRe.exec(body)) !== null) text += decodeXmlEntities(t[1]);
        value = text;
      } else if (type === "b") {
        value = /^1|true$/i.test(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "") ? "TRUE" : "FALSE";
      } else {
        // n / str：取 <v>（str 是公式结果字符串）。
        value = decodeXmlEntities(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
      }
      cells.push({ col, v: value.slice(0, CELL_MAX) });
      if (col + 1 > maxCol) maxCol = col + 1;
    }
    pending.push({ cells });
  }
  for (const { cells } of pending) {
    const row = new Array<string>(maxCol).fill("");
    for (const cell of cells) row[cell.col] = cell.v;
    rows.push(row);
  }
  return rows;
}

/** JSON body 里的 xlsx_base64 → 字节。 */
export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ── 智能列识别 ─────────────────────────────────────────────────────────── */

export const IMPORT_ENTITIES = ["companies", "contacts", "deals"] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

/** 列别名（英/中）：归一化后匹配，别名越具体越应排前（包含匹配取最长命中）。 */
export const IMPORT_HEADERS: Record<ImportEntity, Record<string, string>> = {
  companies: {
    name: "name", 名称: "name", 公司名称: "name", 公司: "name", 公司名: "name",
    客户名称: "name", 客户: "name", customer: "name", company: "name",
    companyname: "name", customername: "name",
    domain: "domain", 域名: "domain", 网站域名: "domain", companydomain: "domain",
    website: "domain", 网址: "domain", 网站: "domain", 官网: "domain", 主页: "domain",
    country: "country", 国家: "country", 国家地区: "country", 地区: "country",
    industry: "industry", 行业: "industry", 行业类别: "industry",
    // 0042 「产品与服务」独立成列（原归 industry）：对齐 /admin 客户字段，
    // 行业与主营业务分开保存。
    products_services: "products_services", products: "products_services",
    productsservices: "products_services", productsandservices: "products_services",
    产品: "products_services", 产品与服务: "products_services", 主营产品: "products_services",
    主营业务: "products_services",
    tier: "tier", 分级: "tier", 等级: "tier", 客户分级: "tier",
    chinese_remarks: "chinese_remarks", 备注: "chinese_remarks", 中文备注: "chinese_remarks",
    remark: "chinese_remarks", remarks: "chinese_remarks", 备注2: "chinese_remarks",
    // 0041 公司扩展属性：Puerto Rico 表的 Street address / company ID / from
    // 三列此前无对应字段被忽略，现归入 companies 新列（contacts/deals 导入经
    // companyMap 同样生效）。from 列语义：该公司是这些品牌的 dealer/distributor。
    address: "address", street: "address", streetaddress: "address",
    地址: "address", 街道地址: "address", 详细地址: "address", 通讯地址: "address",
    办公地址: "address",
    external_id: "external_id", companyid: "external_id", company_code: "external_id",
    companycode: "external_id", externalid: "external_id", 公司编号: "external_id",
    公司id: "external_id", 外部编号: "external_id", 外部id: "external_id",
    dealer_brands: "dealer_brands", dealerbrands: "dealer_brands", from: "dealer_brands",
    dealerof: "dealer_brands", distributorof: "dealer_brands", distributors: "dealer_brands",
    dealers: "dealer_brands", 经销品牌: "dealer_brands", 代理品牌: "dealer_brands",
    经销商: "dealer_brands", 分销商: "dealer_brands",
    // 0042 公司信息对齐 /admin 客户字段：法定/交易名称、地址组、公司级
    // 电话/WhatsApp、业务属性、业务角色布尔标签。别名只加无冲突项 ——
    // 经销商/分销商/distributors 等仍归 dealer_brands，语义不漂移。
    legal_name: "legal_name", legalname: "legal_name", 法定名称: "legal_name",
    法定公司名: "legal_name",
    trading_name: "trading_name", tradingname: "trading_name", 交易名称: "trading_name",
    贸易名称: "trading_name",
    zip_city: "zip_city", zipcity: "zip_city", "zip+city": "zip_city", 邮编城市: "zip_city",
    city: "city", 城市: "city",
    region: "region", state: "region", 州: "region", 省: "region",
    postal_code: "postal_code", postalcode: "postal_code", zipcode: "postal_code",
    postal: "postal_code", zip: "postal_code", 邮编: "postal_code", 邮政编码: "postal_code",
    country_code: "country_code", countrycode: "country_code", 国家代码: "country_code",
    tel: "tel", telephone: "tel", phone: "tel", phonenumber: "tel",
    telnumber: "tel", 电话: "tel", 联系电话: "tel", 电话号码: "tel", 公司电话: "tel",
    whatsapp: "whatsapp", whatsappnumber: "whatsapp",
    business_tag: "business_tag", businesstag: "business_tag", 业务标签: "business_tag",
    company_type: "company_type", companytype: "company_type", 公司类型: "company_type",
    business_model: "business_model", businessmodel: "business_model", 商业模式: "business_model",
    founded_year: "founded_year", foundedyear: "founded_year", founded: "founded_year",
    成立年份: "founded_year", 成立时间: "founded_year",
    employee_range: "employee_range", employeerange: "employee_range",
    员工规模: "employee_range", 员工人数: "employee_range", 雇员人数: "employee_range",
    employees: "employee_range", numberofemployees: "employee_range",
    description: "description", 描述: "description", 公司描述: "description",
    公司简介: "description", 简介: "description",
    target_markets: "target_markets", targetmarkets: "target_markets", 目标市场: "target_markets",
    customer_segment: "customer_segment", customersegment: "customer_segment",
    客户细分: "customer_segment",
    product_categories: "product_categories", productcategories: "product_categories",
    产品类别: "product_categories", 产品分类: "product_categories",
    company_size: "company_size", companysize: "company_size", 公司规模: "company_size",
    geographic_coverage: "geographic_coverage", geographiccoverage: "geographic_coverage",
    地理覆盖: "geographic_coverage", 覆盖区域: "geographic_coverage",
    is_manufacturer: "is_manufacturer", ismanufacturer: "is_manufacturer",
    manufacturer: "is_manufacturer", 制造商: "is_manufacturer",
    is_importer: "is_importer", isimporter: "is_importer", importer: "is_importer",
    进口商: "is_importer",
    is_distributor: "is_distributor", isdistributor: "is_distributor",
    is_wholesaler: "is_wholesaler", iswholesaler: "is_wholesaler",
    wholesaler: "is_wholesaler", 批发商: "is_wholesaler",
    is_retailer: "is_retailer", isretailer: "is_retailer", retailer: "is_retailer",
    零售商: "is_retailer",
    is_ecommerce: "is_ecommerce", isecommerce: "is_ecommerce", ecommerce: "is_ecommerce",
    电商: "is_ecommerce",
    is_rental: "is_rental", isrental: "is_rental", rental: "is_rental", 租赁: "is_rental",
    is_oem: "is_oem", isoem: "is_oem", oem: "is_oem",
  },
  contacts: {
    company: "company", 公司: "company", 公司名称: "company", companyname: "company",
    company_name: "company", 客户名称: "company", 客户: "company", 客户公司: "company",
    customer: "company", customername: "company",
    full_name: "full_name", 姓名: "full_name", 联系人: "full_name", 联系人姓名: "full_name",
    contact: "full_name", contactname: "full_name", name: "full_name",
    // 拆分姓名列（Puerto Rico 表布局）：First/Last 各归一列，导入时拼成
    // full_name；只有单列姓名时仍走上面的 full_name。
    first_name: "first_name", firstname: "first_name", 名字: "first_name",
    givenname: "first_name",
    last_name: "last_name", lastname: "last_name", 姓: "last_name",
    姓氏: "last_name", surname: "last_name", familyname: "last_name",
    job_title: "job_title", 职务: "job_title", 职位: "job_title", title: "job_title",
    jobtitle: "job_title", 职称: "job_title",
    email: "email", 邮箱: "email", 电子邮箱: "email", 邮件: "email", mail: "email",
    电子邮件: "email",
    // 0042 电话三列拆分（同 /admin 联系人格式）：WhatsApp 类列归 whatsapp、
    // 手机类归 cellphone、座机类归 tel，各自独立入库，不再合并互抢。
    whatsapp_or_phone: "whatsapp", whatsapp: "whatsapp", whatsappnumber: "whatsapp",
    cellphone: "cellphone", cell: "cellphone", mobile: "cellphone",
    mobilephone: "cellphone", 手机: "cellphone", 手机号: "cellphone",
    手机号码: "cellphone", 移动电话: "cellphone",
    tel: "tel", telephone: "tel", phone: "tel", phonenumber: "tel",
    telnumber: "tel", 电话: "tel", 联系电话: "tel", 电话号码: "tel", 联系方式: "tel",
    linkedin_url: "linkedin_url", linkedin: "linkedin_url", 领英: "linkedin_url",
    is_primary: "is_primary", 主联: "is_primary", 主要联系人: "is_primary",
  },
  deals: {
    company: "company", 公司: "company", 公司名称: "company", companyname: "company",
    company_name: "company", 客户名称: "company", 客户: "company", 客户公司: "company",
    customer: "company", customername: "company",
    title: "title", 名称: "title", 商机名称: "title", 商机: "title", 订单: "title",
    deal: "title", dealname: "title",
    stage: "stage", 阶段: "stage", 商机阶段: "stage", 状态: "stage",
    amount: "amount", 金额: "amount", 订单金额: "amount", 商机金额: "amount",
    报价金额: "amount", value: "amount", dealvalue: "amount",
    incoterms: "incoterms", 条款: "incoterms", 贸易条款: "incoterms", 价格条款: "incoterms",
    expected_close_date: "expected_close_date", 预计成交: "expected_close_date",
    预计成交日: "expected_close_date", 预计成交日期: "expected_close_date",
    预计关闭日期: "expected_close_date", closedate: "expected_close_date",
    lost_reason: "lost_reason", 输单原因: "lost_reason", 丢单原因: "lost_reason",
    失败原因: "lost_reason",
  },
};

/** 各实体的必需字段（识别不到 → 换实体或 400）。contacts 的姓名可为
 *  full_name 单列，或 first_name + last_name 拆分列（见 hasContactName）。 */
export const REQUIRED_KEYS: Record<ImportEntity, string[]> = {
  companies: ["name"],
  contacts: ["company"],
  deals: ["title", "company"],
};

/** contacts 是否具备可用姓名：完整姓名列，或拆分的名/姓列。 */
export function hasContactName(keys: Set<string>): boolean {
  return keys.has("full_name") || keys.has("first_name") || keys.has("last_name");
}

/** 表头归一化：小写、去空格/下划线/中划线/括号/冒号。 */
export function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[\s_\-—–:：/\\]/g, "")
    .replace(/[（）()【】\[\]{}<>《》""'']/g, "");
}

/** 归一化别名缓存（entity → [{alias, key}]，惰性构建）。 */
const aliasCache = new Map<ImportEntity, Array<{ alias: string; key: string }>>();
function aliasEntries(entity: ImportEntity): Array<{ alias: string; key: string }> {
  let list = aliasCache.get(entity);
  if (!list) {
    list = [];
    for (const [alias, key] of Object.entries(IMPORT_HEADERS[entity])) {
      const n = normalizeHeader(alias);
      if (n) list.push({ alias: n, key });
    }
    aliasCache.set(entity, list);
  }
  return list;
}

/** 公司法定/交易名称表头（0042 companies.legal_name/trading_name 别名）。
 *  deals 的 title 有「名称」包含匹配，会把这些列抢成商机名——
 *  公司名称 + 法定名称 的公司表因此被 detectEntity 误判成 deals。
 *  这些表头对 deals 显式不识别，让识别流程落到 companies。 */
const COMPANY_NAME_HEADERS_NOT_DEAL_TITLE = new Set([
  normalizeHeader("法定名称"),
  normalizeHeader("法定公司名"),
  normalizeHeader("交易名称"),
  normalizeHeader("贸易名称"),
  normalizeHeader("legal_name"),
  normalizeHeader("trading_name"),
]);

/**
 * 单个表头 → canonical 字段（null = 未识别）。
 * 优先级：归一化精确命中 → 后缀匹配（「联系人邮箱」以 邮箱 结尾 → email，
 * 避免被更长的「联系人」抢成 full_name）→ 包含匹配取最长别名。
 */
export function matchHeader(entity: ImportEntity, header: string): string | null {
  const norm = normalizeHeader(header);
  if (!norm) return null;
  // 公司法定/交易名称列对 deals 不识别（防止公司表被误判成商机表，见上方说明）。
  if (entity === "deals" && COMPANY_NAME_HEADERS_NOT_DEAL_TITLE.has(norm)) return null;
  let suffix: { key: string; len: number } | null = null;
  let contain: { key: string; len: number } | null = null;
  for (const { alias, key } of aliasEntries(entity)) {
    if (!norm.includes(alias)) continue;
    if (norm === alias) return key;
    if (norm.endsWith(alias) && (!suffix || alias.length > suffix.len)) suffix = { key, len: alias.length };
    if (!contain || alias.length > contain.len) contain = { key, len: alias.length };
  }
  return (suffix ?? contain)?.key ?? null;
}

/**
 * 整行表头 → 每列的 canonical 字段。
 * 一列只归一个字段；同一字段多列时第一列胜出，其余列作未识别处理。
 */
export function matchColumns(
  entity: ImportEntity,
  header: string[],
): { keyByIndex: Array<string | null>; keys: Set<string> } {
  const keyByIndex: Array<string | null> = header.map(() => null);
  const taken = new Set<string>();
  // 第一遍：精确命中（归一化后与别名全等）。
  for (let i = 0; i < header.length; i++) {
    const norm = normalizeHeader(header[i]);
    if (!norm) continue;
    const exact = aliasEntries(entity).find((a) => a.alias === norm);
    if (exact && !taken.has(exact.key)) {
      keyByIndex[i] = exact.key;
      taken.add(exact.key);
    }
  }
  // 第二遍：后缀/包含匹配（只处理第一遍未识别、且字段未被占用的列）。
  for (let i = 0; i < header.length; i++) {
    if (keyByIndex[i] !== null) continue;
    const key = matchHeader(entity, header[i]);
    if (key && !taken.has(key)) {
      keyByIndex[i] = key;
      taken.add(key);
    }
  }
  return { keyByIndex, keys: taken };
}

/** 表头 → 实体自动识别：按「必需字段是否齐全」依次尝试 contacts → deals → companies。 */
export function detectEntity(header: string[]): ImportEntity {
  const candidates: ImportEntity[] = ["contacts", "deals", "companies"];
  for (const entity of candidates) {
    const { keys } = matchColumns(entity, header);
    if (entity === "contacts") {
      if (keys.has("company") && hasContactName(keys)) return entity;
      continue;
    }
    if (REQUIRED_KEYS[entity].every((k) => keys.has(k))) return entity;
  }
  // 兜底：有公司名称类列 → companies。
  return "companies";
}

/* ── 值清洗 ─────────────────────────────────────────────────────────────── */

/** 社交/建站平台域名：Facebook 主页等不是公司自有域名。多家公司共用此类
 *  域名（真实表格中 Facebook 主页 URL 极常见），若当公司域名入库会触发
 *  domain 唯一约束冲突、并让后到的公司被错误匹配到先到的公司上。 */
const SOCIAL_DOMAINS: ReadonlySet<string> = new Set([
  "facebook.com", "m.facebook.com", "web.facebook.com", "instagram.com",
  "twitter.com", "x.com", "linkedin.com", "youtube.com", "youtu.be",
  "tiktok.com", "linktr.ee", "business.site", "wixsite.com", "godaddysites.com",
]);

function isSocialDomain(host: string): boolean {
  if (SOCIAL_DOMAINS.has(host)) return true;
  for (const d of SOCIAL_DOMAINS) {
    if (host.endsWith(`.${d}`)) return true;
  }
  return false;
}

/** Website 列常见完整 URL → 纯域名（acme.com）；无协议原样返回（小写、去斜杠后缀）。 */
export function cleanDomainValue(v: string): string {
  let s = v.trim().toLowerCase();
  if (!s) return "";
  if (/^https?:\/\//.test(s) || s.includes("/")) {
    const host = /^(?:https?:\/\/)?([^/?#\s]+)/.exec(s)?.[1] ?? "";
    s = host;
  }
  s = s.replace(/^www\./, "").replace(/\/+$/, "");
  // 社交平台主页不是公司官网 → 不作为域名（公司仍按名称匹配/创建）。
  if (isSocialDomain(s)) return "";
  return s;
}

/** Excel 公式错误字面量（#N/A、#REF! 等，含 WPS 的 #N/A/N/A）→ 按空值处理。 */
export function isExcelErrorValue(v: string): boolean {
  return /^#(n\/a(\/n\/a)?|ref!|value!|div\/0!|name\?|null!|num!|getting_data|calc!)$/i.test(
    v.trim(),
  );
}

/** Excel 日期序列号（1900 体系，25569 = 1970-01-01）→ YYYY-MM-DD；非序列号原样返回。 */
export function excelSerialToIsoDate(v: string): string {
  const s = v.trim();
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial >= 20000 && serial <= 60000) {
      // 1954-07-02 ~ 2064-05-16：真实日期区间的合理边界。
      return new Date(Math.round((serial - 25569) * 86400000)).toISOString().slice(0, 10);
    }
  }
  return s;
}

/** 中文阶段名 → 英文 stage（ DEAL_STAGES 枚举值）；英文原值透传。 */
export function normalizeStageValue(v: string): string {
  const s = v.trim();
  if (!s) return "";
  const map: Record<string, string> = {
    询盘: "inquiry", 询价: "inquiry", 咨询: "inquiry",
    报价: "sample_quoted", 样品报价: "sample_quoted", 已报价: "sample_quoted",
    报价中: "sample_quoted", 样品: "sample_quoted",
    pi: "pi_sent", 已发pi: "pi_sent", pi已发: "pi_sent", 形式发票: "pi_sent",
    定金: "deposit_paid", 已收定金: "deposit_paid", 定金到账: "deposit_paid",
    赢单: "won", 已成交: "won", 成交: "won", 已赢单: "won",
    输单: "lost", 丢单: "lost", 已输单: "lost", 失败: "lost",
  };
  const norm = normalizeHeader(s);
  if (map[norm]) return map[norm];
  return s;
}
