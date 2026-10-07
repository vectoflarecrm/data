import { describe, it, expect } from "vitest";
import {
  planContactPersist,
  normalizePhone,
  type ExistingContact,
} from "../src/contact-merge";
import { handleAdminRequest } from "../src/admin";
import type { AdminEnv } from "../src/admin";

/* Phase 7 Stage 47 (docs/phase7-contact-merge.md §2/§4): the pure
 * write-time dedup planner. Contract:
 *  - exact fingerprint skip unchanged (retry-safety),
 *  - same channel identity + compatible names → COALESCE fill-NULL merge,
 *  - conflicting names / name-only matches never merge automatically,
 *  - in-batch folding (merge into a row the same batch will insert),
 *  - statements are plain {sql, binds} so the real SQL runs on sqlite. */

function existing(overrides: Partial<ExistingContact> = {}): ExistingContact {
  return {
    contact_id: "ACME_001",
    first_name: "John",
    last_name: "Doe",
    title: null,
    department: null,
    email: "john@acme.com",
    cellphone: null,
    whatsapp: null,
    linkedin_url: null,
    ...overrides,
  };
}

function plan(
  incoming: Array<Parameters<typeof planContactPersist>[0]["incoming"][number]>,
  existingRows: ExistingContact[] = [existing()],
) {
  return planContactPersist({
    existing: existingRows,
    incoming,
    companyId: "acme",
    nextSeq: 2,
    contactIdPrefix: "ACME_",
  });
}

describe("normalizePhone", () => {
  it("matches the Stage 42 linkage semantics (case/trim + separators)", () => {
    expect(normalizePhone("+34 600-111 (222)")).toBe("+34600111222");
    expect(normalizePhone(" +34.600.111.222 ")).toBe("+34600111222");
    expect(normalizePhone(null)).toBe("");
  });
});

describe("planContactPersist: unchanged skip semantics", () => {
  it("still skips exact fingerprint duplicates (vs. DB and within batch)", () => {
    const p = plan([{ first_name: "John", last_name: "Doe", email: "john@acme.com" }]);
    expect(p.skipped).toBe(1);
    expect(p.statements).toEqual([]);

    const p2 = plan([
      { first_name: "Jane", last_name: "Roe", email: "jane@acme.com" },
      { first_name: "Jane", last_name: "Roe", email: "jane@acme.com" },
    ]);
    expect(p2.inserted).toBe(1);
    expect(p2.skipped).toBe(1);
  });

  it("still skips contacts with neither a name nor a channel", () => {
    const p = plan([{ title: "CEO" }]);
    expect(p.skipped).toBe(1);
    expect(p.statements).toEqual([]);
  });
});

describe("planContactPersist: the same-person rule", () => {
  it("merges a channel match with compatible names into a COALESCE UPDATE", () => {
    const p = plan([{ first_name: "John", last_name: "Doe", email: " John@ACME.com ", cellphone: "+34 600 111 222" }]);
    expect(p.merged).toBe(1);
    expect(p.inserted).toBe(0);
    expect(p.statements).toHaveLength(1);
    const stmt = p.statements[0]!;
    expect(stmt.sql).toMatch(/^UPDATE contacts SET first_name = COALESCE\(first_name, \?\)/);
    expect(stmt.sql).toContain("WHERE contact_id = ? AND company_id = ?");
    // The incoming channel values ride the binds; SQL COALESCE does the
    // fill-NULL-only decision.
    expect(stmt.binds).toEqual([
      "John", "Doe", null, null, " John@ACME.com ", "+34 600 111 222", null, null,
      "ACME_001", "acme",
    ]);
  });

  it("merges an unnamed incoming contact into the row owning the channel", () => {
    const p = plan([{ email: "john@acme.com" }]);
    expect(p.merged).toBe(1);
    expect(p.statements[0]!.binds[5]).toBeNull(); // no cellphone offered
  });

  it("merges by cellphone across separator styles", () => {
    const p = plan([{ first_name: "John", last_name: "Doe", cellphone: "+34-600-111-222" }],
      [existing({ email: null, cellphone: "+34 600 111 222" })]);
    expect(p.merged).toBe(1);
  });

  it("merges by whatsapp", () => {
    const p = plan([{ first_name: "John", last_name: "Doe", whatsapp: "+34 611 111 111" }],
      [existing({ email: null, whatsapp: "+34611111111" })]);
    expect(p.merged).toBe(1);
  });

  it("never merges a channel match with CONFLICTING names (shared mailbox)", () => {
    const p = plan([{ first_name: "Anna", last_name: "Smith", email: "john@acme.com" }]);
    expect(p.merged).toBe(0);
    expect(p.inserted).toBe(1); // a separate person — manual merge territory
  });

  it("never merges on name alone without a channel identity", () => {
    const p = plan([{ first_name: "John", last_name: "Doe", email: "newjohn@acme.com" }]);
    expect(p.merged).toBe(0);
    expect(p.inserted).toBe(1);
  });
});

describe("planContactPersist: in-memory view + in-batch folding", () => {
  it("lets a later contact match the row an earlier merge enriched", () => {
    // Contact 1 adds a cellphone to the existing row; contact 2 shares that
    // cellphone — it must merge too (the fold kept the view current).
    const p = plan([
      { first_name: "John", last_name: "Doe", email: "john@acme.com", cellphone: "+34 600 111 222" },
      { first_name: "John", last_name: "Doe", cellphone: "+34600111222", linkedin_url: "https://linkedin.com/in/johndoe" },
    ]);
    expect(p.merged).toBe(2);
    expect(p.inserted).toBe(0);
    expect(p.statements).toHaveLength(2);
  });

  it("folds a same-person second entry into the row this batch inserts", () => {
    // Two found_contacts entries for one NEW person: the email entry lands
    // as a provisional row, then a second entry repeating that email (same
    // person, adds a phone) merges into it. One INSERT (folded), no UPDATE
    // against a missing row. Complementary channels with NO shared value
    // (email-only + phone-only) are name-only matches — by design they stay
    // separate and merge by hand.
    const p = plan([
      { first_name: "Jane", last_name: "Roe", email: "jane@acme.com" },
      { first_name: "Jane", last_name: "Roe", email: "jane@acme.com", cellphone: "+34 600 999 888" },
    ], []);
    expect(p.inserted).toBe(1);
    expect(p.merged).toBe(1);
    expect(p.statements).toHaveLength(1);
    expect(p.statements[0]!.sql).toContain("INSERT OR IGNORE INTO contacts");
    const binds = p.statements[0]!.binds;
    expect(binds[0]).toBe("ACME_002");
    expect(binds[6]).toBe("jane@acme.com");      // email from the first entry
    expect(binds[7]).toBe("+34 600 999 888");    // cellphone folded into the INSERT
  });

  it("prefers the existing row when an existing and a provisional row both match", () => {
    // E (John Doe) and a conflicting-name provisional (Jane Roe) both carry
    // the shared mailbox; an unnamed carrier of that mailbox is compatible
    // with both — the earlier, EXISTING row wins (stable identity).
    const p = plan([
      { first_name: "Jane", last_name: "Roe", email: "shared@acme.com" },
      { email: "shared@acme.com", title: "Ops" },
    ], [existing({ email: "shared@acme.com" })]);
    expect(p.inserted).toBe(1);
    expect(p.merged).toBe(1);
    expect(p.statements).toHaveLength(2);
    const update = p.statements.find((s) => s.sql.startsWith("UPDATE"))!;
    expect(update.binds[8]).toBe("ACME_001"); // the existing row, not the provisional
  });

  it("numbers provisional rows after the company's MAX(seq)", () => {
    const p = plan([
      { first_name: "A", email: "a@acme.com" },
      { first_name: "B", email: "b@acme.com" },
      { first_name: "C", email: "c@acme.com" },
    ], []);
    const ids = p.statements.map((s) => s.binds[0]);
    expect(ids).toEqual(["ACME_002", "ACME_003", "ACME_004"]);
    const seqs = p.statements.map((s) => s.binds[2]);
    expect(seqs).toEqual([2, 3, 4]);
  });
});

/* The statements are concatenated straight into a D1 batch, so a shape slip
 * would only surface as a 500 mid-research. Run the real generated SQL on
 * node:sqlite — same harness idea as the campaign SQL tests. */
describe("planned statements run on sqlite", () => {
  async function makeDb() {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE contacts (
        id INTEGER PRIMARY KEY, contact_id TEXT NOT NULL, company_id TEXT NOT NULL,
        seq INTEGER NOT NULL, first_name TEXT, last_name TEXT, title TEXT, department TEXT,
        email TEXT, cellphone TEXT, tel TEXT, whatsapp TEXT, linkedin_url TEXT, social_accounts TEXT
      );
      CREATE UNIQUE INDEX idx_contacts_contact_id ON contacts(contact_id);
      CREATE UNIQUE INDEX idx_contacts_seq ON contacts(company_id, seq);
      INSERT INTO contacts (contact_id, company_id, seq, first_name, last_name, email)
        VALUES ('ACME_001', 'acme', 1, 'John', 'Doe', 'john@acme.com');
    `);
    return db;
  }

  it("COALESCE fills NULLs and never overwrites what the row already has", async () => {
    const db = await makeDb();
    const p = plan([{ first_name: "John", last_name: "Doe", email: "john@acme.com", cellphone: "+34 600 111 222", title: "Purchasing Manager" }]);
    for (const s of p.statements) db.prepare(s.sql).run(...(s.binds as never[]));

    const row = db.prepare("SELECT * FROM contacts").get() as Record<string, unknown>;
    expect(row.cellphone).toBe("+34 600 111 222"); // NULL filled
    expect(row.title).toBe("Purchasing Manager");  // NULL filled
    expect(row.email).toBe("john@acme.com");       // existing value kept

    // A second merge against the same row keeps the first merge's fill
    // (sequential batch statements see each other's writes).
    const p2 = plan([{ first_name: "John", last_name: "Doe", email: "john@acme.com", whatsapp: "+34 611 111 111" }],
      [existing({ title: "Purchasing Manager", cellphone: "+34 600 111 222" })]);
    for (const s of p2.statements) db.prepare(s.sql).run(...(s.binds as never[]));
    const row2 = db.prepare("SELECT * FROM contacts").get() as Record<string, unknown>;
    expect(row2.whatsapp).toBe("+34 611 111 111");
    expect(row2.title).toBe("Purchasing Manager");
    expect(db.prepare("SELECT COUNT(*) AS n FROM contacts").get()).toEqual({ n: 1 });
    db.close();
  });

  it("lands inserts with the planned seq/contact_id alongside merges", async () => {
    const db = await makeDb();
    const p = plan([
      { first_name: "John", last_name: "Doe", email: "john@acme.com", cellphone: "+34 600 111 222" },
      { first_name: "Anna", last_name: "Smith", email: "anna@acme.com" },
    ]);
    expect(p.merged).toBe(1);
    expect(p.inserted).toBe(1);
    for (const s of p.statements) db.prepare(s.sql).run(...(s.binds as never[]));
    const rows = db.prepare("SELECT contact_id, seq, cellphone FROM contacts ORDER BY seq").all() as Array<{ contact_id: string; seq: number; cellphone: string | null }>;
    expect(rows).toEqual([
      { contact_id: "ACME_001", seq: 1, cellphone: "+34 600 111 222" },
      { contact_id: "ACME_002", seq: 2, cellphone: null },
    ]);
    db.close();
  });
});

/* Stage 48 (design §4): the manual merge endpoint, end to end through
 * handleAdminRequest. One atomic batch: fill-NULL merge into the survivor,
 * repoint research_facts + evidence, delete the merged rows — plus the
 * audit trail. Cross-company ids are a 404, never a silent merge. */
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

describe("POST /admin/api/customers/:id/contacts/merge", () => {
  const BASE = "https://worker.example";
  const TOKEN = "correct-horse-battery-staple";

  async function makeDb() {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY, company_id TEXT, display_id TEXT, domain TEXT, status TEXT,
        company_name TEXT, legal_name TEXT, trading_name TEXT, normalized_domain TEXT,
        first_name TEXT, last_name TEXT, full_name TEXT, title TEXT, department TEXT, linkedin_url TEXT,
        street_address TEXT, zip_city TEXT, country TEXT, country_code TEXT, region TEXT, city TEXT, postal_code TEXT,
        tel TEXT, email TEXT, cellphone TEXT, whatsapp TEXT, products_services TEXT, business_tag TEXT,
        industry TEXT, company_type TEXT, business_model TEXT, founded_year TEXT, employee_range TEXT,
        description TEXT, target_markets TEXT, is_manufacturer TEXT, is_importer TEXT, is_distributor TEXT,
        is_wholesaler TEXT, is_retailer TEXT, is_ecommerce TEXT, is_rental TEXT, is_oem TEXT, social_accounts TEXT,
        full_research_text TEXT, social_accounts_verified TEXT, customer_segment TEXT,
        product_categories TEXT, company_size TEXT, geographic_coverage TEXT,
        personas_and_solutions TEXT, remarks TEXT, updated_at TEXT,
        company_profile TEXT, outreach_context TEXT, buying_signals TEXT, lead_score INTEGER,
        source_import_id TEXT
      );
      CREATE TABLE contacts (
        id INTEGER PRIMARY KEY, contact_id TEXT NOT NULL, company_id TEXT NOT NULL, seq INTEGER NOT NULL,
        first_name TEXT, last_name TEXT, full_name TEXT, title TEXT, department TEXT,
        email TEXT, cellphone TEXT, tel TEXT, whatsapp TEXT, linkedin_url TEXT, social_accounts TEXT
      );
      CREATE TABLE research_facts (id INTEGER PRIMARY KEY, customer_id TEXT, contact_id TEXT, is_current INTEGER);
      CREATE TABLE evidence (id INTEGER PRIMARY KEY, company_id TEXT, contact_id TEXT);
      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY, actor_user_id TEXT, actor_role TEXT, action TEXT, resource_type TEXT,
        resource_id TEXT, request_id TEXT, metadata_json TEXT, ip_hash TEXT, user_agent_hash TEXT, created_at TEXT
      );
      INSERT INTO customers (id, company_id, display_id, status, company_name, email)
        VALUES (1, 'c1', 'ACME', 'completed', 'Acme', 'info@acme.com');
      INSERT INTO contacts (contact_id, company_id, seq, first_name, last_name, title, email, cellphone, whatsapp, linkedin_url)
        VALUES ('ACME_001', 'c1', 1, 'John', 'Doe', 'CEO', 'john@acme.com', NULL, NULL, NULL),
               ('ACME_002', 'c1', 2, NULL, NULL, 'Sales', NULL, '+34 600 111 222', '+34 611 111 111', 'https://linkedin.com/in/johndoe');
      INSERT INTO research_facts (customer_id, contact_id, is_current) VALUES
        ('c1', 'ACME_002', 1),
        ('other_co', 'ACME_002', 1);
      INSERT INTO evidence (company_id, contact_id) VALUES
        ('c1', 'ACME_002'),
        ('other_co', 'ACME_002');
    `);
    return db;
  }

  function call(env: AdminEnv, path: string, body: unknown): Promise<Response> {
    return handleAdminRequest(
      new Request(`${BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
      }),
      env,
    ) as Promise<Response>;
  }

  it("merges fill-NULL, repoints both reference tables, deletes, audits", async () => {
    const db = await makeDb();
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;

    const res = await call(env, "/admin/api/customers/1/contacts/merge", {
      survivor_contact_id: "ACME_001",
      merged_contact_ids: ["ACME_002"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { survivor_contact_id: string; merged: number; filled_fields: string[] };
    expect(body.merged).toBe(1);
    expect(body.filled_fields).toEqual(["cellphone", "whatsapp", "linkedin_url"]);

    const survivor = db.prepare("SELECT * FROM contacts").get() as Record<string, unknown>;
    expect(survivor.contact_id).toBe("ACME_001");
    expect(survivor.title).toBe("CEO");          // non-null kept, 'Sales' never overwrote
    expect(survivor.email).toBe("john@acme.com");
    expect(survivor.cellphone).toBe("+34 600 111 222");   // NULL filled
    expect(survivor.whatsapp).toBe("+34 611 111 111");
    expect(survivor.linkedin_url).toBe("https://linkedin.com/in/johndoe");
    expect(db.prepare("SELECT COUNT(*) AS n FROM contacts").get()).toEqual({ n: 1 }); // merged row gone

    // Repointed within the company, never across companies.
    const facts = db.prepare("SELECT customer_id, contact_id FROM research_facts ORDER BY customer_id").all() as Array<{ customer_id: string; contact_id: string }>;
    expect(facts).toEqual([
      { customer_id: "c1", contact_id: "ACME_001" },
      { customer_id: "other_co", contact_id: "ACME_002" }, // untouched
    ]);
    const ev = db.prepare("SELECT company_id, contact_id FROM evidence ORDER BY company_id").all() as Array<{ company_id: string; contact_id: string }>;
    expect(ev).toEqual([
      { company_id: "c1", contact_id: "ACME_001" },
      { company_id: "other_co", contact_id: "ACME_002" },
    ]);

    const audit = db.prepare("SELECT action, resource_id, metadata_json FROM audit_logs").get() as { action: string; resource_id: string; metadata_json: string };
    expect(audit.action).toBe("CONTACT_MERGE");
    expect(audit.resource_id).toBe("1");
    const meta = JSON.parse(audit.metadata_json) as { survivor_contact_id: string; merged_contact_ids: string[]; filled_fields: string[] };
    expect(meta.survivor_contact_id).toBe("ACME_001");
    expect(meta.merged_contact_ids).toEqual(["ACME_002"]);

    db.close();
  });

  it("rejects a foreign contact id with 404 (cross-company guard)", async () => {
    const db = await makeDb();
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    const res = await call(env, "/admin/api/customers/1/contacts/merge", {
      survivor_contact_id: "ACME_001",
      merged_contact_ids: ["OTHER_CO_001"],
    });
    expect(res.status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM contacts").get()).toEqual({ n: 2 });
    db.close();
  });

  it("rejects survivor inside the merged list, empty lists and oversized lists", async () => {
    const db = await makeDb();
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    const post = (body: unknown) => call(env, "/admin/api/customers/1/contacts/merge", body);

    expect((await post({ survivor_contact_id: "ACME_001", merged_contact_ids: ["ACME_001", "ACME_002"] })).status).toBe(400);
    expect((await post({ survivor_contact_id: "ACME_001", merged_contact_ids: [] })).status).toBe(400);
    expect((await post({ survivor_contact_id: "", merged_contact_ids: ["ACME_002"] })).status).toBe(400);
    expect((await post({ survivor_contact_id: "ACME_001", merged_contact_ids: Array.from({ length: 11 }, (_, i) => `X_${i}`) })).status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM contacts").get()).toEqual({ n: 2 });
    db.close();
  });

  it("404s for an unknown customer", async () => {
    const db = await makeDb();
    const env = { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
    const res = await call(env, "/admin/api/customers/999/contacts/merge", {
      survivor_contact_id: "ACME_001",
      merged_contact_ids: ["ACME_002"],
    });
    expect(res.status).toBe(404);
    db.close();
  });
});
