import { describe, it, expect } from "vitest";
import {
  planContactPersist,
  normalizePhone,
  type ExistingContact,
} from "../src/contact-merge";

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
