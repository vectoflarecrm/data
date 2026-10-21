import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AdminEnv } from "../src/admin";
import { handleAdminRequest } from "../src/admin";

/* Phase 8 Stage 51 (docs/phase8-persona-campaigns.md §2.6): the panel wiring
 * is verified at its HTTP surface —
 *   §2.1 persona_roles   → pre-filter endpoint carries it (pinned in
 *                          campaign-targeting.test.ts); here the campaign
 *                          create endpoint must accept it inside filters.
 *   §2.2 per_person      → create snapshots one contact per company and the
 *                          response reports companies vs total ("N 家公司 /
 *                          M 个联系人"); the members endpoint exposes the
 *                          contact columns + the filters JSON the panel
 *                          parses for its grain; segment-preview counts at
 *                          the contact grain.
 * Legacy payloads (no per_person / persona_roles) must keep working. */

const BASE = "https://worker.example";
const TOKEN = "persona-campaign-master-token";

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
    CREATE TABLE research_personas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL,
      persona_role TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 1
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
      auto_advance INTEGER NOT NULL DEFAULT 0,
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
    INSERT INTO customers VALUES
      (1,'comp_a','C1','completed','Alpha','Spain',NULL,'Distributor',90),
      (2,'comp_b','C2','completed','Beta','Spain',NULL,'Dealer',80),
      (3,'comp_c','C3','completed','Gamma','France','c@x.com','Dealer',70);
    INSERT INTO research_personas (customer_id, persona_role, is_current) VALUES
      ('comp_a','采购总监',1),
      ('comp_b','采购总监',1),
      ('comp_c','门店老板',0);
    INSERT INTO contacts VALUES
      (11,'p11','comp_a',2,'A','Two','Owner','a2@x.com'),
      (12,'p12','comp_a',1,'Ana','López','Buyer','ana@x.com'),
      (21,'p21','comp_b',1,'Bo','No','Owner',NULL);
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

describe("POST /admin/api/outreach/campaigns: per-person + persona_roles", () => {
  it("creates a per-person campaign and reports companies vs contacts", async () => {
    const db = makeDb();
    const env = makeEnv(db);

    const res = await call(env, "/admin/api/outreach/campaigns", {
      method: "POST",
      body: JSON.stringify({
        brand: "Afarer",
        name: "西班牙采购总监",
        filters: { per_person: true, has_email: false, persona_roles: "采购总监" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: number; total: number; capped: boolean; companies: number };
    expect(body.ok).toBe(true);
    // persona_roles narrows to comp_a + comp_b; only comp_a has an
    // email-bearing contact → 2 companies, 1 contact.
    expect(body.companies).toBe(2);
    expect(body.total).toBe(1);
    expect(body.capped).toBe(false);

    const members = db
      .prepare("SELECT customer_id, contact_id FROM outreach_campaign_members")
      .all() as Array<{ customer_id: number; contact_id: number | null }>;
    expect(members).toEqual([{ customer_id: 1, contact_id: 12 }]);

    // The grain and the roles travel with the campaign in its filters JSON.
    const campaign = db
      .prepare("SELECT filters FROM outreach_campaigns WHERE id = ?")
      .get(body.id) as { filters: string };
    const stored = JSON.parse(campaign.filters) as { per_person: boolean; persona_roles: string[]; has_email: boolean };
    expect(stored.per_person).toBe(true);
    expect(stored.persona_roles).toEqual(["采购总监"]);
    expect(stored.has_email).toBe(false);

    // The audit trail records the grain so a per-person blast is traceable.
    const audit = db
      .prepare("SELECT metadata_json FROM audit_logs WHERE action = 'CREATE_CAMPAIGN'")
      .get() as { metadata_json: string };
    const meta = JSON.parse(audit.metadata_json) as { per_person: boolean; members: number; companies: number };
    expect(meta.per_person).toBe(true);
    expect(meta.members).toBe(1);
    expect(meta.companies).toBe(2);
  });

  it("keeps the legacy company-grain create byte-compatible (contact_id NULL)", async () => {
    const db = makeDb();
    const env = makeEnv(db);

    const res = await call(env, "/admin/api/outreach/campaigns", {
      method: "POST",
      body: JSON.stringify({ brand: "Afarer", filters: {} }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number; companies: number };
    // Default has_email: only comp_c has a company mailbox.
    expect(body.total).toBe(1);
    expect(body.companies).toBe(body.total);
    const members = db
      .prepare("SELECT customer_id, contact_id FROM outreach_campaign_members")
      .all() as Array<{ customer_id: number; contact_id: number | null }>;
    expect(members).toEqual([{ customer_id: 3, contact_id: null }]);
    const campaign = db
      .prepare("SELECT filters FROM outreach_campaigns")
      .get() as { filters: string };
    const stored = JSON.parse(campaign.filters) as { per_person: boolean; persona_roles: string[] };
    expect(stored.per_person).toBe(false);
    expect(stored.persona_roles).toEqual([]);
  });
});

describe("GET /admin/api/outreach/campaigns/:id/members: contact columns", () => {
  it("exposes contact display fields plus the filters JSON for grain detection", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const created = (await (await call(env, "/admin/api/outreach/campaigns", {
      method: "POST",
      body: JSON.stringify({ brand: "Afarer", filters: { per_person: true, has_email: false } }),
    })).json()) as { id: number };

    const res = await call(env, `/admin/api/outreach/campaigns/${created.id}/members`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      campaign: { filters: string; total: number };
      items: Array<Record<string, unknown>>;
      total: number;
    };
    // The panel parses the filters JSON to decide whether to render the
    // contact column — it must be present.
    expect((JSON.parse(body.campaign.filters) as { per_person: boolean }).per_person).toBe(true);
    expect(body.total).toBe(1);
    const item = body.items[0];
    expect(item.customer_id).toBe(1);
    expect(item.contact_id).toBe(12);
    expect(item.contact_ref).toBe("p12");
    expect(item.contact_first_name).toBe("Ana");
    expect(item.contact_last_name).toBe("López");
    expect(item.contact_title).toBe("Buyer");
    expect(item.contact_email).toBe("ana@x.com");
  });
});

describe("POST /admin/api/outreach/segment-preview: per-person counts", () => {
  it("counts matching at the contact gate and already at the contact grain", async () => {
    const db = makeDb();
    const env = makeEnv(db);
    const post = () => call(env, "/admin/api/outreach/segment-preview", {
      method: "POST",
      body: JSON.stringify({ brand: "Afarer", filters: { per_person: true, has_email: false } }),
    });

    // Only comp_a has an email-bearing contact; nothing drafted yet.
    const first = (await (await post()).json()) as { matching: number; already: number; pending: number };
    expect(first.matching).toBe(1);
    expect(first.already).toBe(0);
    expect(first.pending).toBe(1);

    // A company-grain draft must not count as per-person coverage…
    db.prepare("INSERT INTO outreach_emails (customer_id, brand_name, status, contact_id) VALUES (1,'Afarer','draft',NULL)").run();
    const second = (await (await post()).json()) as { matching: number; already: number };
    expect(second.already).toBe(0);

    // …but the picked contact's draft does.
    db.prepare("INSERT INTO outreach_emails (customer_id, brand_name, status, contact_id) VALUES (1,'Afarer','draft',12)").run();
    const third = (await (await post()).json()) as { matching: number; already: number; pending: number };
    expect(third.matching).toBe(1);
    expect(third.already).toBe(1);
    expect(third.pending).toBe(0);
  });
});
