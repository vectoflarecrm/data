import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";
import { parseSegmentFilters, serializeFilters, contactRankSql } from "../src/campaigns";

/* Phase 9 Stage 52 (docs/phase9-contact-multi-touch.md §2): role-priority
 * picking. The per-person contact pick ranks email-bearing contacts by the
 * FIRST operator keyword their contacts.title contains (operator's order =
 * priority), then seq, then id. One shared builder (contactRankSql) feeds
 * BOTH the preview pick and the create snapshot — the Stage 49/51 invariant
 * "preview counts exactly what the create adopts" forbids two rankings.
 * No keywords = byte-compatible Phase 8 (lowest seq). Company grain ignores
 * the field entirely (ignore-at-use). */

const BASE = "https://worker.example";
const TOKEN = "role-priority-master-token";

class FakeD1 {
  constructor(private db: any) {}

  prepare(sql: string) {
    const db = this.db;
    let bound: unknown[] = [];
    const stmt: any = {
      bind(...args: unknown[]) { bound = args; return stmt; },
      all: async () => ({ results: db.prepare(sql).all(...bound), success: true }),
      first: async () => db.prepare(sql).get(...bound) ?? undefined,
      run: async () => {
        const info = db.prepare(sql).run(...bound);
        return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
      },
    };
    return stmt;
  }

  async batch(stmts: any[]) {
    for (const s of await stmts) await s.run();
    return [];
  }
}

function makeDb(): any {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY, company_id TEXT, display_id TEXT, status TEXT,
      company_name TEXT, country TEXT, email TEXT, customer_segment TEXT, lead_score INTEGER
    );
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY, contact_id TEXT, company_id TEXT, seq INTEGER,
      first_name TEXT, last_name TEXT, title TEXT, email TEXT
    );
    CREATE TABLE outreach_settings (
      brand_name TEXT PRIMARY KEY, product_category TEXT, company_intro TEXT,
      enabled INTEGER, sender_email TEXT, sender_name TEXT, gmail_account TEXT
    );
    CREATE TABLE outreach_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, brand_name TEXT,
      status TEXT, contact_id INTEGER, email_to TEXT, subject TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE outreach_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, brand_name TEXT,
      group_id INTEGER, filters TEXT, total INTEGER, status TEXT,
      last_error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE outreach_campaign_members (
      campaign_id INTEGER, customer_id INTEGER, contact_id INTEGER, status TEXT,
      outreach_email_id INTEGER, error TEXT, PRIMARY KEY (campaign_id, customer_id)
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, actor_user_id TEXT, actor_role TEXT, action TEXT NOT NULL,
      resource_type TEXT NOT NULL, resource_id TEXT, request_id TEXT,
      metadata_json TEXT, ip_hash TEXT, user_agent_hash TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO outreach_settings (brand_name, product_category, company_intro, enabled)
      VALUES ('Afarer', 'SUPs', 'A real company intro.', 1);
    -- comp_a: two email-bearing contacts; the role match (采购总监) is the
    -- HIGHER seq, so only role-priority picking can surface it.
    INSERT INTO customers VALUES
      (1,'comp_a','C1','completed','Alpha','Spain',NULL,'Distributor',90),
      (2,'comp_e','C2','completed','Escape Co','Spain',NULL,'Dealer',70);
    INSERT INTO contacts VALUES
      (11,'p11','comp_a',2,'A','Two','采购总监','a2@x.com'),
      (12,'p12','comp_a',1,'Ana','López','销售经理','ana@x.com'),
      (21,'p21','comp_e',1,'E','One','aXb','e1@x.com'),
      (22,'p22','comp_e',2,'E','Two','a_b','e2@x.com');
  `);
  return db;
}

function makeEnv(db: any): AdminEnv {
  return { DB: new FakeD1(db), ADMIN_PANEL_TOKEN: TOKEN } as unknown as AdminEnv;
}

function call(env: AdminEnv, path: string, init: RequestInit = {}): Promise<Response> {
  return handleAdminRequest(new Request(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  }), env) as Promise<Response>;
}

describe("role_priority filter parsing (Phase 9 §2)", () => {
  it("accepts snake_case and camelCase, trims, dedups, and round-trips", () => {
    const f = parseSegmentFilters({ per_person: true, role_priority: " 采购总监 , 销售经理 ,采购总监," });
    expect(f.rolePriority).toEqual(["采购总监", "销售经理"]);
    const stored = JSON.parse(serializeFilters(f)) as { role_priority: string[]; per_person: boolean };
    expect(stored.role_priority).toEqual(["采购总监", "销售经理"]);
    expect(stored.per_person).toBe(true);
    // deserializeFilters path (stored campaign/group JSON) must keep parsing.
    expect(parseSegmentFilters(JSON.parse(serializeFilters(f))).rolePriority).toEqual(["采购总监", "销售经理"]);
    expect(parseSegmentFilters({ rolePriority: ["Owner"] }).rolePriority).toEqual(["Owner"]);
    // Absent key → empty (legacy payloads untouched).
    expect(parseSegmentFilters({}).rolePriority).toEqual([]);
  });

  it("caps the keyword list at 5", () => {
    expect(() => parseSegmentFilters({ role_priority: ["a", "b", "c", "d", "e", "f"] }))
      .toThrow("role_priority 最多 5 个");
  });

  it("keeps parsing a company-grain payload that carries role_priority (ignore-at-use)", () => {
    const f = parseSegmentFilters({ role_priority: ["采购总监"] });
    expect(f.perPerson).toBe(false);
    expect(f.rolePriority).toEqual(["采购总监"]);
    expect((JSON.parse(serializeFilters(f)) as { role_priority: string[] }).role_priority)
      .toEqual(["采购总监"]);
  });
});

describe("contactRankSql (the one shared ranking, Phase 9 §2)", () => {
  it("degenerates to empty for no keywords (Phase 8 golden order)", () => {
    expect(contactRankSql([])).toEqual({ sql: "", binds: [] });
  });

  it("escapes LIKE metacharacters so a keyword matches itself, nothing wider", () => {
    const r = contactRankSql(["a_b", "50%"]);
    expect(r.binds).toEqual(["%a\\_b%", "%50\\%%"]);
    expect(r.sql).toContain("ESCAPE '\\'");
    expect(r.sql).toContain("ELSE 2 END");
    // Branch order encodes the operator's priority.
    expect(r.sql.indexOf("THEN 0")).toBeLessThan(r.sql.indexOf("THEN 1"));
  });
});

describe("POST /admin/api/outreach/campaigns: role-priority snapshot pick", () => {
  it("picks the role-matched contact even at a higher seq", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const res = await call(env, "/admin/api/outreach/campaigns", {
      method: "POST",
      body: JSON.stringify({
        brand: "Afarer",
        filters: { per_person: true, has_email: false, role_priority: "采购总监" },
      }),
    });
    expect(res.status).toBe(200);
    const members = db
      .prepare("SELECT customer_id, contact_id FROM outreach_campaign_members ORDER BY customer_id")
      .all() as Array<{ customer_id: number; contact_id: number | null }>;
    // comp_a → 采购总监 is seq 2 (contact 11), not the default lowest-seq 12;
    // comp_e has no role match → ELSE rank, lowest seq (contact 21).
    expect(members).toEqual([
      { customer_id: 1, contact_id: 11 },
      { customer_id: 2, contact_id: 21 },
    ]);
    // The ranking travels with the campaign.
    const campaign = db.prepare("SELECT filters FROM outreach_campaigns").get() as { filters: string };
    expect((JSON.parse(campaign.filters) as { role_priority: string[] }).role_priority)
      .toEqual(["采购总监"]);
  });

  it("orders multiple keywords by the operator's list, not the alphabet", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const res = await call(env, "/admin/api/outreach/campaigns", {
      method: "POST",
      body: JSON.stringify({
        brand: "Afarer",
        filters: { per_person: true, has_email: false, role_priority: "销售经理,采购总监" },
      }),
    });
    expect(res.status).toBe(200);
    const members = db
      .prepare("SELECT customer_id, contact_id FROM outreach_campaign_members WHERE customer_id = 1")
      .all() as Array<{ contact_id: number }>;
    // 销售经理 (contact 12, rank 0) outranks 采购总监 (contact 11, rank 1).
    expect(members[0].contact_id).toBe(12);
  });

  it("treats a keyword's _ and % as literals (no LIKE wildcard widening)", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const res = await call(env, "/admin/api/outreach/campaigns", {
      method: "POST",
      body: JSON.stringify({
        brand: "Afarer",
        filters: { per_person: true, has_email: false, role_priority: "a_b" },
      }),
    });
    expect(res.status).toBe(200);
    const members = db
      .prepare("SELECT customer_id, contact_id FROM outreach_campaign_members WHERE customer_id = 2")
      .all() as Array<{ contact_id: number }>;
    // 'aXb' (seq 1) must NOT match keyword 'a_b'; the literal 'a_b' (seq 2) does.
    expect(members[0].contact_id).toBe(22);
  });

  it("without keywords keeps the Phase 8 pick (lowest seq)", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const res = await call(env, "/admin/api/outreach/campaigns", {
      method: "POST",
      body: JSON.stringify({ brand: "Afarer", filters: { per_person: true, has_email: false } }),
    });
    expect(res.status).toBe(200);
    const members = db
      .prepare("SELECT customer_id, contact_id FROM outreach_campaign_members ORDER BY customer_id")
      .all() as Array<{ contact_id: number }>;
    expect(members.map((m) => m.contact_id)).toEqual([12, 21]);
  });

  it("ignores role_priority for company-grain campaigns (ignore-at-use)", async () => {
    const db = makeDb();
    // Give comp_e a company mailbox so the company-grain create has a target.
    db.prepare("UPDATE customers SET email = 'co@escape.example' WHERE id = 2").run();
    const env = makeEnv(db);
    const res = await call(env, "/admin/api/outreach/campaigns", {
      method: "POST",
      body: JSON.stringify({ brand: "Afarer", filters: { role_priority: "采购总监" } }),
    });
    expect(res.status).toBe(200);
    const members = db
      .prepare("SELECT customer_id, contact_id FROM outreach_campaign_members")
      .all() as Array<{ customer_id: number; contact_id: number | null }>;
    // Company grain: contact_id NULL — the keyword never turns a company
    // campaign into a per-person one.
    expect(members).toEqual([{ customer_id: 2, contact_id: null }]);
  });
});

describe("POST /admin/api/outreach/segment-preview: rank-consistent counts", () => {
  it("counts already-coverage for the SAME contact the ranked snapshot would pick", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const post = (filters: Record<string, unknown>) =>
      call(env, "/admin/api/outreach/segment-preview", {
        method: "POST",
        body: JSON.stringify({ brand: "Afarer", filters }),
      });

    // Seed a draft for contact 11 (采购总监, seq 2) only.
    db.prepare("INSERT INTO outreach_emails (customer_id, brand_name, status, contact_id) VALUES (1,'Afarer','draft',11)").run();

    // With the rank, comp_a's pick is 11 → covered.
    const ranked = (await (await post({ per_person: true, has_email: false, role_priority: "采购总监" })).json()) as { matching: number; already: number; pending: number };
    expect(ranked.matching).toBe(2);
    expect(ranked.already).toBe(1);
    expect(ranked.pending).toBe(1);

    // Without the rank the pick is 12 (销售经理) → the draft on 11 must NOT
    // count as coverage. Same database, different pick — the preview and the
    // snapshot must agree on which contact is "the" pick.
    const unranked = (await (await post({ per_person: true, has_email: false })).json()) as { matching: number; already: number };
    expect(unranked.already).toBe(0);
  });
});
