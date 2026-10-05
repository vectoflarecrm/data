import { describe, it, expect } from "vitest";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";
import {
  parseCsvBounded,
  readCsvImportBody,
  sanitizeCsvFieldForExport,
  CsvLimitError,
  MAX_CSV_BYTES,
  MAX_CSV_ROWS,
  MAX_FIELD_BYTES,
  MAX_COLUMNS,
} from "../src/security/csv-limits";

/* Security V2 Stage 8 — CSV import resource limits (spec §9.2).
 *
 * The import endpoint used to read the body unbounded and parse with no
 * row/column/field caps. Now: bounded body read (works even without
 * Content-Length), bounded parse, and every spec §9.2 case is pinned. */

const TOKEN = "correct-horse-battery-staple";
const BASE = "https://worker.example";

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

async function makeEnv() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE admin_users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'super_admin', enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE admin_sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      last_seen_at TEXT, revoked_at TEXT, ip_hash TEXT, user_agent_hash TEXT
    );
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY, company_id TEXT, display_id TEXT, domain TEXT,
      status TEXT, company_name TEXT, legal_name TEXT, trading_name TEXT,
      normalized_domain TEXT, first_name TEXT, last_name TEXT, full_name TEXT,
      title TEXT, department TEXT, linkedin_url TEXT, street_address TEXT,
      zip_city TEXT, country TEXT, country_code TEXT, region TEXT, city TEXT,
      postal_code TEXT, tel TEXT, email TEXT, cellphone TEXT, whatsapp TEXT,
      products_services TEXT, business_tag TEXT, industry TEXT, company_type TEXT,
      business_model TEXT, founded_year TEXT, employee_range TEXT, description TEXT,
      target_markets TEXT, is_manufacturer INTEGER, is_importer INTEGER,
      is_distributor INTEGER, is_wholesaler INTEGER, is_retailer INTEGER,
      is_ecommerce INTEGER, is_rental INTEGER, is_oem INTEGER, social_accounts TEXT,
      full_research_text TEXT, social_accounts_verified TEXT, customer_segment TEXT,
      product_categories TEXT, company_size TEXT, geographic_coverage TEXT,
      personas_and_solutions TEXT, remarks TEXT, updated_at TEXT,
      company_profile TEXT, outreach_context TEXT, buying_signals TEXT,
      lead_score INTEGER, source_import_id TEXT
    );
    CREATE TABLE customer_imports (
      import_id TEXT, file_name TEXT, row_number INTEGER, raw_json TEXT,
      mapped_company_id TEXT, dedup_status TEXT, request_id TEXT
    );
  `);
  return {
    db,
    env: { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv,
  };
}

function importReq(csv: string | ReadableStream<Uint8Array>, fileName = "test.csv"): Request {
  const isStream = typeof csv !== "string";
  const body = isStream ? csv : JSON.stringify({ csv, file_name: fileName });
  // undici requires duplex:"half" for stream bodies (not in the lib DOM types).
  const init = isStream
    ? { method: "POST", headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body, duplex: "half" }
    : { method: "POST", headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body };
  return new Request(BASE + "/admin/api/customers/import", init as RequestInit);
}

async function importCsv(env: AdminEnv, csv: string): Promise<Response> {
  return handleAdminRequest(importReq(csv), env);
}

/* ── Parser units (fast, no D1) ────────────────────────────────────────── */

describe("stage 8: parseCsvBounded (spec §9.2 parser cases)", () => {
  it("parses a valid CSV with header", () => {
    const rows = parseCsvBounded("company_name,country,domain\nAcme,US,acme.com\n");
    expect(rows).toEqual([["company_name", "country", "domain"], ["Acme", "US", "acme.com"]]);
  });

  it("strips an Excel BOM so the first header cell still matches", () => {
    const rows = parseCsvBounded("﻿company_name\nAcme\n");
    expect(rows[0][0]).toBe("company_name");
  });

  it("supports quoted fields with embedded commas and escaped quotes", () => {
    const rows = parseCsvBounded('company_name,notes\n"Acme, Inc.","says ""hi"""\n');
    expect(rows[1]).toEqual(["Acme, Inc.", 'says "hi"']);
  });

  it("supports embedded newlines inside quoted fields", () => {
    const rows = parseCsvBounded('company_name,notes\n"Acme","line1\nline2"\n');
    expect(rows).toHaveLength(2);
    expect(rows[1][1]).toBe("line1\nline2");
  });

  it("rejects a field larger than MAX_FIELD_BYTES", () => {
    const big = "a".repeat(MAX_FIELD_BYTES + 1);
    expect(() => parseCsvBounded(`company_name\n${big}\n`)).toThrow(CsvLimitError);
  });

  it("accepts a field at exactly MAX_FIELD_BYTES", () => {
    const edge = "a".repeat(MAX_FIELD_BYTES);
    const rows = parseCsvBounded(`company_name\n${edge}\n`);
    expect(rows[1][0]).toHaveLength(MAX_FIELD_BYTES);
  });

  it("rejects more than MAX_CSV_ROWS data rows", () => {
    const rows = ["company_name"]
      .concat(Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `c${i}`))
      .join("\n");
    expect(() => parseCsvBounded(rows)).toThrow(/行数超过/);
  });

  it("accepts exactly MAX_CSV_ROWS data rows", () => {
    const rows = ["company_name"]
      .concat(Array.from({ length: MAX_CSV_ROWS }, (_, i) => `c${i}`))
      .join("\n");
    expect(parseCsvBounded(rows)).toHaveLength(MAX_CSV_ROWS + 1);
  });

  it("rejects a row with more than MAX_COLUMNS columns", () => {
    const wide = Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => `h${i}`).join(",");
    expect(() => parseCsvBounded(`${wide}\nv\n`)).toThrow(/列数超过/);
  });

  it("rejects malformed CSV (unterminated quote)", () => {
    expect(() => parseCsvBounded('company_name\n"Acme\n')).toThrow(/未闭合/);
  });
});

/* ── Formula injection (spec §9.3) ─────────────────────────────────────── */

describe("stage 8: CSV formula injection neutralization (§9.3)", () => {
  it("neutralizes export cells starting with = + - @, leaves the rest alone", () => {
    expect(sanitizeCsvFieldForExport("=HYPERLINK(\"http://evil\",\"x\")")).toBe("'=HYPERLINK(\"http://evil\",\"x\")");
    expect(sanitizeCsvFieldForExport("+SUM(A1:A9)")).toBe("'+SUM(A1:A9)");
    expect(sanitizeCsvFieldForExport("-1+1")).toBe("'-1+1");
    expect(sanitizeCsvFieldForExport("@cmd")).toBe("'@cmd");
    expect(sanitizeCsvFieldForExport("normal text")).toBe("normal text");
    expect(sanitizeCsvFieldForExport("")).toBe("");
    // No export endpoint exists today (§9.3 is conditional); this helper is
    // the mandated safeguard for any future export implementation.
  });

  it("stores formula-looking input as inert text through the import path", async () => {
    const { db, env } = await makeEnv();
    // CSV-quoted field: the formula's quotes are doubled per RFC4180.
    const res = await importCsv(env, 'company_name\n"=HYPERLINK(""http://evil"",""click"")"\n');
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT company_name, status FROM customers LIMIT 1").get() as { company_name: string; status: string };
    // Stored verbatim as data; it is only ever served back as JSON text and
    // the panel escapes it (stage 5) — nothing evaluates it.
    expect(row.company_name).toBe('=HYPERLINK("http://evil","click")');
  });
});

/* ── Endpoint integration ──────────────────────────────────────────────── */

describe("stage 8: POST /admin/api/customers/import limits", () => {
  it("imports a valid CSV end-to-end", async () => {
    const { db, env } = await makeEnv();
    const res = await importCsv(env, "company_name,country,domain\nAcme,US,acme.com\nBeta,DE,beta.de\n");
    expect(res.status).toBe(200);
    const body = await res.json() as { inserted: number; total_rows: number; import_id: string };
    expect(body.inserted).toBe(2);
    expect(body.total_rows).toBe(2);
    const names = (db.prepare("SELECT company_name FROM customers ORDER BY company_name").all() as { company_name: string }[]).map((r) => r.company_name);
    expect(names).toEqual(["Acme", "Beta"]);
  });

  it("recognizes the header through a BOM end-to-end", async () => {
    const { env } = await makeEnv();
    const res = await importCsv(env, "﻿company_name\nAcme\n");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { inserted: number }).inserted).toBe(1);
  });

  it("refuses a >5MB payload with 413 via the declared Content-Length", async () => {
    const { env } = await makeEnv();
    // 101 rows x 10 fields x 6000 chars ≈ 6MB — inside row/col/field caps,
    // so only the byte cap can refuse it.
    const wideRow = Array.from({ length: 10 }, () => "x".repeat(6000)).join(",");
    const csv = `company_name,${"extra,".repeat(8)}extra\n` + Array.from({ length: 101 }, () => wideRow).join("\n");
    expect(csv.length).toBeGreaterThan(MAX_CSV_BYTES);
    const res = await importCsv(env, csv);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { detail: string }).detail).toContain("字节上限");
  });

  it("refuses an oversized streamed body even without Content-Length", async () => {
    const { env } = await makeEnv();
    // Streamed body: no Content-Length header, so only the stream cap guards.
    const chunk = new TextEncoder().encode(`{"csv":"${"a".repeat(1024)}"}`).slice(0, 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // ~6MB total, comfortably over the cap; stream stays unread beyond it.
        for (let i = 0; i < 6 * 1024; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const res = await handleAdminRequest(importReq(stream), env);
    expect(res.status).toBe(413);
  });

  it("maps refusals to 400 for row/column/field violations", async () => {
    const { env } = await makeEnv();
    const tooManyRows = ["company_name"].concat(Array.from({ length: 2001 }, (_, i) => `c${i}`)).join("\n");
    const res = await importCsv(env, tooManyRows);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toContain("行数超过");

    const bigField = `company_name\n${"a".repeat(MAX_FIELD_BYTES + 1)}\n`;
    const res2 = await importCsv(env, bigField);
    expect(res2.status).toBe(400);
    expect(((await res2.json()) as { detail: string }).detail).toContain("字段");
  });

  it("rejects malformed CSV (unterminated quote) with 400", async () => {
    const { env } = await makeEnv();
    const res = await importCsv(env, 'company_name\n"Acme\n');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toContain("未闭合");
  });

  it("keeps prior behavior for empty csv and missing header", async () => {
    const { env } = await makeEnv();
    const empty = await importCsv(env, "");
    expect(empty.status).toBe(400);
    const noHeader = await importCsv(env, "wrong_column\nAcme\n");
    expect(noHeader.status).toBe(400);
    expect(((await noHeader.json()) as { detail: string }).detail).toContain("company_name");
  });
});

/* ── Body-reader unit (typed contract) ─────────────────────────────────── */

describe("stage 8: readCsvImportBody", () => {
  it("returns {csv, file_name} for a normal body", async () => {
    const req = new Request(BASE + "/x", {
      method: "POST",
      body: JSON.stringify({ csv: "a,b", file_name: "f.csv" }),
    });
    const parsed = await readCsvImportBody(req);
    expect(parsed.csv).toBe("a,b");
    expect(parsed.file_name).toBe("f.csv");
  });

  it("rejects a body whose csv is not a string", async () => {
    const req = new Request(BASE + "/x", { method: "POST", body: JSON.stringify({ csv: 42 }) });
    await expect(readCsvImportBody(req)).rejects.toThrow(CsvLimitError);
  });

  it("rejects an oversized declared body without parsing it", async () => {
    // undici computes a true Content-Length for string bodies, so a body well
    // above MAX_CSV_BYTES + envelope exercises the declared fast path.
    const req = new Request(BASE + "/x", {
      method: "POST",
      body: `{"csv":"${"a".repeat(MAX_CSV_BYTES + 200_000)}"}`,
    });
    await expect(readCsvImportBody(req)).rejects.toThrow(/字节上限/);
  });

  it("refuses csv text above the exact 5MB limit even when the envelope is tiny", async () => {
    // csv = 5MB + 1 char: body (≈5MB + 20B) stays under the read cap
    // (cap carries a 64KB envelope allowance), so only the csv-length check
    // refuses it.
    const req = new Request(BASE + "/x", {
      method: "POST",
      body: `{"csv":"${"a".repeat(MAX_CSV_BYTES + 1)}"}`,
    });
    await expect(readCsvImportBody(req)).rejects.toThrow(/超过.*字节上限/);
  });
});
